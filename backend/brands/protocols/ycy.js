/**
 * 遥控蓝牙设备（YCY）设备通信协议实现
 *
 * 协议事实来源（2026-08-25 对齐）：
 *   1) 官方开源协议仓库 YCY-YOKONEX/YCY-YOKONEX-OpenSource（Bluetooth/ 目录，含电击器一代/二代、
 *      跳蛋飞机杯蓝牙通讯、灌肠机一代 等 PDF 协议文档）。
 *   2) 第三方工作实现 CiE-XinYuChen/PyDGLab-WS-for-YCY（pydglab_ws/ble/protocol.py 已实机验证），
 *      其 YCYBLEProtocol 完整实现了 0x35 族明文帧。
 *   3) 早期基于社区猜测的 YSKJ_*_BLE（0xAA/0x55 信封）经核实为不正确，已废弃。
 *   4) 泵（杯/灌肠机）AES 加密帧的密钥与模式来自对官方 APK 的逆向（见 buildPumpEncrypted）。
 *
 * 真实 BLE 帧结构（权威，来自 protocol.py）：
 *   数据包 = [0x35 包头][命令字 1B][数据…][校验和 1B]
 *   校验和 = 所有前面字节（含 0x35 与命令字）之和 mod 256。
 *
 *   命令字（第二字节）：
 *     0x11 = 通道控制（电刺激 A/B/AB；10 字节帧）
 *     0x12 = 马达 / 玩具电机速度（4 字节帧；速度 0x00–0x14 = 0–20）
 *     0x13 = 计步控制
 *     0x14 = 角度控制
 *     0x71 = 查询（电池 / 通道状态 / 马达状态 / 计步 / 角度 / 错误）
 *
 *   通道控制帧（cmd 0x11，共 10 字节）：
 *     35 11 [通道 1/2/3] [开关 0/1] [强度高 1B] [强度低 1B] [模式] [频率] [脉宽] [校验和]
 *     强度 1–276（0 表示关闭该通道）；模式 0x00=关, 0x01–0x10=预设 1–16, 0x11=自定义。
 *
 *   玩具电机帧（cmd 0x12，共 4 字节）：
 *     35 12 [速度 0–20] [校验和]
 *     （buttplug.io STI-HKAL “YiCiYuan” 条目亦记录此结构；玩具服务/写特征 UUID 为
 *      0000ff40-…-00805f9b34fb / 0000ff41-…-00805f9b34fb，与电击器的 98a9cd00-… 不同。）
 *
 *   泵（杯 / 灌肠机）帧：明文以 BF 0F A0 起头，整体经 AES-128 加密为 16 字节密文下发
 *   （密钥见 PUMP_CIPHER_KEY）。详见 buildPumpEncrypted。pump_v3 为明文 35 12 族（见 buildPumpV3）。
 *
 * 两条外部控制路径：
 *   1) API-bridge（无需蓝牙）：将指令翻译为 IM 的 game_cmd，以指令 ID 触发 App 内已配置玩法；
 *      全局停止指令为 _stop_all。杯/灌肠机在桥接模式下只能走 triggerInstruction（无法下发原始泵帧）。
 *   2) BLE 直连：按上述真实帧结构下发（电刺激 / 玩具电机 / 泵均已可构造）。
 */

const crypto = require('crypto');

const BRIDGE_DEFAULT_PORT = 3001;

// 遥控蓝牙设备 BLE 服务 UUID（电击器；来自官方 APK mixins/zk.js）。
// 注意：杯/玩具（YSKJ_TOY_BLE）服务 UUID 为 0000ff40-0000-1000-8000-00805f9b34fb，
// 由 YcyBleTransport 在连接时按设备类型通过 opts.serviceUuid 传入。
const BLE_SERVICE_UUID = '98a9cd00-ca0a-4cf8-9f85-e93949467558';

// 杯 / 玩具 BLE 服务 / 写特征 UUID。
// 注:不同 YCY 型号差异很大:
//   - buttplug.io YiCiYuan 条目记录为 0000ff40 / 0000ff41(部分老玩具);
//   - **真机实测 YYC-DJ-V2(2026-08-25, 原生 CoreBluetooth 对拍)暴露 FF30 服务 / FF31 写 / FF32 通知**,
//     另有 AE00 服务(AE01 写 / AE02 通知, 疑似第二通道/泵, 待进一步对拍)。
//   此处默认以实测值 FF30/FF31 为准;真实连接以设备端动态发现(桥/transport 自动枚举)为权威。
const BLE_SERVICE_UUID_TOY = '0000ff30-0000-1000-8000-00805f9b34fb';
const BLE_WRITE_UUID_TOY = '0000ff31-0000-1000-8000-00805f9b34fb';

