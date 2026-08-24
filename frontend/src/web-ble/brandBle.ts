// 封装渲染进程注入的 window.brandBleApi（DG-LAB 原版 V2 Web Bluetooth 直连）。
// 该 API 由 electron/preload.js 在 Electron 环境下挂载；纯网页环境（非打包）不可用。

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

export function isSupported(): boolean {
  return typeof window !== 'undefined' && !!window.brandBleApi?.isSupported?.();
}

export function connect(): Promise<BrandBleMetadata> {
  if (!window.brandBleApi) return Promise.reject(new Error('当前环境不支持 Web Bluetooth 直连'));
  return window.brandBleApi.connect();
}

export function disconnect(id: string): Promise<{ ok: boolean }> {
  if (!window.brandBleApi) return Promise.resolve({ ok: true });
  return window.brandBleApi.disconnect(id);
}

export function onScanResults(cb: (devices: BrandBleCandidate[]) => void): () => void {
  if (!window.brandBleApi?.onScanResults) return () => {};
  return window.brandBleApi.onScanResults(cb);
}

export function selectDevice(deviceId: string): Promise<{ ok: boolean }> {
  if (!window.brandBleApi) return Promise.resolve({ ok: true });
  return window.brandBleApi.selectDevice(deviceId);
}

export function cancelSelection(): Promise<{ ok: boolean }> {
  if (!window.brandBleApi?.cancelSelection) return Promise.resolve({ ok: true });
  return window.brandBleApi.cancelSelection();
}
