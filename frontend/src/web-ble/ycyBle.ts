// 役次元（YCY）Web Bluetooth 直连封装。
//
// 这是役次元的「跨平台」主路径：Windows / Linux / Android 的浏览器（Chrome / Edge）原生支持，
// 无需安装任何东西，别人打开页面即可连上役次元设备。
//   - macOS 上 Web BLE 摸 YCY 自定义 GATT 有不确定性（同郊狼 3.0 被 Chromium 报 No Services found 的情况），
//     Mac 用户仍走原生桥（ycy_bridge，仅 macOS，已编译进仓库）——见 BrandsPanel 的自动选择逻辑。
//   - 本文件与 backend/brands/protocols/ycy.js 的 0x35 族帧构造保持一致（电刺激 / 马达 / 泵）。
//
// 支持同时连接多台设备（按 device.id 维护多个 GATT 客户端）。
//
// 对外暴露：isSupported / scanAndConnect / disconnect / onBattery / sendEms* / sendMotor / sendPump*。

export interface YcyBleMetadata {
  id: string;
  name: string;
  type: string;
  connectionType: string; // 'ycyBle'
  browserDeviceId?: string;
  data?: Record<string, unknown>;
}

// 设备名关键字（与 ycy.js 对齐 + 真机实测 YYC-DJ-V2 / YCY-FJB-03-DJ / YISK-003V3）
const YCY_NAME_KEYWORDS = ['YCY', 'YYC', 'YSKJ', 'YOKO', 'YOKONEX', 'YISK', 'DJ-V2', 'FJB', '灌肠', 'ENEMA', 'GLJ', 'DJ'];

// 已知写/通知特征 UUID（动态发现为主，这里做兜底匹配；来自 ycy_bridge 真机实测）。
// 电击器 YYC-DJ-V2: FF30 写 / FF32 通知
// 杯 FJB:         FF40 写 / FF42 通知
// 灌肠机 YISK:    FF70 写 / FF72 通知
// AE00 系统通道:  AE01 写 / AE02 通知（疑似第二通道/泵）
const KNOWN_WRITE_UUIDS = [
  '0000ff31-0000-1000-8000-00805f9b34fb',
  '0000ff41-0000-1000-8000-00805f9b34fb',
  '0000ff71-0000-1000-8000-00805f9b34fb',
  '0000ae01-0000-1000-8000-00805f9b34fb',
];
const KNOWN_NOTIFY_UUIDS = [
  '0000ff32-0000-1000-8000-00805f9b34fb',
  '0000ff42-0000-1000-8000-00805f9b34fb',
  '0000ff72-0000-1000-8000-00805f9b34fb',
  '0000ae02-0000-1000-8000-00805f9b34fb',
];
// requestDevice 的 optionalServices：列出役次元各型号服务 + 标准电池/设备信息服务，
// 确保即便设备名不匹配前缀也能连接并枚举特征。
const OPTIONAL_SERVICES = [
  '0000ff30-0000-1000-8000-00805f9b34fb',
  '0000ff40-0000-1000-8000-00805f9b34fb',
  '0000ff70-0000-1000-8000-00805f9b34fb',
  '0000ae00-0000-1000-8000-00805f9b34fb',
  '0000180f-0000-1000-8000-00805f9b34fb', // Battery Service
  '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
];
const BATTERY_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';

// ============ 帧构造（与 backend/brands/protocols/ycy.js 对齐，权威自 protocol.py）============
const FAMILY = { CHANNEL_CONTROL: 0x11, MOTOR_CONTROL: 0x12, QUERY: 0x71 } as const;
const CHANNEL_BYTE: Record<string, number> = { A: 0x01, B: 0x02, AB: 0x03 };
const MODE = { OFF: 0x00, PRESET_1: 0x01, CUSTOM: 0x11 } as const;