// 设备广播名关键字（用于 noble 扫描过滤）。保留 YSKJ（固件前缀，集成测试依赖），
// 并补入真实广播名 Yoko* / YCY* / YYC*(YYC-DJ-V2 实测)。
const BLE_NAME_KEYWORDS = ['YSKJ', 'Yoko', 'YOKONEX', 'YCY', 'YYC', 'DJ-V2'];

// 帧族（命令字 / 第二字节），与 protocol.py 的 YCYCommand 对齐。
const FAMILY = {
  CHANNEL_CONTROL: 0x11, // 电刺激通道（A/B/AB）
  MOTOR_CONTROL: 0x12,   // 马达 / 玩具电机速度
  STEP_CONTROL: 0x13,    // 计步
  ANGLE_CONTROL: 0x14,   // 角度
  QUERY: 0x71,           // 查询
};

// 通道字节（与 protocol.py 的 YCYChannel 对齐）。
const CHANNEL_BYTE = { A: 0x01, B: 0x02, AB: 0x03 };

// 模式字节（与 protocol.py 的 YCYMode 对齐）。
const MODE = {
  OFF: 0x00,
  PRESET_1: 0x01,
  CUSTOM: 0x11,
};

// 泵（杯 / 灌肠机）AES-128 密钥。
// 来源：官方 APK 中 d.en(明文, "F638BC9CFA477480AB3242F6B04557A1")。
// 该密钥为 32 位十六进制串，按 CryptoJS.enc.Hex.parse 解析得 16 字节 = AES-128 密钥长度。
// 明文零填充至刚好 16 字节、密文输出刚好 16 字节、无 IV、单块确定性
// → AES-128-ECB + NoPadding（与 CBC 零 IV 单块结果等价，故无 IV 亦可）。
const PUMP_CIPHER_KEY = 'F638BC9CFA477480AB3242F6B04557A1';

// 泵明文头（APK 逆向：BF 0F A0 起头，随后按版本/动作拼装，整帧 AES-128 加密）。
const PUMP_PLAIN_HEADER = 'BF0FA0';

// ---- 数值范围常量 ----
const EMS_STRENGTH_MAX = 276;
const EMS_STRENGTH_MIN = 1;
const EMS_CHANNEL_MAX = 276;
const EMS_FREQ_MAX = 100;
const MOTOR_SPEED_MAX = 20;
const FJB03_STROKE_MAX = 40;
const FJB03_AXIS_MAX = 20;
const PUMP_RATE_DEFAULT = 3;

/** 强度映射：UI 量纲 0–100 → 设备量纲 1–276（0 表示关闭通道）。 */
function mapStrengthToYcy(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(EMS_STRENGTH_MIN, Math.min(EMS_STRENGTH_MAX, Math.round((n / 100) * (EMS_STRENGTH_MAX - 1)) + 1));
}

