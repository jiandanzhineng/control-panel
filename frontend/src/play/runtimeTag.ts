// 游戏卡片上的「远程延迟」标签判定（纯逻辑，便于 node 单测）。
// 依据：docs/plans/2026-10-06-remote-session-mode.md §4.5 —— 分离式游戏（runtime: host）
// 的逻辑跑在设备所在端，远程时设备反馈不经网络；页面式游戏在主控端跑，远程时有延迟。
export interface RuntimeTag {
  /** i18n key：标签文案 */
  key: string
  /** i18n key：tooltip 文案 */
  tipKey: string
  /** true = 强调色（无延迟），false = 弱化色（有延迟） */
  accent: boolean
}

export interface RuntimeTagInput {
  /** 是否为游戏卡片（插件 / 本地应用不显示该标签） */
  isGame: boolean
  /** 是否为分离式（runtime: host）游戏：逻辑在被控端跑 */
  isHostRuntime: boolean
  /** 当前是否为「主控端远程」模式 */
  isOperatorRemote: boolean
}

/**
 * 返回该游戏卡片应显示的标签；不显示时返回 null。
 * - 非游戏载体：永不显示
 * - 分离式游戏：始终显示「远程无延迟」（本机游玩时也说明逻辑跟着设备走）
 * - 页面式游戏：仅主控端远程模式下显示「远程时有延迟」
 */
export function runtimeTagFor(input: RuntimeTagInput): RuntimeTag | null {
  if (!input.isGame) return null
  if (input.isHostRuntime) {
    return { key: 'plays.remoteNoDelayTag', tipKey: 'plays.remoteNoDelayTip', accent: true }
  }
  if (input.isOperatorRemote) {
    return { key: 'plays.remoteDelayTag', tipKey: 'plays.remoteDelayTip', accent: false }
  }
  return null
}
