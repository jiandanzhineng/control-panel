export interface GameRuntimeSnapshot {
  version?: string
  gameId?: string
  title?: string
  running?: boolean
  paused?: boolean
  ended?: boolean
  phase?: string
  phaseText?: string
  currentPressure?: number
  averagePressure?: number
  midPressure?: number
  criticalPressure?: number
  currentIntensity?: number
  targetIntensity?: number
  edgingCount?: number
  shockCount?: number
  totalStimulationTime?: number
  params?: Record<string, unknown>
  logs?: Array<{ level?: string; message: string; atMs?: number }>
}

export interface GameRuntimeStatus {
  active?: boolean
  running?: boolean
  ended?: boolean
  runtimeMode?: string | null
  sessionId?: string
  gameId?: string
  snapshot?: GameRuntimeSnapshot | null
}

async function request(path: string, body?: unknown) {
  const response = await fetch(`/api/game-runtime${path}`, {
    method: body === undefined && path === '/status' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error?.message || '游戏运行请求失败')
  return data
}

export const getGameRuntimeStatus = () => request('/status') as Promise<GameRuntimeStatus>

export const startGameRuntime = (body: {
  gameId: string
  deviceMap?: Record<string, string[]>
  params?: Record<string, unknown>
}) => request('/start', body)

export const setGameRuntimeParams = (params: Record<string, unknown>) => request('/params', { params })

export const sendGameRuntimeAction = (action: string, payload?: unknown) => request('/action', { action, payload })

export const stopGameRuntime = (reason = 'user_stop') => request('/stop', { reason })

export async function listHostGames() {
  const response = await fetch('/api/game-runtime/games')
  const data = await response.json().catch(() => [])
  return Array.isArray(data) ? data : []
}
