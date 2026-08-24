/**
 * 役次元（YCY / YOKONEX）设备通信协议实现
 *
 * 协议来源（公开 GitHub 仓库）：
 *   - YCY-YOKONEX/YCY-YOKONEX-OpenSource  （蓝牙 / IM / WebSocket / HTTP 协议总览）
 *     https://github.com/YCY-YOKONEX/YCY-YOKONEX-OpenSource
 *   - YCY-YOKONEX/API-bridge              （IM 协议转 WebSocket & HTTP 的桥接服务）
 *     https://github.com/YCY-YOKONEX/API-bridge
 *   - YCY-YOKONEX/PyDGLab-WS-for-YCY      （直连 BLE 的 Python 设备库，定义 YSKJ_*_BLE）
 *
 * 役次元提供两条外部控制路径：
 *   1) API-bridge（推荐、无需蓝牙）：将 WebSocket/HTTP 指令翻译为腾讯 IM 的 game_cmd，
 *      以“指令 ID（instructionId）”触发 App 内已配置的玩法。全局停止指令为 `_stop_all`。
 *   2) BLE 直连：通过 YSKJ_EMS_BLE（电击器 2.0，通道 A/B，强度 0–276，波形 1–17）与
 *      YSKJ_TOY_BLE（玩具/电机 A/B/C，速度 0–20，模式 1–4）协议帧直接下发。
 *
 * 本文件同时实现两条路径的帧构造；数值范围与通道语义严格遵循上述开放协议文档。
 */

const BRIDGE_DEFAULT_PORT = 3001;

// 役次元设备常见广播名关键字（BLE 发现阶段用于过滤）
const BLE_NAME_KEYWORDS = ['YCY', 'YOKONEX', 'YSKJ', '役次元'];

// ---- 通道 / 范围常量（依据 YCY-VRCOSC 与开放协议文档）----
const EMS_CHANNELS = { A: 0x01, B: 0x02 };
const TOY_MOTORS = { A: 0x01, B: 0x02, C: 0x03 };
const EMS_STRENGTH_MAX = 276;
const EMS_WAVE_MIN = 1;
const EMS_WAVE_MAX = 17;
const TOY_SPEED_MAX = 20;
const TOY_MODE_MIN = 1;
const TOY_MODE_MAX = 4;

// ---- 帧结构常量（YSKJ_*_BLE 通用信封；opcode 需以对应固件/开放蓝牙仓库为准）----
const FRAME_START = 0xaa;
const FRAME_END = 0x55;
const CMD = {
  EMS_SET_STRENGTH: 0x01,
  EMS_SET_WAVE: 0x02,
  EMS_STOP: 0x03,
  TOY_SET_SPEED: 0x11,
  TOY_SET_MODE: 0x12,
  TOY_STOP: 0x13,
};

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function channelByte(channel, table) {
  if (typeof channel === 'number') return channel;
  const key = String(channel || '').toUpperCase();
  if (table[key] === undefined) throw new Error(`未知通道: ${channel}`);
  return table[key];
}

function checksum(bytes) {
  // 信封内 payload 求和取低 8 位
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  return sum;
}

function wrap(cmd, channel, valueLow, valueHigh = 0x00) {
  const payload = [cmd, channel, valueLow & 0xff, valueHigh & 0xff];
  const body = [FRAME_START, ...payload, checksum(payload), FRAME_END];
  return Buffer.from(body);
}

// ============ BLE 帧构造（YSKJ_EMS_BLE / YSKJ_TOY_BLE）============

/** 电击器（EMS）设置某通道强度 0–276 */
function buildEmsStrength({ channel = 'A', value = 0 } = {}) {
  const ch = channelByte(channel, EMS_CHANNELS);
  const v = clamp(value, 0, EMS_STRENGTH_MAX, 0);
  return wrap(CMD.EMS_SET_STRENGTH, ch, v & 0xff, (v >> 8) & 0xff);
}

/** 电击器（EMS）设置某通道波形/模式 1–17 */
function buildEmsWave({ channel = 'A', wave = 1 } = {}) {
  const ch = channelByte(channel, EMS_CHANNELS);
  const w = clamp(wave, EMS_WAVE_MIN, EMS_WAVE_MAX, EMS_WAVE_MIN);
  return wrap(CMD.EMS_SET_WAVE, ch, w & 0xff, 0x00);
}