function clamp(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function hex2(n) {
  return (clamp(n, 0, 0xff) & 0xff).toString(16).padStart(2, '0').toUpperCase();
}
function hex4(n) {
  return (clamp(n, 0, 0xffff) & 0xffff).toString(16).padStart(4, '0').toUpperCase();
}

/** 校验和 = 所有字节之和 mod 256（含 0x35 包头与命令字）。与 protocol.py 一致。 */
function checksum(bytes) {
  let s = 0;
  for (const b of bytes) s = (s + (b & 0xff)) & 0xff;
  return s & 0xff;
}

/** 给字节数组追加 1 字节校验和，返回新 Buffer。 */
function withChecksum(buf) {
  const cs = checksum(buf);
  const out = Buffer.from(buf);
  return Buffer.concat([out, Buffer.from([cs])]);
}

// ============ BLE 帧构造（真实 0x35 族，权威自 protocol.py）============

/** 电刺激连接握手：35 14 01（APK ele 握手；protocol.py 中 0x14 亦为角度控制，握手指令以 APK 为准）。 */
function buildEmsHandshake() {
  return Buffer.from('351401', 'hex');
}

/**
 * 电刺激通道强度帧（权威 10 字节）：
 *   35 11 [通道 1/2/3] [开关 0/1] [强度高 1B] [强度低 1B] [模式] [频率] [脉宽] [校验和]
 * channel: 'A' | 'B' | 'AB'（默认 A）。
 * value: UI 量纲 0–100（内部映射为设备量纲 1–276；0 视为关闭该通道）。
 * freq / pulse: 仅自定义模式（mode=CUSTOM）有效；否则固定 0。
 */
function parseWaveMode(wave) {
  if (wave == null || wave === '') return null;
  const n = Number(wave);
  if (Number.isInteger(n) && n >= 1 && n <= 16) return n;
  return null;
}

function buildEmsStrength({
  channel = 'A', value = 0, freq = 0, pulse = 0, wave,
} = {}) {
  const ch = CHANNEL_BYTE[String(channel || 'A').toUpperCase()] ?? CHANNEL_BYTE.A;
  const strength = mapStrengthToYcy(value);
  const enabled = strength > 0 ? 1 : 0;
  const preset = parseWaveMode(wave);
  const custom = preset == null && (freq > 0 || pulse > 0);
  const mode = custom ? MODE.CUSTOM : (preset || MODE.PRESET_1);
  const f = custom ? clamp(freq, 0, EMS_FREQ_MAX) : 0;
  const p = custom ? clamp(pulse, 0, EMS_FREQ_MAX) : 0;
  const s = clamp(strength, 0, EMS_CHANNEL_MAX);
  const data = Buffer.from([
    0x35,
    FAMILY.CHANNEL_CONTROL,
    ch,
    enabled,
    (s >> 8) & 0xff,
    s & 0xff,
    mode,
    f,
    p,
  ]);
  return withChecksum(data);
}

/** 电刺激停止：关闭 AB 双通道（35 11 03 00 00 00 [模式] 00 00 [校验和]）。 */
function buildEmsStop() {
  const data = Buffer.from([
    0x35,
    FAMILY.CHANNEL_CONTROL,
    CHANNEL_BYTE.AB,
    0x00, // 关闭
    0x00, 0x00, // 强度 0
    MODE.PRESET_1,
    0x00, 0x00,
  ]);
  return withChecksum(data);
}

/**
 * 吸力 / 训练器实时强度帧（xl）。
 * 注：该帧为早期 APK 逆向所得，未在官方公开协议（protocol.py / 官方 PDF）中核实，
 * 正确性待真机对拍；若设备无响应，应以通道控制帧（buildEmsStrength）的对应通道替代。
 * 结构（APK 提取，带校验和）：35 11 02 | e(2B) | t(1B) | a(1B) | CS
 */
function buildXlIntensity({ strength = 0, freq = 50, pulse = 50 } = {}) {
  const e = hex4(clamp(Math.round((276 * Number(strength)) / 180), 0, EMS_STRENGTH_MAX));
  const t = hex2(clamp(freq, 0, EMS_FREQ_MAX));
  const a = hex2(clamp(pulse, 0, EMS_FREQ_MAX));
  return Buffer.from(withChecksumString(`351102${e}${t}${a}`), 'hex');
}

/** 与 withChecksum 等价的十六进制字符串版本（用于 buildXlIntensity 历史结构）。 */
function withChecksumString(hexStr) {
  let s = 0;
  for (let i = 0; i + 2 <= hexStr.length; i += 2) {
    s = (s + parseInt(hexStr.substr(i, 2), 16)) & 0xff;
  }
  return hexStr + (s & 0xff).toString(16).padStart(2, '0').toUpperCase();
}

/**
 * 玩具 / 电机速度帧（权威 4 字节）：35 12 [速度 0–20] [校验和]。
 * speed: 0–20（UI 量纲 0–100 由调用方映射后传入，或直接传 0–20）。
 */
function buildMotor({ speed = 0 } = {}) {
  const s = clamp(speed, 0, MOTOR_SPEED_MAX);
  return withChecksum(Buffer.from([0x35, FAMILY.MOTOR_CONTROL, s]));
}

/**
 * YCY-FJB-03 真机帧（6 字节）：35 12 [旋转 0–40] [震动 0–20] [第三轴 0–20] [校验和]。
 * 旋转 1–20 正转、21–40 反转。不是 4 字节玩具电机帧，也不是 AES 泵帧。
 */
function buildFjb03({ stroke = 0, vibe = 0, axis = 0 } = {}) {
  return withChecksum(Buffer.from([
    0x35,
    FAMILY.MOTOR_CONTROL,
    clamp(stroke, 0, FJB03_STROKE_MAX),
    clamp(vibe, 0, FJB03_AXIS_MAX),
    clamp(axis, 0, FJB03_AXIS_MAX),
  ]));
}

/**
 * pump_v3（杯 / 灌肠机，明文 + 校验和可下发）：
 *   stop : 35 12 00 00 00 | CS
 *   cut  : 35 12 FF 00 00 | CS
 *   add  : 35 12 00 [air:1B] 00 | CS        （air 默认 1）
 *   guan : 35 12 00 00 [water:1B] | CS      （water 默认 1）
 * 注：pump_v3 为明文 35 12 族，与电机帧同构，仅数据字节语义不同。
 */
function buildPumpV3({ scene = 'stop', air = 1, water = 1 } = {}) {
  let body;
  switch (scene) {
    case 'cut': body = [FAMILY.MOTOR_CONTROL, 0xff, 0x00, 0x00]; break;
    case 'add': body = [FAMILY.MOTOR_CONTROL, 0x00, clamp(air, 0, 0xff), 0x00]; break;
    case 'guan': body = [FAMILY.MOTOR_CONTROL, 0x00, 0x00, clamp(water, 0, 0xff)]; break;
    case 'stop':
    default: body = [FAMILY.MOTOR_CONTROL, 0x00, 0x00, 0x00]; break;
  }
  return withChecksum(Buffer.from([0x35, ...body]));
}

/**
 * pump_v1 / pump_v2（杯 / 灌肠机，AES-128 加密帧）。
 *
 * 明文以 BF 0F A0 起头，随后按版本 / 动作拼装；整帧经 AES-128（密钥见 PUMP_CIPHER_KEY）
 * 加密为 16 字节密文下发。APK 证据：明文零填充至刚好 16 字节、密文输出刚好 16 字节、无 IV、
 * 单块确定性 → AES-128-ECB + NoPadding（与 CBC 零 IV 单块等价）。
 *
 * 明文拼装（APK 逆向，待真机对拍确认命令字节语义）：
 *   v1: add = BF0FA00101[ss 2B], cut = BF0FA00102[ss 2B], guan = BF0FA00201[ss 2B], stop = BF0FA003
 *   v2: add = BF0FA001[rate 1B][ss 2B], cut = BF0FA001FF[ss 2B], guan = BF0FA00201[ss 2B], stop = BF0FA003
 *
 * 返回 16 字节密文 Buffer（即 BLE 直发帧，无额外 0x35 包头）。
 */
function buildPumpEncrypted({ protocol = 'v1', scene = 'stop', rate = PUMP_RATE_DEFAULT, ss = 0 } = {}) {
  const ssHex = hex4(clamp(ss, 0, 0xffff));
  const rateHex = hex2(clamp(rate, 1, 0xff));
  let plain;
  if (protocol === 'v2') {
    switch (scene) {
      case 'add': plain = `${PUMP_PLAIN_HEADER}01${rateHex}${ssHex}`; break;
      case 'cut': plain = `${PUMP_PLAIN_HEADER}01FF${ssHex}`; break;
      case 'guan': plain = `${PUMP_PLAIN_HEADER}02${'01'}${ssHex}`; break;
      case 'stop':
      default: plain = `${PUMP_PLAIN_HEADER}03`; break;
    }
  } else {
    // v1（APK 默认协议）
    switch (scene) {
      case 'add': plain = `${PUMP_PLAIN_HEADER}01${'01'}${ssHex}`; break;
      case 'cut': plain = `${PUMP_PLAIN_HEADER}01${'02'}${ssHex}`; break;
      case 'guan': plain = `${PUMP_PLAIN_HEADER}02${'01'}${ssHex}`; break;
      case 'stop':
      default: plain = `${PUMP_PLAIN_HEADER}03`; break;
    }
  }

  // 明文零填充至 16 字节（AES 单块）。
  const plainBuf = Buffer.from(plain, 'hex');
  const padded = Buffer.alloc(16);
  plainBuf.copy(padded, 0, 0, Math.min(plainBuf.length, 16));

  // AES-128-ECB + NoPadding。ECB 不使用 IV（传 null）；单块结果与 CBC 零 IV 等价。
  const key = Buffer.from(PUMP_CIPHER_KEY, 'hex');
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  const ct = Buffer.concat([cipher.update(padded), cipher.final()]);
  if (ct.length !== 16) {
    throw new Error(`pump 加密结果长度异常: ${ct.length} 字节（预期 16）`);
  }
  return ct;
}

/** 将遥控蓝牙设备品牌命令翻译为 BLE 帧（Buffer）。BLE 直连模式使用。 */
function toBleFrame(brandCommand) {
  const cmd = brandCommand?.cmd;
  switch (cmd) {
    case 'eleHandshake':
      return buildEmsHandshake();
    case 'setStrength':
      return buildEmsStrength({
        channel: brandCommand.channel,
        value: brandCommand.value,
        freq: brandCommand.freq,
        pulse: brandCommand.pulse,
        wave: brandCommand.wave,
      });
    case 'setWave':
      return buildEmsStrength({
        channel: brandCommand.channel,
        value: brandCommand.value ?? brandCommand.strength,
        wave: brandCommand.wave ?? brandCommand.value,
      });
    case 'setMode':
      // setMode 只改变波形，必须带上当前强度，不能生成关闭通道的 0 强度帧。
      return buildEmsStrength({
        channel: brandCommand.channel,
        value: brandCommand.value ?? brandCommand.strength,
        wave: brandCommand.mode,
      });
    case 'stopAll':
    case 'stop':
      return buildEmsStop();
    case 'setSpeed':
      return buildMotor({ speed: brandCommand.speed });
    case 'setToyMode':
      return buildMotor({ speed: brandCommand.mode });
    case 'stopToy':
      return buildMotor({ speed: 0 });
    case 'setFjb':
      return buildFjb03(brandCommand);
    case 'stopFjb':
      return buildFjb03({ stroke: 0, vibe: 0, axis: 0 });
    case 'pump':
      if (brandCommand.protocol === 'v3') return buildPumpV3(brandCommand);
      return buildPumpEncrypted(brandCommand); // v1/v2 AES 加密
    default:
      throw new Error(`未知的遥控蓝牙设备 BLE 指令: ${cmd}`);
  }
}

// ============ API-bridge（WebSocket / HTTP → IM game_cmd）============

/** 解析“连接码”（格式：UID 空格 Token），返回 { uid, token } */
function parseConnectCode(connectCode) {
  if (!connectCode || typeof connectCode !== 'string') {
    throw new Error('连接码不能为空');
  }
  const trimmed = connectCode.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return { uid: parts[0], token: parts.slice(1).join(' ') };
  }
  // 单段：当作 token（uid 由桥接服务/App 提供）
  return { uid: '', token: trimmed };
}

