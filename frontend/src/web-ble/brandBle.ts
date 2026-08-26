// DG-LAB 原版 V2（Coyote）Web Bluetooth 直连封装。
//
// 这是「跨平台」主路径：Windows / Linux / macOS 的浏览器（Chrome / Edge）原生支持，
// 无需安装任何东西，别人打开页面即可用。
//   - 郊狼 2.0 在 macOS 上也能走此路径；
//   - 郊狼 3.0 在 macOS 上会被 Chromium 报 "No Services found"（私有 GATT 枚举限制），
//     此时前端会自动改走原生桥（dglab_bridge，仅 macOS）——见 BrandsPanel 的回退逻辑。
//
// 支持同时连接多台设备（按 device.id 维护多个 GATT 客户端）。
//
// 统一对外暴露：isSupported / scanAndConnect / disconnect / onBattery。

export interface BrandBleCandidate {
  id: string;
  name: string;
}

export interface BrandBleMetadata {
  id: string;
  name: string;
  type: string;
  connectionType: string;
  browserDeviceId?: string;
  data?: Record<string, unknown>;
}

// 与后端 dglabV2.js 保持一致（Base UUID 955Axxxx-0FE2-F5AA-A094-84B8D4F3E8AD）
const V2_SERVICE = '955a180b-0fe2-f5aa-a094-84b8d4f3e8ad';
const V2_CHARS = {
  battery: '955a1500-0fe2-f5aa-a094-84b8d4f3e8ad',
  pwmAB2: '955a1504-0fe2-f5aa-a094-84b8d4f3e8ad',
  pwmA34: '955a1505-0fe2-f5aa-a094-84b8d4f3e8ad',
  pwmB34: '955a1506-0fe2-f5aa-a094-84b8d4f3e8ad',
};
const DGLAB_V2_NAMES = ['D-LAB', 'DG-LAB', 'COYOTE', 'YSKJ', 'ESTIM'];
// 系统蓝牙选择器只用「设备名前缀」过滤无关设备（按服务 UUID 过滤对郊狼无效：
// 郊狼广播不含 955a180b，按服务过滤会“搜不到”）。2.0 名称以 D-LAB/DG-LAB 开头，
// 3.0 以 47L 开头；列出这些前缀即可在弹出选择器里只显示郊狼设备。
const DGLAB_V2_NAME_PREFIXES = ['D-LAB', 'DG-LAB', '47L'];

declare global {
  interface Window {
    brandBleApi?: {
      isSupported: () => boolean;
      connect: () => Promise<BrandBleMetadata>;
      disconnect: (id: string) => Promise<{ ok: boolean }>;
      disconnectAll: () => Promise<{ ok: boolean }>;
      connectedDeviceIds: () => string[];
      selectDevice: (deviceId: string) => Promise<{ ok: boolean }>;
      cancelSelection: () => Promise<{ ok: boolean }>;
      onScanResults: (cb: (devices: BrandBleCandidate[]) => void) => () => void;
    };
  }
}

export type GattOp =
  | { characteristic: 'pwmAB2' | 'pwmA34' | 'pwmB34'; value: number[] }
  | { characteristic: 'battery'; read: true };

// ============ 纯网页原生 Web Bluetooth 客户端（每台设备一个实例） ============
class WebBluetoothV2Client {
  private device: BluetoothDevice;
  private server: BluetoothRemoteGATTServer | null = null;
  private chars: Record<string, BluetoothRemoteGATTCharacteristic> = {};
  private allChars: BluetoothRemoteGATTCharacteristic[] = [];
  private batteryListeners = new Set<(value: number) => void>();
  private notifyListeners = new Set<(hex: string) => void>();
  private notifyStarted = false;