/** 电击器（EMS）停止（全部通道） */
function buildEmsStop() {
  return wrap(CMD.EMS_STOP, 0x00, 0x00, 0x00);
}

/** 玩具/电机 设置某电机速度 0–20 */
function buildToySpeed({ motor = 'A', speed = 0 } = {}) {
  const m = channelByte(motor, TOY_MOTORS);
  const s = clamp(speed, 0, TOY_SPEED_MAX, 0);
  return wrap(CMD.TOY_SET_SPEED, m, s & 0xff, 0x00);
}

/** 玩具/电机 设置某电机模式 1–4 */
function buildToyMode({ motor = 'A', mode = 1 } = {}) {
  const m = channelByte(motor, TOY_MOTORS);
  const md = clamp(mode, TOY_MODE_MIN, TOY_MODE_MAX, TOY_MODE_MIN);
  return wrap(CMD.TOY_SET_MODE, m, md & 0xff, 0x00);
}

/** 玩具/电机 停止 */
function buildToyStop() {
  return wrap(CMD.TOY_STOP, 0x00, 0x00, 0x00);
}

/** 将役次元品牌命令翻译为 BLE 帧（Buffer），BLE 直连模式使用 */
function toBleFrame(brandCommand) {
  const cmd = brandCommand?.cmd;
  switch (cmd) {
    case 'setStrength':
      return buildEmsStrength(brandCommand);
    case 'setMode':
    case 'setWave':
      return buildEmsWave(brandCommand);
    case 'stopAll':
    case 'stop':
      return buildEmsStop();
    case 'setSpeed':
      return buildToySpeed(brandCommand);
    case 'setToyMode':
      return buildToyMode(brandCommand);
    case 'stopToy':
      return buildToyStop();
    default:
      throw new Error(`未知的役次元 BLE 指令: ${cmd}`);
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

/** 将役次元品牌命令翻译为桥接服务 WS 消息 */
function toBridgeMessage(brandCommand, { token } = {}) {
  const cmd = brandCommand?.cmd;
  switch (cmd) {
    case 'stopAll':
    case 'stop':
      return buildBridgeSendCommand({ commandId: GLOBAL_STOP_COMMAND, token });
    case 'triggerInstruction':
      return buildBridgeSendCommand({ commandId: brandCommand.commandId, token });
    default:
      // 原始强度/通道/模式在 IM 指令模型下不可直接下发，需改用指令触发。
      throw new Error(`桥接模式不支持原始指令 ${cmd}，请使用 triggerInstruction`);
  }
}

/**
 * 役次元 API-bridge WebSocket 客户端。复用 Node 22 全局 WebSocket，测试可注入 mock。
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
    if (!this.ws || this.ws.readyState !== 1) throw new Error('役次元桥接未连接');
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
 * 役次元 BLE 直连传输层（基于 noble）。仅在可用时加载，避免无蓝牙环境崩溃。
 * 暴露 scan / connect / write / disconnect，供 YCYConnection 在 ble 模式调用。
 */
class YcyBleTransport {
  constructor() {
    this.noble = null;
    this.peripheral = null;
    this.characteristic = null;
    this.serviceUuid = null;     // 具体 UUID 需对照开放蓝牙仓库/固件
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

  /** 扫描并返回匹配名称关键字的设备列表 */
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
    this.serviceUuid = serviceUuid;
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
      peripheral.discoverSomeServicesAndCharacteristics([serviceUuid].filter(Boolean), [], (e, s, c) =>
        e ? reject(e) : resolve({ services: s, characteristics: c })));
    this.characteristic = characteristics[0];
    return { id: peripheral.id, name: peripheral.advertisement?.localName };
  }

  write(frame) {
    if (!this.characteristic) throw new Error('役次元 BLE 未连接');
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
  BLE_NAME_KEYWORDS,
  EMS_CHANNELS,
  TOY_MOTORS,
  EMS_STRENGTH_MAX,
  EMS_WAVE_MIN,
  EMS_WAVE_MAX,
  TOY_SPEED_MAX,
  TOY_MODE_MIN,
  TOY_MODE_MAX,
  GLOBAL_STOP_COMMAND,
  buildEmsStrength,
  buildEmsWave,
  buildEmsStop,
  buildToySpeed,
  buildToyMode,
  buildToyStop,
  toBleFrame,
  parseConnectCode,
  buildBridgeLogin,
  buildBridgeSendCommand,
  toBridgeMessage,
  YcyBridgeClient,
  YcyBleTransport,
};
