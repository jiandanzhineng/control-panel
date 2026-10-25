// 解析托管游戏原始页面的本地路径：
// 1) 内置/已保存游戏直接读 /api/games/<id> 的 gamePath
// 2) 注册表游戏确保已安装到本地缓存（/api/game-cache/install），返回 localGamePath
// 找不到返回空串，由调用方显示错误。
//
// 注意：注册表游戏的 /api/games/<id> 会返回 404，必须回落到 /api/game-cache/install。
// 首次安装要下载+校验游戏包（秒级），调用方要允许等待与重试。
export async function resolveGamePagePath(gameId: string): Promise<string> {
  const id = String(gameId || '').trim();
  if (!id) return '';
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(id)}`);
    if (res.ok) {
      const meta = await res.json().catch(() => null);
      const gamePath = String(meta?.gamePath || '');
      if (gamePath.startsWith('/games/')) return gamePath;
    }
  } catch (_) { /* 忽略，走注册表安装 */ }
  try {
    const res = await fetch(`/api/game-cache/install/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    // 安装接口可能返回 localGamePath 或 gamePath（已缓存/刚安装两种分支）
    const installed = String(data?.localGamePath || data?.gamePath || '');
    if (res.ok && installed.startsWith('/games/')) return installed;
  } catch (_) { /* 忽略 */ }
  return '';
}

// 为游戏页面拼接托管渲染模式参数：runtime=host(本机执行) | remote(远程主控)
export function buildGameRuntimePageSrc(pagePath: string, runtime: 'host' | 'remote', locale?: string, localeTag?: string): string {
  const base = String(pagePath || '').trim();
  if (!base) return '';
  const q = new URLSearchParams();
  q.set('runtime', runtime);
  if (locale) q.set('locale', locale);
  if (localeTag) q.set('localeTag', localeTag);
  return `${base}${base.includes('?') ? '&' : '?'}${q.toString()}`;
}
