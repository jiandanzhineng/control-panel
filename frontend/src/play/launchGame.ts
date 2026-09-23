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
    throw new Error(data?.error?.message || '启动失败')
  }
  return data
}
