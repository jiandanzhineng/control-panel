import { isHostRuntime } from './gameRuntimeSession'

export { isHostRuntime }

export async function requestGameStart(
  id: string,
  deviceMapping: Record<string, unknown>,
  parameters: Record<string, unknown>,
  defer = false,
  extra: { gamePath?: string; externalUrl?: string } = {},
) {
  const response = await fetch(`/api/games/${encodeURIComponent(id)}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceMapping, parameters, source: 'local', defer, ...extra }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    // 错误码透出给界面：远程模式下被控端本地玩法在跑时会以 HOST_PLAY_ACTIVE 拒绝启动
    const error: any = new Error(data?.error?.message || '启动失败')
    error.code = data?.error?.code
    throw error
  }
  return data
}
