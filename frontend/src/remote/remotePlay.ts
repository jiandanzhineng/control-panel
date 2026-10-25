// 主控端本机玩法占用的纯逻辑（占用被顶替的判定），便于 node 单测。
export interface RemotePlayRef { gameId: string; gameName?: string | null }

/** 被顶替判定：上一次有玩法、这一次没有 → 返回上一次的玩法（调用方据此停掉本机游戏并提示）；否则 null */
export function preemptedLocalPlay(
  previous: RemotePlayRef | null | undefined,
  next: RemotePlayRef | null | undefined,
): RemotePlayRef | null {
  return previous && !next ? previous : null
}

/** 玩法显示名：《X》优先 gameName，其次 gameId；都没有返回空串 */
export function playLabel(ref: RemotePlayRef | null | undefined): string {
  if (!ref) return ''
  return ref.gameName || ref.gameId || ''
}

/**
 * 前端是否需要自己登记玩法占用：只有被控端看不到载体的玩法（插件、外部代理游戏）。
 * 页面式游戏与 HostRuntime 由后端启动接口（/api/games/:id/start、/api/game-runtime/start）
 * 在启动前登记，保证「被拒 ⇒ 一定没启动」；前端再登记一次会在被拒时先失败、语义重复。
 */
export function needsFrontendOccupy(carrierType: string | null | undefined): boolean {
  return String(carrierType || '') !== 'game'
}

/** 主控端玩法被结束时选提示文案：被控端本地玩法顶替 ≠ 被控端主动结束/急停。 */
export function playEndedMessageKey(reason: string | null | undefined): string {
  return reason === 'host-local-play' ? 'remoteSession.play.preempted' : 'remoteSession.play.ended'
}
