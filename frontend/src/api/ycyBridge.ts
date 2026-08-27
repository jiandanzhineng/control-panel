// YCY 原生蓝牙桥 REST 客户端。
// 桥由跨平台 Rust 二进制 tools/ycy_bridge(.exe) 提供（取代原 macOS Swift 桥），监听 127.0.0.1:3001，
// 已开启 CORS (Access-Control-Allow-Origin: *)；故前端在 dev / Electron 下均可直接访问，无需后端中转。
// 桥协议为 HTTP REST（非 WebSocket），与 backend/brands/ycyConnection.js 的 WebSocket 桥接不同。
// Windows 走 WinRT / macOS 走 CoreBluetooth / Linux 走 BlueZ，由 btleplug 自动选择，前端无感知。

const BRIDGE_BASE = 'http://127.0.0.1:3001'

export interface YcyBridgeChar {
  uuid: string
  props: string[]
}
export interface YcyBridgeService {
  uuid: string
  chars: YcyBridgeChar[]
}
export interface YcyBridgeDevice {
  id: string
  name: string
  rssi: number
  ready: boolean
  battery?: number | null
  isTarget?: boolean
  connection?: { service?: string; write?: string; notify?: string }
  services?: YcyBridgeService[]
}
export interface YcyBridgeStatus {
  bluetoothOn: boolean
  explicitAddr?: string
  devices: YcyBridgeDevice[]
  notifications?: Record<string, string[]>
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BRIDGE_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!resp.ok) {
    let msg = `YCY 桥请求失败 (${resp.status})`
    try {
      const body = await resp.json()
      if (body?.msg) msg = body.msg as string
    } catch (_) {
      /* 解析失败保持默认信息 */
    }
    throw new Error(msg)
  }
  return resp.json() as Promise<T>
}

export function getStatus() {
  return req<YcyBridgeStatus>('/api/status')
}
export function listDevices() {
  return req<{ devices: YcyBridgeDevice[] }>('/api/devices')
}
export function rescan() {
  return req<{ ok: boolean; msg: string }>('/api/rescan', { method: 'POST' })
}
export function connect(addr = '') {
  const q = addr ? `?addr=${encodeURIComponent(addr)}` : ''
  return req<{ ok: boolean; id?: string; msg: string }>(`/api/connect${q}`, { method: 'POST' })
}
export function disconnect(addr = '') {
  const q = addr ? `?addr=${encodeURIComponent(addr)}` : ''
  return req<{ ok: boolean; msg: string }>(`/api/disconnect${q}`, { method: 'POST' })
}
