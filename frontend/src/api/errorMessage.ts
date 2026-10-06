// 后端错误码 → 界面文案（纯函数，便于 node 单测）。
// 远程模式下被控端的失败会以这些错误码回到本机页面：统一给出可读提示，而不是原始报文。
export const FRIENDLY_ERROR_KEYS: Record<string, string> = {
  REMOTE_LOCKED: 'remoteSession.lock.menu',
  DEVICE_WRITE_TIMEOUT: 'remoteSession.errors.hostNoResponse',
  PUBLISH_TIMEOUT: 'remoteSession.errors.hostNoResponse',
  COMMAND_TIMEOUT: 'remoteSession.errors.hostNoResponse',
  ROOM_DISCONNECTED: 'remoteSession.errors.hostNoResponse',
  HOST_PLAY_ACTIVE: 'remoteSession.errors.hostPlayActive',
  CONTROL_NOT_AUTHORIZED: 'remoteSession.errors.notAuthorized',
  CONTROL_EXPIRED: 'remoteSession.errors.expired',
  PLAY_PREEMPTED: 'remoteSession.errors.playPreempted',
  PLAY_OCCUPANCY_RELEASED: 'remoteSession.errors.occupancyReleased',
}

/** 读取错误对象上的后端错误码（空字符串视作没有） */
export function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code ? code : null
}

/** 把错误翻译成可读文案：命中错误码用 i18n 文案；否则用 error.message；再否则用 fallback（默认 remoteSession.commandFailed） */
export function friendlyMessage(
  error: unknown,
  t: (key: string) => string,
  fallback: string = t('remoteSession.commandFailed'),
): string {
  const code = errorCode(error)
  if (code && FRIENDLY_ERROR_KEYS[code]) return t(FRIENDLY_ERROR_KEYS[code])
  if (typeof error === 'string' && error) return error
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : null
  if (typeof message === 'string' && message) return message
  return fallback
}