/** 构造桥接服务登录消息 */
function buildBridgeLogin({ uid, token }) {
  if (token == null || token === '') throw new Error('登录缺少 token');
  return { type: 'login', uid: uid || '', token };
}

/** 构造桥接服务发送指令消息（对应 IM game_cmd） */
function buildBridgeSendCommand({ commandId, token }) {
  if (!commandId || typeof commandId !== 'string') {
    throw new Error('commandId 必填');
  }
  return { type: 'sendCommand', commandId, token: token || undefined };
}

/** 全局停止指令 ID（IM 协议中的 _stop_all） */
const GLOBAL_STOP_COMMAND = '_stop_all';

/** 将遥控蓝牙设备品牌命令翻译为桥接服务 WS 消息 */
function toBridgeMessage(brandCommand, { token } = {}) {
  const cmd = brandCommand?.cmd;
  switch (cmd) {
    case 'stopAll':
    case 'stop':
      return buildBridgeSendCommand({ commandId: GLOBAL_STOP_COMMAND, token });
    case 'triggerInstruction':
      return buildBridgeSendCommand({ commandId: brandCommand.commandId, token });
    case 'pump':
      // 桥接模式无法下发原始泵帧；提示改用 BLE 直连。
      throw new Error('杯/灌肠机的泵控制需使用 BLE 直连模式（mode=ble），桥接模式仅支持 triggerInstruction');
    default:
      // 原始强度/通道/模式在 IM 指令模型下不可直接下发，需改用指令触发。
      {
        const error = new Error(`桥接模式不支持原始指令 ${cmd}，请使用 triggerInstruction`);
        error.code = 'YCY_BRIDGE_RAW_COMMAND_UNSUPPORTED';
        throw error;
      }
  }
}