const EMS_STRENGTH_MAX = 276;
const EMS_STRENGTH_MIN = 1;
const EMS_CHANNEL_MAX = 276;
const EMS_FREQ_MAX = 100;
const MOTOR_SPEED_MAX = 20;
const PUMP_RATE_DEFAULT = 3;
const PUMP_CIPHER_KEY = 'F638BC9CFA477480AB3242F6B04557A1'; // AES-128 密钥（APK 逆向）

function clamp(value: number, min: number, max: number, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
/** 强度映射：UI 量纲 0–100 → 设备量纲 1–276（0 表示关闭通道）。 */
function mapStrengthToYcy(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(EMS_STRENGTH_MIN, Math.min(EMS_STRENGTH_MAX, Math.round((n / 100) * (EMS_STRENGTH_MAX - 1)) + 1));
}
/** 校验和 = 所有字节之和 mod 256（含 0x35 包头与命令字）。 */
function checksum(bytes: number[]): number {
  let s = 0;
  for (const b of bytes) s = (s + (b & 0xff)) & 0xff;
  return s & 0xff;
}
function withChecksum(buf: number[]): number[] {
  return [...buf, checksum(buf)];
}

/** 电刺激连接握手：35 14 01。 */
export function buildEmsHandshake(): number[] {
  return [0x35, 0x14, 0x01];
}
/** 电刺激通道强度帧（10 字节，含校验和）。 */
export function buildEmsStrength(opts: { channel?: 'A' | 'B' | 'AB'; value?: number; freq?: number; pulse?: number } = {}): number[] {
  const channel = (opts.channel || 'A').toUpperCase();
  const ch = CHANNEL_BYTE[channel] ?? CHANNEL_BYTE.A;
  const strength = mapStrengthToYcy(opts.value ?? 0);
  const enabled = strength > 0 ? 1 : 0;
  const custom = true; // 统一带 freq/pulse，固件按其是否为 0 决定预设/自定义
  const mode = custom ? MODE.CUSTOM : MODE.PRESET_1;
  const f = clamp(opts.freq ?? 50, 0, EMS_FREQ_MAX);
  const p = clamp(opts.pulse ?? 50, 0, EMS_FREQ_MAX);
  const s = clamp(strength, 0, EMS_CHANNEL_MAX);
  return withChecksum([0x35, FAMILY.CHANNEL_CONTROL, ch, enabled, (s >> 8) & 0xff, s & 0xff, mode, f, p]);
}
/** 电刺激停止：关闭 AB 双通道。 */
export function buildEmsStop(): number[] {
  return withChecksum([0x35, FAMILY.CHANNEL_CONTROL, CHANNEL_BYTE.AB, 0x00, 0x00, 0x00, MODE.PRESET_1, 0x00, 0x00]);
}
/** 玩具 / 电机速度帧（4 字节）：35 12 [速度 0–20] [校验和]。 */
export function buildMotor(opts: { speed?: number } = {}): number[] {
  const s = clamp(opts.speed ?? 0, 0, MOTOR_SPEED_MAX);
  return withChecksum([0x35, FAMILY.MOTOR_CONTROL, s]);
}
/** YCY-FJB-03：6 字节 35 12 旋转(0–40) 震动(0–20) 第三轴(0–20) 校验。 */
export function buildFjb03(opts: { stroke?: number; vibe?: number; axis?: number } = {}): number[] {
  return withChecksum([
    0x35,
    FAMILY.MOTOR_CONTROL,
    clamp(opts.stroke ?? 0, 0, 40),
    clamp(opts.vibe ?? 0, 0, MOTOR_SPEED_MAX),
    clamp(opts.axis ?? 0, 0, MOTOR_SPEED_MAX),
  ]);
}
/**
 * pump_v3（杯 / 灌肠机，明文 35 12 族，与电机帧同构，仅数据字节语义不同）：
 *   stop : 35 12 00 00 00 | CS
 *   cut  : 35 12 FF 00 00 | CS
 *   add  : 35 12 00 [air:1B] 00 | CS
 *   guan : 35 12 00 00 [water:1B] | CS
 */
export function buildPumpV3(opts: { scene?: 'stop' | 'cut' | 'add' | 'guan'; air?: number; water?: number } = {}): number[] {
  const scene = opts.scene || 'stop';
  let body: number[];
  switch (scene) {
    case 'cut': body = [FAMILY.MOTOR_CONTROL, 0xff, 0x00, 0x00]; break;
    case 'add': body = [FAMILY.MOTOR_CONTROL, 0x00, clamp(opts.air ?? 1, 0, 0xff), 0x00]; break;
    case 'guan': body = [FAMILY.MOTOR_CONTROL, 0x00, 0x00, clamp(opts.water ?? 1, 0, 0xff)]; break;
    case 'stop':
    default: body = [FAMILY.MOTOR_CONTROL, 0x00, 0x00, 0x00]; break;
  }
  return withChecksum([0x35, ...body]);
}

// ---- AES-128-ECB（泵加密帧 v1/v2 需要；Web Crypto 不支持 ECB，故自带纯 TS 实现）----
const SBOX = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
] as const;
const RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function gfMul(a: number, b: number): number {
  let p = 0;
  let aa = a & 0xff;
  let bb = b & 0xff;
  for (let i = 0; i < 8; i++) {
    if (bb & 1) p ^= aa;
    const hi = aa & 0x80;
    aa = (aa << 1) & 0xff;
    if (hi) aa ^= 0x1b;
    bb >>= 1;
  }
  return p & 0xff;
}

