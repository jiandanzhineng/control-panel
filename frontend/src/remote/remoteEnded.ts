// 会话结束（被踢/撤销/对方结束/离线）的原因映射与一次性提示闸门。
// 结束原因来自后端 remoteSessionService.lastEnded.reason 或 remoteGameService 的 ended 事件。
// 提示只弹一次：同一段 ended 状态会被轮询反复读到。
import type { RemoteSessionPhase } from './remoteSessionTypes'

/** 结束原因 → i18n key 后缀（remoteSession.end.*）；'none' = 本端主动断开，不提示 */
export function endReasonKey(reason: string | null | undefined): string {
  const value = String(reason || '').trim()
  switch (value) {
    case 'kicked':
      return 'kicked'
    case 'revoked':
    case 'session-revoked':
    case 'operator-left-room':
      return 'revoked'
    case 'session-stop':
    case 'room-closed':
    case 'session-ended':
    // 被控端主动结束会话（remoteSessionService.stop）会把同一个 reason 透传过来，
    // 它本质上就是「对方已结束远程」，不能落到 default 的「连接已断开」。
    case 'session-stop-by-host':
      return 'ended'
    // 本端自己断开 / 被新会话顶替：用户刚点的按钮，不再弹提示也不跳页
    case 'operator-stop':
    case 'host-stop':
    case 'session-create-failed':
    case 'replaced':
      return 'none'
    default:
      return 'offline'
  }
}

export interface EndedGate {
  /** 本次启动是否见过活跃会话：首次加载就撞上历史的 ended 时不打扰用户 */
  wasLive: boolean
  /** 已经提示过的结束原因（后端没给会话 id 时的退路） */
  handledReason: string | null
  /** 最近一次见到的活跃会话 id */
  liveSessionId?: string | null
  /** 已经提示过的会话 id */
  handledSessionId?: string | null
}

export function isLivePhase(phase: RemoteSessionPhase): boolean {
  return phase === 'waiting' || phase === 'pending-authorization' || phase === 'active' || phase === 'reconnecting'
}

/**
 * 结束提示闸门：同一段 ended 会被轮询反复读到，只有「见过活跃会话」后的第一次才提示；
 * 有会话 id 时只提示刚才在跑的那一段（别的会话的 ended 不弹）。
 */
export function shouldFireEnded(
  gate: EndedGate,
  phase: RemoteSessionPhase,
  reason: string | null,
  sessionId?: string | null,
): boolean {
  if (phase !== 'ended' || !gate.wasLive) return false
  if (sessionId) {
    if (gate.liveSessionId && gate.liveSessionId !== sessionId) return false
    return gate.handledSessionId !== sessionId
  }
  return gate.handledReason !== reason
}

/**
 * 每读到一次状态推进一次闸门，返回这次是否要弹结束提示（会修改 gate）。
 * 轮询顺序：活跃(会话 A) → ended(A) 弹一次 → 活跃(会话 B) → ended(B) 再弹一次；
 * ended(A) 在会话 B 已活跃后才读到（迟到）不会弹。
 */
export function stepEndedGate(
  gate: EndedGate,
  phase: RemoteSessionPhase,
  reason: string | null,
  sessionId?: string | null,
): boolean {
  if (phase === 'ended') {
    const fire = shouldFireEnded(gate, phase, reason, sessionId)
    if (fire) {
      gate.handledReason = reason
      gate.handledSessionId = sessionId || null
    }
    gate.wasLive = false
    return fire
  }
  gate.wasLive = isLivePhase(phase)
  if (gate.wasLive) gate.liveSessionId = sessionId || null
  gate.handledReason = null
  return false
}

/**
 * 结束提示是否已过时：提示还开着时又开始了新会话（或者已经回到活跃状态），
 * 旧提示要关掉，也不能再把用户从新会话里拉回 /remote。
 */
export function isStaleEndedNotice(
  endedSessionId: string | null | undefined,
  current: { phase: RemoteSessionPhase; sessionId?: string | null },
): boolean {
  if (!isLivePhase(current.phase)) return false
  return !endedSessionId || !current.sessionId || current.sessionId !== endedSessionId
}

/** 结束提示由远程条负责（主控端随后回 /remote）；已经在远程连接页就不再跳 */
export function shouldAutoReturn(role: string | null | undefined, path: string): boolean {
  return role === 'operator' && String(path || '') !== '/remote'
}