/**
 * 遥控蓝牙设备 API-bridge WebSocket 客户端。复用 Node 22 全局 WebSocket，测试可注入 mock。
 */
class YcyBridgeClient {
  constructor({ host = '127.0.0.1', port = BRIDGE_DEFAULT_PORT, WebSocketClass = null, path = '' } = {}) {
    this.host = host;
    this.port = Number(port) || BRIDGE_DEFAULT_PORT;
    this.path = path || '';
    this.url = `ws://${this.host}:${this.port}${this.path}`;
    this.WebSocketClass = WebSocketClass || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!this.WebSocketClass) throw new Error('当前环境缺少 WebSocket 实现');
    this.ws = null;
    this.connected = false;
    this.ready = false;
    this._onClose = null;
    this._onError = null;
    this._onMessage = null;
    this._onReady = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new this.WebSocketClass(this.url);
      this.ws = ws;
      ws.onopen = () => { this.connected = true; if (!settled) { settled = true; resolve(this); } };
      ws.onmessage = (event) => {
        let data = event.data;
        if (typeof data !== 'string') data = String(data);
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'ready' || msg.isReady) { this.ready = true; this._onReady && this._onReady(msg); }
        } catch (_) {}
        this._onMessage && this._onMessage(data);
      };
      ws.onerror = (err) => { this._onError && this._onError(err); if (!settled) { settled = true; reject(err); } };
      ws.onclose = () => { this.connected = false; this.ready = false; this._onClose && this._onClose(); };
    });
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('遥控蓝牙设备桥接未连接');
    this.ws.send(JSON.stringify(obj));
    return obj;
  }

  login(auth) {
    return this.send(buildBridgeLogin(auth));
  }

  trigger(commandId, token) {
    return this.send(buildBridgeSendCommand({ commandId, token }));
  }

  stopAll(token) {
    return this.send(buildBridgeSendCommand({ commandId: GLOBAL_STOP_COMMAND, token }));
  }

  on(event, handler) {
    if (event === 'close') this._onClose = handler;
    else if (event === 'error') this._onError = handler;
    else if (event === 'message') this._onMessage = handler;
    else if (event === 'ready') this._onReady = handler;
    return this;
  }

  disconnect() {
    if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
    this.connected = false;
    this.ready = false;
  }
}

