// 状态流客户端（Vue 侧）：优先 SSE（snapshot 首帧 + patch 增量），失败回落轮询。
// 与游戏页 bridge 用同一套协议、同一份 apply 实现（src/play/gameStateStream.ts）；
// 纯逻辑（reduceStateEvent）已有单测，这里只做 EventSource / 定时器接线。
//
// 调用方约定：
//   onState(state)      —— 整份状态文档（与同名 REST 接口同构），替换式更新
//   onConnection(x)     —— 'live' | 'reconnecting'，用于显示重连提示
//   resync()            —— 主动补全量；远程模式由调用方发 game.snapshot.request，
//                          本机直接重开流（见 createGameStateStream 返回的 resync）

import { createStreamState, reduceStateEvent, type StreamState } from './gameStateStream.ts'

export interface GameStateStreamOptions {
  url: string
  // 回退轮询：返回整份状态文档
  poll: () => Promise<unknown>
  onState: (state: any) => void
  onConnection?: (connection: 'live' | 'reconnecting') => void
  pollMs?: number
  retryMs?: number
}

export interface GameStateStreamHandle {
  start: () => void
  stop: () => void
  resync: () => void
  rev: () => number
}

export function createGameStateStream(options: GameStateStreamOptions): GameStateStreamHandle {
  const pollMs = options.pollMs ?? 1000
  const retryMs = options.retryMs ?? 5000
  let source: EventSource | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let state: StreamState = createStreamState(null, 0)
  return { start, stop, resync, rev: () => state.rev }

  function deliver(next: StreamState) {
    state = next
    options.onState(state.state)
    options.onConnection?.('live')
  }

  function onFrame(event: MessageEvent) {
    let data: any = null
    try { data = JSON.parse(String(event.data)) } catch (_) { return }
    const result = reduceStateEvent(state, data)
    // 断档 / 坏帧：重开流补全量，期间保留旧状态继续渲染
    if (result.resync) { resync(); return }
    if (result.changed) deliver({ state: result.state, rev: result.rev })
  }

  function stopStream() {
    if (source) { try { source.close() } catch (_) {} }
    source = null
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  async function pollOnce() {
    try {
      const body = await options.poll()
      if (body && typeof body === 'object') options.onState(body)
      options.onConnection?.('live')
    } catch (_) {
      options.onConnection?.('reconnecting')
    }
  }

  function startPolling() {
    if (pollTimer) return
    void pollOnce()
    pollTimer = setInterval(() => { void pollOnce() }, pollMs)
  }

  function onStreamFailed() {
    stopStream()
    if (!started) return
    options.onConnection?.('reconnecting')
    startPolling()
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!started) return
      stopPolling()
      openStream()
    }, retryMs)
  }

  function openStream() {
    if (!started) return
    if (typeof EventSource !== 'function') { startPolling(); return }
    try {
      source = new EventSource(options.url)
    } catch (_) {
      source = null
      startPolling()
      return
    }
    source.addEventListener('snapshot', onFrame as EventListener)
    source.addEventListener('patch', onFrame as EventListener)
    source.onerror = onStreamFailed
  }

  function resync() {
    stopStream()
    openStream()
  }

  function start() {
    if (started) return
    started = true
    openStream()
  }

  function stop() {
    started = false
    stopStream()
    stopPolling()
  }
}
