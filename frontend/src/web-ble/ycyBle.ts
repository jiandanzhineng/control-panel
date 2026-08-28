// 役次元（YCY）Web Bluetooth 直连封装。
//
// 这是役次元的「跨平台」主路径：Windows / Linux / Android 的浏览器（Chrome / Edge）原生支持，
// 无需安装任何东西，别人打开页面即可连上役次元设备。
//   - macOS 上 Web BLE 摸 YCY 自定义 GATT 有不确定性（同郊狼 3.0 被 Chromium 报 No Services found 的情况），
//     Mac 用户仍走原生桥（ycy_bridge，仅 macOS，已编译进仓库）——见 BrandsPanel 的自动选择逻辑。
// //
// 支持同时连接多台设备（按 device.id 维护多个 GATT 客户端）。
//
// 对外暴露：isSupported / scanAndConnect / disconnect / onBattery / sendFrame。组帧在后端。

export interface YcyBleMetadata {
  id: string;
  name: string;
  type: string;
  connectionType: string; // 'ycyBle'
  browserDeviceId?: string;
  data?: Record<string, unknown>;
}

// 设备名关键字（与 ycy.js 对齐 + 真机实测 YYC-DJ-V2 / YCY-FJB-03-DJ / YISK-003V3）
const YCY_NAME_KEYWORDS = ['YCY', 'YYC', 'YSKJ', 'YOKO', 'YOKONEX', 'YISK', 'DJ-V2', 'FJB', 'SOSEXY', '灌肠', 'ENEMA', 'GLJ', 'DJ'];

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
  '0000ee01-0000-1000-8000-00805f9b34fb',
  '98a9cd00-ca0a-4cf8-9f85-e93949467558',
  '0000180f-0000-1000-8000-00805f9b34fb', // Battery Service
  '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
];
const BATTERY_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';

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
    // FJB-03 真机控制在 FF41，AE01 同分会被先枚举到，写过去没动作。
    if (/FJB/i.test(this.device.name || '')) {
      const fjbW = allChars.find((c) => lower(c.uuid) === '0000ff41-0000-1000-8000-00805f9b34fb');
      const fjbN = allChars.find((c) => lower(c.uuid) === '0000ff42-0000-1000-8000-00805f9b34fb');
      if (fjbW) write = fjbW;
      if (fjbN) notify = fjbN;
    }
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
      await this.writeChar.writeValueWithoutResponse(data);
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

function usingElectron(): boolean {
  return typeof window !== 'undefined' && !!window.ycyBleApi && window.ycyBleApi.isSupported();
}

export function isSupported(): boolean {
  return usingElectron() || !!webSupported;
}

/** 弹窗选设备并连接，返回元数据。 */
export async function scanAndConnect(): Promise<YcyBleMetadata> {
  if (usingElectron()) {
    return window.ycyBleApi!.connect() as Promise<YcyBleMetadata>;
  }
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
  if (usingElectron()) {
    return window.ycyBleApi!.disconnect(id);
  }
  const c = clients.get(id);
  if (c) {
    await c.disconnect();
    clients.delete(id);
  }
  return { ok: true };
}

/** 订阅电量回调，返回取消订阅函数（标准电池特征若有则回传，否则永不触发）。 */
export function onBattery(id: string, cb: (value: number) => void): () => void {
  if (usingElectron()) return () => {};
  const c = clients.get(id);
  if (!c) return () => {};
  return c.onBattery(cb);
}

/** 按后端下发的字节写 GATT。 */
export async function sendFrame(id: string, bytes: number[] | Uint8Array): Promise<void> {
  const c = clients.get(id);
  if (!c) throw new Error('役次元设备未连接');
  await c.write(bytes);
}
