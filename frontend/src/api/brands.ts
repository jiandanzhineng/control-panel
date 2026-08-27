// 品牌设备 API 客户端：打本地后端 /api/brands/*。

export interface BrandDevice {
  deviceId: string;
  brand: 'dglab' | 'ycy';
  brandLabel?: string;
  mode?: string;
  kind?: string;
  type?: string;
  typeLabel?: string;
  name?: string;
  connected: boolean;
  metadata?: Record<string, unknown>;
}

export interface BrandStatus {
  supported: string[];
  activeCount: number;
  devices: BrandDevice[];
}

export interface DiscoverCandidate {
  brand: string;
  reachable?: boolean;
  error?: string;
  host?: string;
  port?: number;
  suggestedDeviceId?: string;
  suggestedName?: string;
  deviceId?: string;
  name?: string;
  address?: string;
  rssi?: number;
  mode?: string;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`/api/brands${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!resp.ok) {
    let msg = `请求失败 (${resp.status})`;
    try {
      const body = await resp.json();
      if (body?.error) msg = body.error;
    } catch (_) {}
    throw new Error(msg);
  }
  return resp.json() as Promise<T>;
}

export function getStatus() {
  return request<BrandStatus>('/status');
}

export function listDevices() {
  return request<BrandDevice[]>('/');
}

export function discover(brand: string, params: Record<string, string | number> = {}) {
  const qs = new URLSearchParams({ brand, ...Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ) }).toString();
  return request<{ brand: string; count: number; devices: DiscoverCandidate[] }>(`/discover?${qs}`);
}

export function connect(payload: Record<string, unknown>) {
  return request<{ device: unknown; connection: unknown; brand: string; type: string }>('/connect', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function disconnect(deviceId: string) {
  return request<{ ok: boolean }>(`/${encodeURIComponent(deviceId)}/disconnect`, { method: 'POST' });
}

// 原版 V2 强度位布局（标定用）
export function getV2Layout() {
  return request<{ layout: 'official' | 'coyote2'; options: string[] }>('/v2-layout');
}

export function setV2Layout(layout: 'official' | 'coyote2') {
  return request<{ layout: 'official' | 'coyote2'; options: string[] }>('/v2-layout', {
    method: 'POST',
    body: JSON.stringify({ layout }),
  });
}
