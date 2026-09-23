import { getToken } from './auth'
import type { GameRuntimeSnapshot } from './gameRuntime'

export interface RemoteGameStatus {
  active: boolean
  role?: 'owner' | 'operator'
  roomId?: string
  joinCode?: string | null
  connected?: boolean
  authorized?: boolean
  operatorOnline?: boolean
  games?: Array<{ id: string; title?: string; version?: string; runtimeMode?: string; params?: any[]; devices?: any[] }>
  devices?: Array<{ id: string; name?: string; type?: string; connected?: boolean; capabilities?: string[] }>
  snapshot?: GameRuntimeSnapshot | null
  lastError?: string | null
}

async function request(path: string, body?: unknown, method = 'POST'): Promise<any> {
  const token = getToken()
  const response = await fetch(`/api/remote-game${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error?.message || '远程游戏操作失败')
  return data
}

export const getRemoteGameStatus = () => request('/status', undefined, 'GET') as Promise<RemoteGameStatus>
export const createRemoteGame = () => request('/create', {}) as Promise<RemoteGameStatus>
export const joinRemoteGame = (joinCode: string) => request('/join', { joinCode }) as Promise<RemoteGameStatus>
export const authorizeRemoteGame = () => request('/authorize', {}) as Promise<RemoteGameStatus>
export const revokeRemoteGame = () => request('/revoke', {}) as Promise<RemoteGameStatus>
export const stopRemoteGame = () => request('/stop', {}) as Promise<RemoteGameStatus>
export const sendRemoteGameCommand = (type: string, payload?: unknown) => request('/command', { type, payload })