  constructor(device: BluetoothDevice) {
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => {
      this.server = null;
      this.chars = {};
    });
  }

  isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth?.requestDevice;
  }

  async connect(): Promise<BrandBleMetadata> {
    this.server = await this.device.gatt!.connect();
    const server = this.server;

    // 枚举全部主服务，兼容 Coyote 2.0（服务 955a180b）与 3.0（可能使用不同服务号）。
    // 不按设备名拦截——用户在列表里挑中的设备即视为目标设备。
    let services: BluetoothRemoteGATTService[];
    try {
      services = await server.getPrimaryServices();
    } catch (e: any) {
      // macOS Chromium 对私有 GATT 设备常在此抛 "No Services found"：
      // 抛出一个带标记的错误，便于前端判断是否走原生桥回退。
      throw new Error('WEBBLE_NO_SERVICES:' + (e?.message || 'unknown'));
    }
    if (services.length === 0) {
      try { this.device.gatt?.disconnect(); } catch (_) {}
      throw new Error('WEBBLE_NO_SERVICES: 设备未返回任何可用服务');
    }

    const service: BluetoothRemoteGATTService | undefined =
      services.find((s) => s.uuid.toLowerCase() === V2_SERVICE.toLowerCase()) ||
      services.find((s) => s.uuid.toLowerCase().startsWith('955a')) ||
      services[0];

    // 枚举服务下全部真实特征（不硬 get 预设 UUID；真机特征 UUID 与 dglabV2.js
    // 预设的 955a1500/1504/1505/1506 不一定一致）。若选定服务无特征，再扫其余服务兜底。
    let characteristics: BluetoothRemoteGATTCharacteristic[] = [];
    try {
      characteristics = await service.getCharacteristics();
    } catch (e) {
      characteristics = [];
    }
    if (characteristics.length === 0 && services.length > 1) {
      for (const s of services) {
        if (s.uuid.toLowerCase() === service.uuid.toLowerCase()) continue;
        try {
          const cs = await s.getCharacteristics();
          characteristics.push(...cs);
        } catch (_) {
          /* 忽略无特征的服务 */
        }
      }
    }
    const foundUuids = characteristics.map((c) => c.uuid.toLowerCase());
    // eslint-disable-next-line no-console
    console.log('[brandBle] 郊狼服务', service.uuid, '下真实特征 UUID:', foundUuids);

    this.chars = {};
    this.allChars = characteristics;
    for (const key of Object.keys(V2_CHARS) as Array<keyof typeof V2_CHARS>) {
      const want = V2_CHARS[key].toLowerCase();
      const ch = characteristics.find((c) => c.uuid.toLowerCase() === want);
      if (ch) this.chars[key] = ch;
    }

    // 电量特征识别（按属性优先，避免误选首字节为 0 的通知特征）：
    // 1) 优先带 notify/indicate 的特征——DG-LAB/Coyote 电量通常经 notify 上报（2.0 的 955A1500 即如此）；
    // 2) 否则逐个读可读特征，挑出「单字节 0-100」的；
    // 3) 都没有则用任意可读特征兜底。
    let battery: BluetoothRemoteGATTCharacteristic | undefined =
      characteristics.find((c) => c.properties?.notify || c.properties?.indicate);
    if (!battery) {
      for (const c of characteristics) {
        if (c.properties?.read) {
          try {
            const v = await c.readValue();
            if (v && v.byteLength === 1) {
              const b = v.getUint8(0);
              if (b >= 0 && b <= 100) { battery = c; break; }
            }
          } catch (_) { /* 不可读或读失败，忽略 */ }
        }
      }
    }
    if (battery) this.chars.battery = battery;

    if (this.chars.battery) {
      // 连上即读一次电量，确保立刻显示（即便设备只支持 read 不支持 notify）
      try {
        if (this.chars.battery.properties?.read) {
          const init = await this.chars.battery.readValue();
          if (init && init.byteLength >= 1) this.emitBattery(init.getUint8(0));
        }
      } catch (_) {
        /* 只读或权限受限，忽略 */
      }
      try {
        await this.chars.battery.startNotifications();
        this.chars.battery.addEventListener('characteristicvaluechanged', (ev) => {
          const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
          if (v && v.byteLength >= 1) this.emitBattery(v.getUint8(0));
        });
      } catch (_) {
        /* 部分设备不支持 notify，忽略 */
      }
    }

    const name = this.device.name || '蓝牙体感设备 V2';
    return {
      id: `ble:${this.device.id}`,
      name,
      type: 'DGLAB',
      connectionType: 'brandBle',
      browserDeviceId: this.device.id,
      data: { service: service.uuid, characteristics: foundUuids },
    };
  }

  private emitBattery(value: number) {
    this.batteryListeners.forEach((cb) => { try { cb(value); } catch (_) {} });
  }

  onBattery(cb: (value: number) => void): () => void {
    this.batteryListeners.add(cb);
    return () => { this.batteryListeners.delete(cb); };
  }

  /** 订阅设备发来的 notify / indicate 数据帧（传感器类设备用，如灵猫气压、爪印按钮）。 */
  onNotify(cb: (hex: string) => void): () => void {
    this.notifyListeners.add(cb);
    this.ensureNotify().catch(() => {});
    return () => { this.notifyListeners.delete(cb); };
  }

  private async ensureNotify(): Promise<void> {
    if (this.notifyStarted) return;
    this.notifyStarted = true;
    const targets = this.allChars.filter(
      (c) => c.properties?.notify || c.properties?.indicate
    );
    for (const ch of targets) {
      try {
        await ch.startNotifications();
        ch.addEventListener('characteristicvaluechanged', (ev) => {
          const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
          if (!v) return;
          const hex = Array.from(new Uint8Array(v.buffer))
            .map((b) => (b & 0xff).toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase();
          this.notifyListeners.forEach((cb) => { try { cb(hex); } catch (_) {} });
        });
      } catch (_) {
        /* 部分设备不支持 notify，忽略 */
      }
    }
  }

  /** 向指定写特征下发一帧 GATT 写指令（强度 / 波形等）。 */
  async send(op: GattOp): Promise<void> {
    if (op && 'read' in op && op.read) {
      const ch = this.chars.battery;
      if (!ch || !ch.properties?.read) throw new Error('无可读特征');
      await ch.readValue();
      return;
    }
    const ch = this.chars[(op as any).characteristic];
    if (!ch) throw new Error(`未找到写特征 ${(op as any).characteristic}`);
    const data = new Uint8Array((op as any).value);
    if (ch.properties?.writeWithoutResponse) ch.writeValueWithoutResponse(data);
    else await ch.writeValueWithResponse(data);
  }

  async disconnect(): Promise<void> {
    try { this.device.gatt?.disconnect(); } catch (_) {}
    this.server = null;
    this.chars = {};
    this.batteryListeners.clear();
  }
}