function keyExpansion(key: number[]): number[][] {
  const Nk = 4;
  const Nr = 10;
  const w: number[][] = [];
  for (let i = 0; i < Nk; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  for (let i = Nk; i < 4 * (Nr + 1); i++) {
    let temp = w[i - 1].slice();
    if (i % Nk === 0) {
      temp = [temp[1], temp[2], temp[3], temp[0]]; // RotWord
      temp = temp.map((b) => SBOX[b]); // SubWord
      temp[0] ^= RCON[i / Nk];
    }
    w.push([w[i - Nk][0] ^ temp[0], w[i - Nk][1] ^ temp[1], w[i - Nk][2] ^ temp[2], w[i - Nk][3] ^ temp[3]]);
  }
  return w;
}

function aesEncryptBlock(block: number[], w: number[][]): number[] {
  // 标准 AES 状态：state[row][col]，第 i 字节 → state[i%4][floor(i/4)]。
  // 即 state[r] = 第 r 行 = [block[r], block[r+4], block[r+8], block[r+12]]。
  const s: number[][] = [
    [block[0], block[4], block[8], block[12]],
    [block[1], block[5], block[9], block[13]],
    [block[2], block[6], block[10], block[14]],
    [block[3], block[7], block[11], block[15]],
  ];
  const addRoundKey = (r: number) => {
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) s[row][c] ^= w[4 * r + c][row];
  };
  addRoundKey(0);
  for (let r = 1; r < 10; r++) {
    // SubBytes
    for (let row = 0; row < 4; row++) for (let c = 0; c < 4; c++) s[row][c] = SBOX[s[row][c]];
    // ShiftRows：第 row 行左移 row 位
    for (let row = 0; row < 4; row++) {
      const v = s[row].slice();
      s[row] = [...v.slice(row), ...v.slice(0, row)];
    }
    // MixColumns
    for (let c = 0; c < 4; c++) {
      const a0 = s[0][c], a1 = s[1][c], a2 = s[2][c], a3 = s[3][c];
      s[0][c] = gfMul(a0, 2) ^ gfMul(a1, 3) ^ a2 ^ a3;
      s[1][c] = a0 ^ gfMul(a1, 2) ^ gfMul(a2, 3) ^ a3;
      s[2][c] = a0 ^ a1 ^ gfMul(a2, 2) ^ gfMul(a3, 3);
      s[3][c] = gfMul(a0, 3) ^ a1 ^ a2 ^ gfMul(a3, 2);
    }
    addRoundKey(r);
  }
  // 末轮 SubBytes + ShiftRows（无 MixColumns）
  for (let row = 0; row < 4; row++) for (let c = 0; c < 4; c++) s[row][c] = SBOX[s[row][c]];
  for (let row = 0; row < 4; row++) {
    const v = s[row].slice();
    s[row] = [...v.slice(row), ...v.slice(0, row)];
  }
  addRoundKey(10);
  // 按 FIPS-197 列主序展开回字节数组（与输入字节序一致）：out[i] = s[i%4][floor(i/4)]。
  // 注意：输入按列主序装载（block[r+4c] → s[r][c]），输出也必须列主序读出，否则字节错位。
  return [
    s[0][0], s[1][0], s[2][0], s[3][0],
    s[0][1], s[1][1], s[2][1], s[3][1],
    s[0][2], s[1][2], s[2][2], s[3][2],
    s[0][3], s[1][3], s[2][3], s[3][3],
  ];
}

