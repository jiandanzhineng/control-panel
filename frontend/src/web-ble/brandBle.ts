// DG-LAB 原版 V2（Coyote）Web Bluetooth 直连封装。
//
// 两条路径：
//   1) Electron 环境：走 window.brandBleApi（主进程经 IPC 桥接，复用后端协议）。
//   2) 纯网页环境（Edge / Chrome 打开 localhost）：直接用浏览器原生 navigator.bluetooth。
//      因 localhost 属于安全上下文，Web Bluetooth 可用，无需 Electron 即可真机测试。
//
// 统一对外暴露：isSupported / scanAndConnect / disconnect / sendOps / readBattery。

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

// ============ 纯网页原生 Web Bluetooth 客户端 ============
class WebBluetoothV2Client {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private chars: Record<string, BluetoothRemoteGATTCharacteristic> = {};
  private batteryListener: ((value: number) => void) | null = null;

  isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth?.requestDevice;
  }

  async connect(): Promise<BrandBleMetadata> {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [V2_SERVICE] }],
      optionalServices: [V2_SERVICE],
    });
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => {
      this.server = null;
      this.chars = {};
    });
    const server = await device.gatt!.connect();
    this.server = server;
    const service = await server.getPrimaryService(V2_SERVICE);

    for (const key of Object.keys(V2_CHARS) as Array<keyof typeof V2_CHARS>) {
      const ch = await service.getCharacteristic(V2_CHARS[key]);
      this.chars[key] = ch;
      if (key === 'battery') {
        try {
          await ch.startNotifications();
          ch.addEventListener('characteristicvaluechanged', (ev) => {
            const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
            if (v && this.batteryListener) {
              this.batteryListener(v.getUint8(0));
            }
          });
        } catch (_) {
          /* 部分设备不支持 notify，忽略 */
        }
      }
    }

    const name = device.name || 'DG-LAB V2';
    return {
      id: `ble:${device.id}`,
      name,
      type: 'DGLAB',
      connectionType: 'brandBle',
      browserDeviceId: device.id,
      data: {},
    };
  }

  async sendOps(ops: GattOp[]): Promise<void> {
    for (const op of ops) {
      const ch = this.chars[op.characteristic];
      if (!ch) throw new Error(`未找到特征 ${op.characteristic}`);
      if ('read' in op && op.read) {
        await ch.readValue();
      } else {
        const buf = new Uint8Array(op.value as number[]);
        try {
          await ch.writeValueWithResponse(buf);
        } catch (_) {
          await ch.writeValue(buf);
        }
      }
    }
  }

  onBattery(cb: (value: number) => void): void {
    this.batteryListener = cb;
  }

  async disconnect(): Promise<void> {
    try { this.device?.gatt?.disconnect(); } catch (_) {}
    this.server = null;
    this.chars = {};
  }
}

const webClient: WebBluetoothV2Client | null =
  (typeof navigator !== 'undefined' && navigator.bluetooth) ? new WebBluetoothV2Client() : null;

function usingElectron(): boolean {
  return typeof window !== 'undefined' && !!window.brandBleApi && window.brandBleApi.isSupported();
}

export function isSupported(): boolean {
  if (usingElectron()) return true;
  return !!webClient?.isSupported();
}

/** 弹窗选设备并连接，返回元数据。Electron 与纯网页路径统一。 */
export async function scanAndConnect(): Promise<BrandBleMetadata> {
  if (usingElectron()) {
    return window.brandBleApi!.connect();
  }
  if (!webClient) throw new Error('当前环境不支持 Web Bluetooth 直连');
  const meta = await webClient.connect();
  return meta;
}

/** 兼容别名：便于调用方以 connect 语义直接使用。 */
export const connect = scanAndConnect;

export async function disconnect(id: string): Promise<{ ok: boolean }> {
  if (usingElectron()) {
    return window.brandBleApi!.disconnect(id);
  }
  await webClient?.disconnect();
  return { ok: true };
}

/** 下发一组 GATT 操作（强度 / 波形 / 读电量）。 */
export async function sendOps(ops: GattOp[]): Promise<{ ok: boolean }> {
  if (usingElectron()) {
    // Electron 路径经后端 brandBle:command；此处直接转发给后端 REST（复用 brandService）。
    // 注意：Electron 路径的控制实际经由 BrandsView 的 control 接口，这里仅兜底。
    throw new Error('Electron 路径请使用 control 接口');
  }
  await webClient!.sendOps(ops);
  return { ok: true };
}

export function onBattery(cb: (value: number) => void): () => void {
  if (usingElectron()) {
    // Electron 路径的电量由后端经 property 推送，前端另走 deviceService。
    return () => {};
  }
  webClient?.onBattery(cb);
  return () => { if (webClient) webClient.onBattery(() => {}); };
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
    : (n || 'DG-LAB V2');
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