// 多设备：按 device.id 维护多个客户端实例
const clients = new Map<string, WebBluetoothV2Client>();

const webSupported = typeof navigator !== 'undefined' && !!navigator.bluetooth?.requestDevice;

function usingElectron(): boolean {
  return typeof window !== 'undefined' && !!window.brandBleApi && window.brandBleApi.isSupported();
}

export function isSupported(): boolean {
  if (usingElectron()) return true;
  return !!webSupported;
}

/** 弹窗选设备并连接，返回元数据。Electron 与纯网页路径统一。 */
export async function scanAndConnect(): Promise<BrandBleMetadata> {
  if (usingElectron()) {
    return window.brandBleApi!.connect();
  }
  if (!webSupported) throw new Error('当前环境不支持网页蓝牙直连（请用 Chrome / Edge 打开本页）');
  // 关键修正：之前用 namePrefix (D-LAB/DG-LAB/47L) 过滤，但郊狼广播常不带可读名字
  // （实测得大量 name:""），导致选择器按名字一筛把郊狼全剔掉 → “搜不到”。
  // 改用 acceptAllDevices:true，让所有广播中的 BLE 设备都进选择器，用户手动挑郊狼；
  // optionalServices 照常声明，保证连上后能访问 2.0(955A) 与 3.0(2003/2004/fe59) 服务。
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [
      V2_SERVICE,
      '00002003-0000-1000-8000-00805f9b34fb',
      '00002004-0000-1000-8000-00805f9b34fb',
      '0000fe59-0000-1000-8000-00805f9b34fb',
    ],
  });
  const client = new WebBluetoothV2Client(device);
  const meta = await client.connect();
  clients.set(meta.id, client);
  return meta;
}

/** 兼容别名：便于调用方以 connect 语义直接使用。 */
export const connect = scanAndConnect;