/** AES-128-ECB 单块加密（明文/密钥均 16 字节），返回 16 字节密文。 */
export function aes128EcbEncrypt(plain16: number[], key16: number[]): number[] {
  if (plain16.length !== 16 || key16.length !== 16) throw new Error('AES-128 需 16 字节块与密钥');
  const w = keyExpansion(key16);
  return aesEncryptBlock(plain16, w);
}

/**
 * pump_v1 / pump_v2（杯 / 灌肠机，AES-128 加密帧）：明文以 BF 0F A0 起头，整帧加密为 16 字节密文。
 * 返回 16 字节密文（即 BLE 直发帧，无额外 0x35 包头）。
 */
export function buildPumpEncrypted(opts: { protocol?: 'v1' | 'v2'; scene?: 'stop' | 'cut' | 'add' | 'guan'; rate?: number; ss?: number } = {}): number[] {
  const protocol = opts.protocol || 'v1';
  const scene = opts.scene || 'stop';
  const ssHex = (clamp(opts.ss ?? 0, 0, 0xffff)).toString(16).padStart(4, '0').toUpperCase();
  const rateHex = (clamp(opts.rate ?? PUMP_RATE_DEFAULT, 1, 0xff)).toString(16).padStart(2, '0').toUpperCase();
  let plain: string;
  if (protocol === 'v2') {
    switch (scene) {
      case 'add': plain = `BF0FA001${rateHex}${ssHex}`; break;
      case 'cut': plain = `BF0FA001FF${ssHex}`; break;
      case 'guan': plain = `BF0FA00201${ssHex}`; break;
      case 'stop': default: plain = `BF0FA003`; break;
    }
  } else {
    switch (scene) {
      case 'add': plain = `BF0FA00101${ssHex}`; break;
      case 'cut': plain = `BF0FA00102${ssHex}`; break;
      case 'guan': plain = `BF0FA00201${ssHex}`; break;
      case 'stop': default: plain = `BF0FA003`; break;
    }
  }
  const plainBuf = plain.match(/../g)!.map((h) => parseInt(h, 16));
  const padded = new Array(16).fill(0);
  for (let i = 0; i < Math.min(plainBuf.length, 16); i++) padded[i] = plainBuf[i];
  const key = PUMP_CIPHER_KEY.match(/../g)!.map((h) => parseInt(h, 16));
  return aes128EcbEncrypt(padded, key);
}

// ============ 纯网页原生 Web Bluetooth 客户端（每台设备一个实例） ============
class WebBluetoothYcyClient {
  private device: BluetoothDevice;
  private server: BluetoothRemoteGATTServer | null = null;
  private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private batteryListeners = new Set<(value: number) => void>();

