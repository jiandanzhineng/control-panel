import { getToken } from './auth'
import type { GameRuntimeSnapshot } from './gameRuntime'

export interface RemoteGameOperator {
  userId: string
  online: boolean
  authorized: boolean
}

export interface RemoteGameMember {
  userId: string
  role?: string
  status?: string
}

export interface RemoteGameStatus {
  active: boolean
  role?: 'owner' | 'operator'
  roomId?: string
  joinCode?: string | null
  connected?: boolean
  authorized?: boolean
  operatorOnline?: boolean
  operators?: RemoteGameOperator[]
  members?: RemoteGameMember[]
  gameSessionId?: string | null
  operatorUserId?: string | null
  waitingForHost?: boolean
  games?: Array<{ id: string; title?: string; version?: string; runtimeMode?: string; params?: any[]; devices?: any[] }>
  devices?: Array<{ id: string; name?: string; type?: string; connected?: boolean; capabilities?: string[] }>
  snapshot?: GameRuntimeSnapshot | null
  lastError?: string | null
}

// 前端请求必须有超时，否则后端卡住时按钮会一直 loading
const REQUEST_TIMEOUT_MS = 12000

async function request(path: string, body?: unknown, method = 'POST'): Promise<any> {
  const token = getToken()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`/api/remote-game${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error: any) {
    throw new Error(error?.name === 'AbortError' ? '请求超时，请重试' : '无法连接本机后端')
  } finally {
    clearTimeout(timer)
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error: any = new Error(data?.error?.message || '远程游戏操作失败')
    error.code = data?.error?.code
    throw error
  }
  return data
}

export const getRemoteGameStatus = () => request('/status', undefined, 'GET') as Promise<RemoteGameStatus>
export const createRemoteGame = () => request('/create', {}) as Promise<RemoteGameStatus>
export const joinRemoteGame = (joinCode: string) => request('/join', { joinCode }) as Promise<RemoteGameStatus>
export const authorizeRemoteGame = () => request('/authorize', {}) as Promise<RemoteGameStatus>
export const revokeRemoteGame = () => request('/revoke', {}) as Promise<RemoteGameStatus>
export const stopRemoteGame = () => request('/stop', {}) as Promise<RemoteGameStatus>
export const getRemoteGameRoom = () => request('/room', undefined, 'GET') as Promise<{ members: RemoteGameMember[] }>
export const kickRemoteGameMember = (userId: string) => request('/kick', { userId }) as Promise<RemoteGameStatus>
export const sendRemoteGameCommand = (type: string, payload?: unknown) => request('/command', { type, payload })
