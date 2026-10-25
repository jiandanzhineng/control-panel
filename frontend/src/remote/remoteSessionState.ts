// 远程会话的纯逻辑：状态 → 界面状态映射、轮询间隔、置灰路由、结束原因。
// 全部为纯函数，便于 node --experimental-strip-types --test 直接测（不依赖 Vue / DOM）。
import type { RemoteSessionPhase, RemoteSessionRole, RemoteSessionStatus } from './remoteSessionTypes'

export type SessionTone = 'ok' | 'warn' | 'pending' | 'off'

export interface RemoteUiState {
  phase: RemoteSessionPhase
  role: RemoteSessionRole | null
  /** 会话存在（waiting/pending/active/reconnecting） */
  live: boolean
  authorized: boolean
  isOwner: boolean
  isOperator: boolean
  /** 主控端且已进入远程模式（被控端设备已投影过来）：侧栏置灰与路由守卫据此生效 */
  isOperatorRemote: boolean
  /** 被控端且正被控制：显示操作记录与急停 */
  isHostControlled: boolean
  reconnecting: boolean
  ended: boolean
  tone: SessionTone
}

const LIVE_PHASES: RemoteSessionPhase[] = ['waiting', 'pending-authorization', 'active', 'reconnecting']

export function deriveUiState(status: RemoteSessionStatus | null | undefined): RemoteUiState {
  const phase: RemoteSessionPhase = status?.phase || 'idle'
  const role = status?.role || null
  const live = LIVE_PHASES.includes(phase)
  const authorized = !!status?.authorized
  const isOwner = live && role === 'owner'
  const isOperator = live && role === 'operator'
  const reconnecting = phase === 'reconnecting'
  return {
    phase,
    role,
    live,
    authorized,
    isOwner,
    isOperator,
    // 与后端 remoteSessionService.isOperatorRemoteMode() 同判据：已授权 + 投影房间已就位
    isOperatorRemote: isOperator && authorized && !!status?.links?.projection?.roomId,
    isHostControlled: isOwner && authorized,
    reconnecting,
    ended: phase === 'ended',
    tone: sessionTone(phase),
  }
}

/** 状态灯：已连接绿 / 重连中琥珀（脉冲）/ 待授权琥珀（静止）/ 断开红 */
export function sessionTone(phase: RemoteSessionPhase): SessionTone {
  if (phase === 'active') return 'ok'
  if (phase === 'reconnecting') return 'warn'
  if (phase === 'pending-authorization' || phase === 'waiting') return 'pending'
  return 'off'
}

/** 远程条文案键（remoteSession.bar.*）与按钮：待授权阶段不能说「正在控制」 */
export interface BarView {
  textKey: 'operator' | 'operatorPending' | 'host' | 'hostPending'
  tone: SessionTone
  /** 急停只在真的有人在控制时出现 */
  showEmergencyStop: boolean
  /** 主控端右侧按钮：待授权时是「取消」，已控制时是「断开」 */
  operatorStopKey: 'disconnect' | 'cancel'
}

export function barView(ui: RemoteUiState): BarView {
  if (ui.isOperator) {
    const pending = !ui.authorized
    return {
      textKey: pending ? 'operatorPending' : 'operator',
      tone: pending && !ui.reconnecting ? 'pending' : ui.tone,
      showEmergencyStop: !pending,
      operatorStopKey: pending ? 'cancel' : 'disconnect',
    }
  }
  const controlled = ui.isHostControlled
  return {
    textKey: controlled ? 'host' : 'hostPending',
    tone: controlled || ui.reconnecting ? ui.tone : 'pending',
    showEmergencyStop: controlled,
    operatorStopKey: 'disconnect',
  }
}

/** 远程条是否显示：主控端等待授权/连接中也要看得见，被控端只在有人控制时出现 */
export function barVisible(ui: RemoteUiState): boolean {
  if (ui.isOperator) return true
  if (ui.isOwner) return ui.isHostControlled || ui.phase === 'pending-authorization'
  return false
}

/** 轮询间隔：active/reconnecting 1s，其他 3s，页面不可见 5s */
export function pollIntervalMs(phase: RemoteSessionPhase, hidden: boolean): number {
  if (hidden) return 5000
  return phase === 'active' || phase === 'reconnecting' ? 1000 : 3000
}

/** 自动跳设备页的记忆：已经为哪段会话跳过 */
export interface AutoNavigateMemo {
  handledKey: string | null
}

/**
 * 主控端授权成功（进入远程模式）的那一刻自动跳 /devices 一次。
 * 按会话 id 记：上一段会话结束后界面没轮询到 idle（后台窗口节流、直接加入新房间）也不会漏跳；
 * 在 /remote 页等授权是最常见的情况，同样要跳。已在设备页就不跳。返回要跳的路径或 null（会修改 memo）。
 */
export function stepAutoNavigate(
  memo: AutoNavigateMemo,
  ui: RemoteUiState,
  sessionId: string | null | undefined,
  path: string,
): string | null {
  if (!ui.live) { memo.handledKey = null; return null }
  if (!ui.isOperatorRemote) return null
  const key = sessionId || '(no-session-id)'
  if (memo.handledKey === key) return null
  memo.handledKey = key
  return String(path || '').startsWith('/devices') ? null : '/devices'
}