/**
 * ⚠️ 实验性 / 当前 UI 未启用
 * 遥控蓝牙设备 BLE 直连传输层（基于 Node `noble`）。
 *
 * 状态（2026-08-26 核对）：
 *   - 运行依赖 `noble`，但本仓库 package.json 未声明、node_modules 也未安装；
 *     触发 mode=ble 会直接抛“未安装 noble”。即当前无法实际运行。
 *   - 帧构造（buildEmsStrength / buildMotor / buildPumpV3 等）已按开源 protocol.py
 *     的 0x35 族实现，但本传输层（scan/connect/write/disconnect）仅为骨架，
 *     未经真机充分联调；各型号 GATT 服务/特征 UUID 仍靠设备端动态发现，未全钉死。
 *   - 与现有 Electron Web Bluetooth 架构（electron/ble/brandDeviceClient.js +
 *     frontend/src/web-ble/brandBle.ts）尚未对齐，属独立旁路实现。
 *
 * 实际在用的 YCY 直连是 Swift `ycy_bridge`（端口 3001，已编译进仓库），
 * 前端 BrandsPanel 走的是桥接模式，并不调用本模块。本模块仅作为备选/参考保留，暂不启用。
 *
 * 暴露 scan / connect / write / disconnect，供 YCYConnection 在 ble 模式调用。
 * 注意：serviceId / writeCharacteristicId / notifyCharacteristicId 由设备端动态发现（见 APK
 * findServiceWithWriteAndNotifyUsingTimer），本传输层在 connect 时通过 opts 传入已发现的服务/特征值。
 */
