// 游戏 iframe 的 sandbox 策略。
//
// 第一方游戏（内置 /games/...、已缓存 /games/cache/...）需要同源才能加载
// /bridge-api/device-api-bridge.js 并连本机 bridge，因此不加 sandbox。
// 第三方网页游戏（经 /games/proxy 代理的外部站点）跑在独立 origin 里，
// 读不到面板 localStorage 的账号 token（审查报告 §2.4）。
//
// 注意不要给代理游戏加 allow-same-origin：面板后端是回环地址，加了它就等于
// 让第三方页面用控制台 origin 读本机 /api。注册表里能直接运行的游戏都是缓存到
// 本地的（/games/cache/...，不加 sandbox），所以这里不会挡掉正常玩法。
export function iframeSandboxFor(src: string): string | undefined {
  const base = String(src || '').split('?')[0]
  if (!base) return undefined
  return base.startsWith('/games/proxy/')
    ? 'allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock'
    : undefined
}

export function isProxiedGameSrc(src: string): boolean {
  return String(src || '').split('?')[0].startsWith('/games/proxy/')
}
