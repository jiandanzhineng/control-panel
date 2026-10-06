// 远程会话的状态类型与空状态（不依赖任何模块，便于 node 测试与界面共用）。
export type RemoteSessionRole = 'owner' | 'operator'

export type RemoteSessionPhase =
  | 'idle'
  | 'waiting'
  | 'pending-authorization'
  | 'active'
  | 'reconnecting'
  | 'ended'

export type RemoteLogOutcome = 'ok' | 'clamped' | 'rejected'

export interface RemoteSessionPeer {
  userId: string
  nickname: string | null
}

export interface RemoteSessionLogEntry {
  ts: number
  userId: string | null
  kind: string
  target: string | null
  summary: string
  outcome: RemoteLogOutcome
  detail: Record<string, any> | null
}

export interface RemotePlayOccupancy {
  gameId: string
  gameName?: string | null
  at?: number
}

export interface RemoteSessionStatus {
  active: boolean
  role: RemoteSessionRole | null
  phase: RemoteSessionPhase
  joinCode: string | null
  peer: RemoteSessionPeer | null
  authorized: boolean
  links: {
    game: { connected: boolean }
    projection: { connected: boolean; roomId: string | null }
  }
  latencyMs: number | null
  lastError: string | null
  log: RemoteSessionLogEntry[]
  /** 主控端玩法在被控端的登记（仅 owner 有意义） */
  occupancy?: RemotePlayOccupancy | null
  /** 主控端本机玩法（由被控端记录） */
  localPlay?: RemotePlayOccupancy | null
  /** 主控端玩法是「怎么没的」：host-local-play = 被被控端本地玩法顶替，其余 = 被控端结束/急停 */
  playEndedReason?: string | null
}

export const EMPTY_REMOTE_SESSION_STATUS: RemoteSessionStatus = {
  active: false,
  role: null,
  phase: 'idle',
  joinCode: null,
  peer: null,
  authorized: false,
  links: { game: { connected: false }, projection: { connected: false, roomId: null } },
  latencyMs: null,
  lastError: null,
  log: [],
  occupancy: null,
  localPlay: null,
  playEndedReason: null,
}