  constructor(device: BluetoothDevice) {
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => {
      this.server = null;
      this.writeChar = null;
    });
  }

  isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth?.requestDevice;
  }

  async connect(): Promise<YcyBleMetadata> {
    this.server = await this.device.gatt!.connect();
    const server = this.server;

    let services: BluetoothRemoteGATTService[];
    try {
      services = await server.getPrimaryServices();
    } catch (e: any) {
      throw new Error('WEBLE_NO_SERVICES:' + (e?.message || 'unknown'));
    }
    if (services.length === 0) {
      try { this.device.gatt?.disconnect(); } catch (_) {}
      throw new Error('WEBLE_NO_SERVICES: 设备未返回任何可用服务');
    }

    // 枚举全部服务下的全部特征，兼容各型号不同服务号（FF30/FF40/FF70/AE00 等）。
    // 同时按服务分组，便于「写+通知」在同服务内配对，避免跨服务误配。
    const allChars: BluetoothRemoteGATTCharacteristic[] = [];
    const svcChars = new Map<string, BluetoothRemoteGATTCharacteristic[]>();
    for (const svc of services) {
      try {
        const cs = await svc.getCharacteristics();
        allChars.push(...cs);
        svcChars.set(svc.uuid.toLowerCase(), cs);
      } catch (_) { /* 忽略无特征的服务 */ }
    }
    const foundUuids = allChars.map((c) => c.uuid.toLowerCase());
    // eslint-disable-next-line no-console
    console.log('[ycyBle] 役次元设备', this.device.name, '真实特征 UUID:', foundUuids);

    const lower = (s: string) => s.toLowerCase();
    const isWrite = (c: BluetoothRemoteGATTCharacteristic) => !!c.properties?.write || !!c.properties?.writeWithoutResponse;
    const isNotify = (c: BluetoothRemoteGATTCharacteristic) => !!c.properties?.notify || !!c.properties?.indicate;
    const knownWrite = (c: BluetoothRemoteGATTCharacteristic) => KNOWN_WRITE_UUIDS.includes(lower(c.uuid));
    const knownNotify = (c: BluetoothRemoteGATTCharacteristic) => KNOWN_NOTIFY_UUIDS.includes(lower(c.uuid));

    // 写/通知特征选择：优先精确命中已知 UUID，并在同服务内配对（写+通知成对），
    // 避免全局首匹配把不同服务的特征误配；未命中已知 UUID 时退化为「同服务内可写+可通知」成对。
    // 评分：已知 UUID 命中 +2、仅按属性 +1，取分最高者；同分取先枚举到的服务。
    let write: BluetoothRemoteGATTCharacteristic | null = null;
    let notify: BluetoothRemoteGATTCharacteristic | undefined;
    let bestScore = -1;
    for (const svc of services) {
      const cs = svcChars.get(svc.uuid.toLowerCase()) || [];
      if (cs.length === 0) continue;
      const w = cs.find(knownWrite) || cs.find(isWrite) || null;
      const n = cs.find(knownNotify) || cs.find(isNotify) || null;
      if (!w && !n) continue;
      let score = 0;
      if (w && knownWrite(w)) score += 2; else if (w) score += 1;
      if (n && knownNotify(n)) score += 2; else if (n) score += 1;
      if (score > bestScore) {
        bestScore = score;
        write = w;
        notify = n ?? undefined;
      }
    }
    // 兜底：仍无结果时退化为全局首匹配（保持旧行为，极端情况下保底）。
    if (!write) write = allChars.find(isWrite) || null;
    if (!notify) notify = allChars.find(isNotify);
    this.writeChar = write;

    if (!this.writeChar) {
      try { this.device.gatt?.disconnect(); } catch (_) {}
      throw new Error('未找到可写特征，设备可能不支持 BLE 直控');
    }

    // 订阅通知（状态/电量回传）。
    if (notify) {
      try {
        await notify.startNotifications();
        notify.addEventListener('characteristicvaluechanged', () => { /* 暂仅记录，解析待协议补充 */ });
      } catch (_) { /* 部分设备不支持 notify */ }
    }

    // 电量：尝试标准 Battery Service 0x2A19。役次元多数机型无此服务，找不到则电量留空。
    let batteryVal: number | null = null;
    const batt = allChars.find((c) => lower(c.uuid) === BATTERY_CHAR);
    if (batt && batt.properties?.read) {
      try {
        const v = await batt.readValue();
        if (v && v.byteLength >= 1) batteryVal = v.getUint8(0);
      } catch (_) { /* 读失败忽略 */ }
    }

    const name = this.device.name || '役次元设备';
    return {
      id: `ble:${this.device.id}`,
      name,
      type: 'YCY',
      connectionType: 'ycyBle',
      browserDeviceId: this.device.id,
      data: { characteristics: foundUuids, hasBattery: batteryVal != null },
      // 电量通过 onBattery 异步回传（这里先放初值）
      ...(batteryVal != null ? { battery: batteryVal } : {}),
    } as YcyBleMetadata & { battery?: number };
  }

  private emitBattery(value: number) {
    this.batteryListeners.forEach((cb) => { try { cb(value); } catch (_) {} });
  }
  onBattery(cb: (value: number) => void): () => void {
    this.batteryListeners.add(cb);
    return () => { this.batteryListeners.delete(cb); };
  }

  async write(bytes: number[] | Uint8Array): Promise<void> {
    if (!this.writeChar) throw new Error('役次元 BLE 未连接');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (this.writeChar.properties?.writeWithoutResponse) {
      this.writeChar.writeValueWithoutResponse(data);
    } else {
      await this.writeChar.writeValueWithResponse(data);
    }
  }

  async disconnect(): Promise<void> {
    try { this.device.gatt?.disconnect(); } catch (_) {}
    this.server = null;
    this.writeChar = null;
    this.batteryListeners.clear();
  }
}

