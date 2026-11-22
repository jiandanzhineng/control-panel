// 远程会话 API 客户端：打本地后端 /api/remote-session/*（编排层：主房间 + 设备投影双链路）。
// request 风格与 api/remoteGame.ts 一致：Bearer token + 超时 + 错误码透出。
// 状态类型放 remote/remoteSessionTypes.ts（纯类型模块，便于单测与界面共用）。
import { getToken } from './auth'
import type { RemoteSessionStatus } from '../remote/remoteSessionTypes'

export type {
  RemoteLogOutcome,
  RemoteSessionLogEntry,
  RemoteSessionPeer,
  RemoteSessionPhase,
  RemoteSessionRole,
  RemoteSessionStatus,
} from '../remote/remoteSessionTypes'
export { EMPTY_REMOTE_SESSION_STATUS } from '../remote/remoteSessionTypes'

// 前端请求必须有超时，否则后端卡住时按钮会一直 loading
const REQUEST_TIMEOUT_MS = 12000

async function request(path: string, body?: unknown, method = 'POST'): Promise<any> {
  const token = getToken()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`/api/remote-session${path}`, {
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
    const error: any = new Error(data?.error?.message || '远程会话操作失败')
    error.code = data?.error?.code
    throw error
  }
  return data
}

export const getRemoteSessionStatus = () => request('/status', undefined, 'GET') as Promise<RemoteSessionStatus>

// 远程输出上限（被控端自己设的电压上限，A 改不了）：默认 20，范围 0–100
export interface RemoteOutputLimits {
  limits: { voltage: number; power: number; intensity: number }
  voltage: number
  range: { min: number; max: number }
  defaults: { voltage: number; power: number; intensity: number }
}

export const getRemoteOutputLimits = () =>
  request('/output-limits', undefined, 'GET') as Promise<RemoteOutputLimits>

export const setRemoteOutputLimit = (voltage: number) =>
  request('/output-limits', { voltage }, 'PUT') as Promise<RemoteOutputLimits>
export const createRemoteSession = () => request('/create', {}) as Promise<RemoteSessionStatus>
export const joinRemoteSession = (joinCode: string) => request('/join', { joinCode }) as Promise<RemoteSessionStatus>
export const authorizeRemoteSession = (userId?: string) => request('/authorize', { userId }) as Promise<RemoteSessionStatus>
export const revokeRemoteSession = () => request('/revoke', {}) as Promise<RemoteSessionStatus>
export const kickRemoteSession = (userId: string) => request('/kick', { userId }) as Promise<RemoteSessionStatus>
export const emergencyStopRemoteSession = () => request('/emergency-stop', {}) as Promise<RemoteSessionStatus>
export const stopRemoteSession = (reason?: string) => request('/stop', { reason }) as Promise<RemoteSessionStatus>
export const occupyRemotePlay = (gameId: string, gameName?: string) =>
  request('/play/occupy', { gameId, gameName }) as Promise<{ ok: boolean; gameId: string; gameName?: string }>
export const releaseRemotePlay = (gameId?: string) => request('/play/release', { gameId }) as Promise<{ ok: boolean }>