export async function disconnect(id: string): Promise<{ ok: boolean }> {
  if (usingElectron()) {
    return window.brandBleApi!.disconnect(id);
  }
  const c = clients.get(id);
  if (c) {
    await c.disconnect();
    clients.delete(id);
  }
  return { ok: true };
}

/** 订阅某台设备的电量回调，返回取消订阅函数。 */
export function onBattery(id: string, cb: (value: number) => void): () => void {
  if (usingElectron()) {
    // Electron 路径电量由后端经 property 推送，前端另走 deviceService；此处不阻塞。
    return () => {};
  }
  const c = clients.get(id);
  if (!c) return () => {};
  return c.onBattery(cb);
}

/** Electron 路径：订阅候选设备列表（select-bluetooth-device 推来的候选）。 */
export function onScanResults(cb: (devices: Array<{ id: string; name: string }>) => void): () => void {
  if (!usingElectron()) return () => {};
  return window.brandBleApi!.onScanResults(cb);
}

/** Electron 路径：从候选列表中选择某个设备完成连接。 */
export async function selectDevice(id: string): Promise<void> {
  if (!usingElectron()) throw new Error('仅 Electron 路径支持 selectDevice');
  return window.brandBleApi!.selectDevice(id);
}

/** Electron 路径：取消候选选择。 */
export async function cancelSelection(): Promise<void> {
  if (!usingElectron()) return;
  return window.brandBleApi!.cancelSelection();
}

export function getCandidateName(device: BluetoothDevice): string {
  const n = String(device.name || '');
  return DGLAB_V2_NAMES.some((k) => n.toUpperCase().includes(k.toUpperCase()))
    ? n
    : (n || '蓝牙体感设备 V2');
}

/** 字节数组 → 十六进制串（小写，无分隔）。 */
export function bytesToHex(bytes: number[] | Uint8Array): string {
  return Array.from(bytes).map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

/** 向已连接的网页蓝牙设备下发 GATT 操作（强度 / 波形帧等）。 */
export function sendGattOp(id: string, op: GattOp): Promise<void> {
  if (usingElectron()) {
    // Electron 路径的写指令统一走原生桥（dglabBridge.send）；此处不支持直接 web 下发。
    return Promise.reject(new Error('Electron 模式下请使用本机桥接发送指令'));
  }
  const c = clients.get(id);
  if (!c) return Promise.reject(new Error('设备未连接'));
  return c.send(op);
}

/** 订阅已连接设备的 notify 数据帧（传感器）。 */
export function subscribeNotify(id: string, cb: (hex: string) => void): () => void {
  if (usingElectron()) return () => {};
  const c = clients.get(id);
  if (!c) return () => {};
  return c.onNotify(cb);
}

export const V2_NAMES = DGLAB_V2_NAMES;
export const V2_CHARACTERISTICS = V2_CHARS;

// ============ 协议打包（与后端 dglabV2.js 对齐，便于网页版直接下发） ============
// 强度位布局默认 coyote2；网页版暂无运行时切换入口，沿用默认。
export function packStrengthOps(a: number, b: number): GattOp[] {
  const va = Math.max(0, Math.min(2047, Math.round(a)));
  const vb = Math.max(0, Math.min(2047, Math.round(b)));
  // coyote2：A = data>>13，B = (data>>2)&0x3FF → 小端 24bit
  const data = ((va & 0x7ff) << 13) | ((vb & 0x7ff) << 2);
  const value = [data & 0xff, (data >> 8) & 0xff, (data >> 16) & 0xff];
  return [{ characteristic: 'pwmAB2', value }];
}

export function packWaveformOps(channel: 'A' | 'B', x: number, y: number): GattOp[] {
  const xx = Math.max(0, Math.min(31, Math.round(x)));
  const yy = Math.max(0, Math.min(1023, Math.round(y)));
  const z = 0;
  const freq = xx + yy;
  const data = (z << 15) | (yy << 5) | xx; // 小端 24bit：x(5) | y(10) | z(5)
  const value = [data & 0xff, (data >> 8) & 0xff, (data >> 16) & 0xff];
  const characteristic = channel === 'B' ? 'pwmB34' : 'pwmA34';
  return [{ characteristic, value }];
}
