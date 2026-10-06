// 主控端「远程模式」下的界面锁定规则（纯数据 + 纯函数，路由守卫与侧栏共用）。
// 与后端 backend/middleware/remoteSessionFilter.js 的锁定表对齐：这些页面/路由在
// 远程模式下不可用，断开后恢复。被控端不受影响（被控端本地操作照常优先）。

/** 置灰的侧栏入口（客服 /support 保持可用；设备、玩法、远程连接保持可用） */
export const LOCKED_MENU_PATHS: string[] = ['/browser', '/network', '/account', '/settings', '/logs']

/** 远程模式下拦截的路由前缀 */
export const LOCKED_ROUTE_PREFIXES: string[] = [
  '/browser',
  '/network',
  '/account',
  '/settings',
  '/logs',
  '/test',
  '/devices/firmware',
  '/plays/plugin',
]

/** 命中即锁定；前后带边界，避免 /test 误伤 /testing */
const LOCKED_ROUTE_PATTERNS: RegExp[] = [
  /^\/browser(\/|$)/,
  /^\/network(\/|$)/,
  /^\/account(\/|$)/,
  /^\/settings(\/|$)/,
  /^\/logs(\/|$)/,
  /^\/test(\/|$)/,
  /^\/devices\/firmware(\/|$)/,
  /^\/plays\/plugin(\/|$)/,
]

export function isRouteLocked(path: string, remoteMode: boolean): boolean {
  if (!remoteMode) return false
  const target = String(path || '')
  return LOCKED_ROUTE_PATTERNS.some((pattern) => pattern.test(target))
}

export function isMenuItemLocked(path: string, remoteMode: boolean): boolean {
  if (!remoteMode) return false
  const target = String(path || '')
  return LOCKED_MENU_PATHS.includes(target)
}