class YcyBleTransport {
  constructor() {
    this.noble = null;
    this.peripheral = null;
    this.characteristic = null;
    this.serviceUuid = BLE_SERVICE_UUID; // 已知服务 UUID（设备端动态发现具体特征值）
    this.writeUuid = null;
  }

  _ensureNoble() {
    if (this.noble) return this.noble;
    try {
      // noble 为可选依赖，未安装时抛出明确错误
      // eslint-disable-next-line global-require
      this.noble = require('noble');
    } catch (_) {
      throw new Error('未安装 noble，无法进行 BLE 直连（请 npm i noble 或使用 API-bridge 模式）');
    }
    return this.noble;
  }

  /** 扫描并返回匹配名称关键字的设备列表（按 BLE_NAME_KEYWORDS 过滤广播名）。 */
  async scan(timeoutMs = 5000) {
    const noble = this._ensureNoble();
    return new Promise((resolve, reject) => {
      const found = [];
      const seen = new Set();
      const onDiscover = (peripheral) => {
        const name = peripheral.advertisement?.localName || '';
        if (!BLE_NAME_KEYWORDS.some((k) => name.toUpperCase().includes(k))) return;
        if (seen.has(peripheral.id)) return;
        seen.add(peripheral.id);
        found.push({ id: peripheral.id, name, address: peripheral.address || peripheral.id, rssi: peripheral.rssi });
      };
      noble.on('discover', onDiscover);
      noble.startScanning([], false, (err) => {
        if (err) { noble.removeListener('discover', onDiscover); return reject(err); }
        setTimeout(() => {
          noble.stopScanning();
          noble.removeListener('discover', onDiscover);
          resolve(found);
        }, timeoutMs);
      });
    });
  }

  async connect(deviceId, { serviceUuid, writeUuid } = {}) {
    const noble = this._ensureNoble();
    this.serviceUuid = serviceUuid || this.serviceUuid;
    this.writeUuid = writeUuid;
    const peripheral = await new Promise((resolve, reject) => {
      noble.startScanning([], false, (err) => {
        if (err) return reject(err);
        const onDiscover = (p) => {
          if (p.id === deviceId || p.address === deviceId) {
            noble.removeListener('discover', onDiscover);
            noble.stopScanning();
            resolve(p);
          }
        };
        noble.on('discover', onDiscover);
      });
    });
    this.peripheral = peripheral;
    await new Promise((resolve, reject) => peripheral.connect((e) => (e ? reject(e) : resolve())));
    const { characteristics } = await new Promise((resolve, reject) =>
      peripheral.discoverSomeServicesAndCharacteristics([this.serviceUuid].filter(Boolean), [], (e, s, c) =>
        e ? reject(e) : resolve({ services: s, characteristics: c })));
    this.characteristic = characteristics[0];
    return { id: peripheral.id, name: peripheral.advertisement?.localName };
  }

  write(frame) {
    if (!this.characteristic) throw new Error('遥控蓝牙设备 BLE 未连接');
    return new Promise((resolve, reject) =>
      this.characteristic.write(frame, false, (e) => (e ? reject(e) : resolve())));
  }

  disconnect() {
    if (this.peripheral) { try { this.peripheral.disconnect(); } catch (_) {} this.peripheral = null; }
    this.characteristic = null;
  }
}

module.exports = {
  BRIDGE_DEFAULT_PORT,
  BLE_SERVICE_UUID,
  BLE_SERVICE_UUID_TOY,
  BLE_WRITE_UUID_TOY,
  BLE_NAME_KEYWORDS,
  FAMILY,
  CHANNEL_BYTE,
  MODE,
  PUMP_CIPHER_KEY,
  PUMP_PLAIN_HEADER,
  EMS_STRENGTH_MAX,
  EMS_FREQ_MAX,
  MOTOR_SPEED_MAX,
  FJB03_STROKE_MAX,
  FJB03_AXIS_MAX,
  GLOBAL_STOP_COMMAND,
  mapStrengthToYcy,
  checksum,
  buildEmsHandshake,
  buildEmsStrength,
  buildEmsStop,
  buildXlIntensity,
  buildMotor,
  buildFjb03,
  buildPumpV3,
  buildPumpEncrypted,
  toBleFrame,
  parseConnectCode,
  buildBridgeLogin,
  buildBridgeSendCommand,
  toBridgeMessage,
  YcyBridgeClient,
  YcyBleTransport,
};
