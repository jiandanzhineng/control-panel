// 郊狼（DG-LAB Coyote）原生蓝牙桥 REST 客户端。
// 桥由 tools/dglab_bridge.swift 提供，监听 127.0.0.1:3002，已开启 CORS
// (Access-Control-Allow-Origin: *)；前端在 dev / Electron 下均可直接访问，无需后端中转。
// 与 ycyBridge.ts 同思路：用 CoreBluetooth 真正连接设备，绕过 macOS Web Bluetooth
// 对自定义 GATT 的 "No Services found" 限制（Coyote 3.0 在 Chrome 下连上后枚举不到服务）。
// 桥自动发现真实 SERVICE/CHAR UUID 并读取电量，浏览器通过 localhost 取数据。

const BRIDGE_BASE = 'http://127.0.0.1:3002'

export interface DglabBridgeDevice {
  id: string
  name: string
  rssi: number
  ready: boolean
  isTarget?: boolean
  battery: number | null
}

export interface DglabBridgeStatus {
  bluetoothOn: boolean
  explicitAddr?: string
  devices: DglabBridgeDevice[]
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BRIDGE_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!resp.ok) {
    let msg = `郊狼桥请求失败 (${resp.status})`
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
  return req<DglabBridgeStatus>('/api/status')
}
export function listDevices() {
  return req<{ devices: DglabBridgeDevice[] }>('/api/devices')
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
