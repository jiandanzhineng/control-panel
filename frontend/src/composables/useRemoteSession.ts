// 远程会话全局状态（模块级单例）：远程条、远程连接页、侧栏置灰与路由守卫共用一份。
// 轮询 GET /api/remote-session/status：active/reconnecting 1s，其他 3s，页面不可见 5s。
import { computed, reactive } from 'vue'
import * as api from '../api/remoteSession'
import type { RemoteSessionLogEntry, RemoteSessionStatus } from '../api/remoteSession'
import { deriveUiState, pollIntervalMs } from '../remote/remoteSessionState'
import { isLivePhase, shouldFireEnded } from '../remote/remoteEnded'

interface RemoteSessionStoreState {
  status: RemoteSessionStatus
  /** 会话结束后的状态里 role 会被后端清空，界面仍需要知道刚才是什么身份 */
  lastRole: RemoteSessionStatus['role']
  loaded: boolean
  busy: boolean
  error: string | null
  /** 最近一次结束：远程条据此弹「远程已结束」，弹过即清 */
  endedReason: string | null
  endedAt: number
}

const state = reactive<RemoteSessionStoreState>({
  status: { ...api.EMPTY_REMOTE_SESSION_STATUS },
  lastRole: null,
  loaded: false,
  busy: false,
  error: null,
  endedReason: null,
  endedAt: 0,
})

let timer: ReturnType<typeof setTimeout> | null = null
let started = false
let inflight = false
/** 结束提示闸门（见 remote/remoteEnded.ts） */
const gate = { wasLive: false, handledReason: null as string | null }
/** 结束那一刻的身份（ended 状态里 role 已被后端清空） */
let endedRole: RemoteSessionStatus['role'] = null

/** 结束状态会被轮询反复读到：只有从「进行中」再次进入 ended 才算新的一次 */
function applyStatus(next: RemoteSessionStatus | null | undefined) {
  if (!next) return
  state.status = next
  state.loaded = true
  if (next.role) state.lastRole = next.role
  if (next.phase === 'ended') {
    const reason = next.lastError || 'ended'
    if (shouldFireEnded(gate, next.phase, reason)) {
      gate.handledReason = reason
      state.endedReason = reason
      state.endedAt = Date.now()
      endedRole = state.lastRole
    }
    gate.wasLive = false
    return
  }
  gate.wasLive = isLivePhase(next.phase)
  gate.handledReason = null
  state.endedReason = null
  state.endedAt = 0
}

function scheduleNext() {
  if (timer) clearTimeout(timer)
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  const delay = pollIntervalMs(state.status.phase, hidden)
  timer = setTimeout(() => { void refresh() }, delay)
}

async function refresh(): Promise<void> {
  if (inflight) return
  inflight = true
  try {
    applyStatus(await api.getRemoteSessionStatus())
    state.error = null
  } catch (error: any) {
    state.error = error?.message || '远程会话状态获取失败'
  } finally {
    inflight = false
    if (started) scheduleNext()
  }
}

function onVisibilityChange() {
  if (!started) return
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') void refresh()
  else scheduleNext()
}

/** 首个使用方挂载时启动轮询（幂等） */
function start(): void {
  if (started) return
  started = true
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  void refresh()
}

/** 最后一个使用方卸载时停止（幂等） */
function stop(): void {
  if (!started) return
  started = false
  if (timer) clearTimeout(timer)
  timer = null
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

async function run<T>(action: () => Promise<T>): Promise<T | null> {
  state.busy = true
  try {
    const result = await action()
    state.error = null
    return result
  } catch (error: any) {
    state.error = error?.message || '远程会话操作失败'
    throw error
  } finally {
    state.busy = false
    void refresh()
  }
}

/** 结束提示弹过一次后清掉，避免路由切换时重复弹 */
function clearEnded(): void {
  state.endedReason = null
  state.endedAt = 0
}

const ui = computed(() => deriveUiState(state.status))
const isOperatorRemote = computed(() => ui.value.isOperatorRemote)
const isHostControlled = computed(() => ui.value.isHostControlled)

export function useRemoteSession() {
  return {
    status: computed(() => state.status),
    ui,
    loaded: computed(() => state.loaded),
    busy: computed(() => state.busy),
    error: computed(() => state.error),
    endedReason: computed(() => state.endedReason),
    endedAt: computed(() => state.endedAt),
    /** 结束那一刻的身份（ended 状态里 role 已被后端清空） */
    endedRole: computed(() => endedRole),
    role: computed(() => state.status.role),
    phase: computed(() => state.status.phase),
    peer: computed(() => state.status.peer),
    authorized: computed(() => state.status.authorized),
    log: computed<RemoteSessionLogEntry[]>(() => state.status.log || []),
    latencyMs: computed(() => state.status.latencyMs),
    joinCode: computed(() => state.status.joinCode),
    occupancy: computed(() => state.status.occupancy ?? null),
    localPlay: computed(() => state.status.localPlay ?? null),
    playEndedReason: computed(() => state.status.playEndedReason ?? null),
    isOperatorRemote,
    isHostControlled,
    start,
    stop,
    refresh,
    clearEnded,
    create: () => run(() => api.createRemoteSession()),
    join: (joinCode: string) => run(() => api.joinRemoteSession(joinCode)),
    authorize: (userId?: string) => run(() => api.authorizeRemoteSession(userId)),
    revoke: () => run(() => api.revokeRemoteSession()),
    kick: (userId: string) => run(() => api.kickRemoteSession(userId)),
    emergencyStop: () => run(() => api.emergencyStopRemoteSession()),
    stopSession: (reason?: string) => run(() => api.stopRemoteSession(reason)),
    occupyPlay: (gameId: string, gameName?: string) => run(() => api.occupyRemotePlay(gameId, gameName)),
    releasePlay: (gameId?: string) => run(() => api.releaseRemotePlay(gameId)),
  }
}
