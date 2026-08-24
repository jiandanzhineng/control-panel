// 设备 API 客户端：打本地后端 /api/devices、/api/device-types、/api/serial 等。
// 与 api/brands.ts 保持同一风格（request<T> 语义化封装），统一前端 API 层。
// 注：DevicesView 历史使用散落 fetch；此处逐步收敛高频调用，其余保留 fetch 待渐进迁移。

export interface DeviceConnection {
  type: string;
  connected?: boolean;
  portPath?: string;
  firmwareVersion?: string;
  legacyIdentity?: boolean;
  [key: string]: unknown;
}

export interface Device {
  id: string;
  name?: string;
  type?: string;
  connectionType?: string;
  connections?: DeviceConnection[];
  connected?: boolean;
  data?: Record<string, unknown>;
  lastReport?: number;
  [key: string]: unknown;
}

export interface DeviceTypeInfo {
  type: string;
  name: string;
  capabilities?: unknown;
  operations?: unknown[];
  [key: string]: unknown;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!resp.ok) {
    let msg = `请求失败 (${resp.status})`;
    try {
      const body = await resp.json();
      if (body?.error) msg = body.error;
      else if (body?.message) msg = body.message;
    } catch (_) {}
    throw new Error(msg);
  }
  return resp.json() as Promise<T>;
}

// ---- 设备列表 ----
export function listDevices(): Promise<Device[]> {
  return request<Device[]>('/api/devices');
}

export function getDevice(id: string): Promise<Device> {
  return request<Device>(`/api/devices/${encodeURIComponent(id)}`);
}

export function deleteDevice(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function deleteAllDevices(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/devices/all', { method: 'DELETE' });
}

// ---- 控制 / 消息 / 操作 ----
export function setControlConnection(id: string, type: string): Promise<unknown> {
  return request(`/api/devices/${encodeURIComponent(id)}/control-connection`, {
    method: 'POST',
    body: JSON.stringify({ type }),
  });
}

export function sendDeviceMessage(id: string, message: unknown): Promise<unknown> {
  return request(`/api/devices/${encodeURIComponent(id)}/message`, {
    method: 'POST',
    body: JSON.stringify(message),
  });
}

export function executeDeviceOperation(id: string, opKey: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  return request(`/api/devices/${encodeURIComponent(id)}/operations/${encodeURIComponent(opKey)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateDeviceNickname(id: string, nickname: string): Promise<unknown> {
  return request(`/api/devices/${encodeURIComponent(id)}/nickname`, {
    method: 'POST',
    body: JSON.stringify({ nickname }),
  });
}

// ---- 设备类型 ----
export function getDeviceTypes(): Promise<DeviceTypeInfo[]> {
  return request<DeviceTypeInfo[]>('/api/device-types');
}

export function getDeviceTypeConfigs(): Promise<Record<string, DeviceTypeInfo>> {
  return request<Record<string, DeviceTypeInfo>>('/api/device-types/configs');
}