const clients = new Map<string, WebBluetoothYcyClient>();
const webSupported = typeof navigator !== 'undefined' && !!navigator.bluetooth?.requestDevice;

export function isSupported(): boolean {
  return !!webSupported;
}

/** 弹窗选设备并连接，返回元数据。 */
export async function scanAndConnect(): Promise<YcyBleMetadata> {
  if (!webSupported) throw new Error('当前环境不支持网页蓝牙直连（请用 Chrome / Edge 打开本页）');
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: OPTIONAL_SERVICES,
  });
  const client = new WebBluetoothYcyClient(device);
  const meta = (await client.connect()) as YcyBleMetadata & { battery?: number };
  clients.set(meta.id, client);
  return meta;
}

export async function disconnect(id: string): Promise<{ ok: boolean }> {
  const c = clients.get(id);
  if (c) {
    await c.disconnect();
    clients.delete(id);
  }
  return { ok: true };
}

/** 订阅电量回调，返回取消订阅函数（标准电池特征若有则回传，否则永不触发）。 */
export function onBattery(id: string, cb: (value: number) => void): () => void {
  const c = clients.get(id);
  if (!c) return () => {};
  return c.onBattery(cb);
}

// ============ 控制指令（供 UI 直接下发）============
export async function sendFrame(id: string, bytes: number[] | Uint8Array): Promise<void> {
  const c = clients.get(id);
  if (!c) throw new Error('役次元设备未连接');
  await c.write(bytes);
}
export const sendEmsHandshake = (id: string) => sendFrame(id, buildEmsHandshake());
export const sendEmsStrength = (id: string, o?: { channel?: 'A' | 'B' | 'AB'; value?: number; freq?: number; pulse?: number }) => sendFrame(id, buildEmsStrength(o));
export const sendEmsStop = (id: string) => sendFrame(id, buildEmsStop());
export const sendMotor = (id: string, speed?: number) => sendFrame(id, buildMotor({ speed }));
export const sendFjb03 = (id: string, o?: { stroke?: number; vibe?: number; axis?: number }) => sendFrame(id, buildFjb03(o));
export const sendPumpV3 = (id: string, o?: { scene?: 'stop' | 'cut' | 'add' | 'guan'; air?: number; water?: number }) => sendFrame(id, buildPumpV3(o));
export const sendPumpEncrypted = (id: string, o?: { protocol?: 'v1' | 'v2'; scene?: 'stop' | 'cut' | 'add' | 'guan'; rate?: number; ss?: number }) => sendFrame(id, buildPumpEncrypted(o));
