// 远程会话的文案格式化（纯函数）：对方显示名、时间、结果详情。
import type { RemoteSessionLogEntry, RemoteSessionPeer } from './remoteSessionTypes'

/** 对方显示名：优先昵称，其次用户 ID 后 6 位 */
export function peerLabel(peer: RemoteSessionPeer | null | undefined): string {
  if (!peer) return ''
  const nickname = String(peer.nickname || '').trim()
  if (nickname) return nickname
  const userId = String(peer.userId || '')
  return userId ? userId.slice(-6) : ''
}

/** 操作记录时间：HH:mm:ss */
export function formatClock(ts: number | null | undefined): string {
  const value = Number(ts)
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 结果标签的悬停详情（被限制/被拒绝时的原因） */
export function detailText(entry: RemoteSessionLogEntry | null | undefined): string {
  const detail = entry?.detail
  if (!detail) return ''
  const message = String(detail.message || detail.code || '')
  return message
}
