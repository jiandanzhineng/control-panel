// 可供外部 agent 导航的客户端页面清单（GET /api/client/routes）。
// 与 frontend/src/router/index.ts 保持一致，只列「用户会主动打开」的页面；
// 运行态覆盖层（/plays/game/current、/plays/game/runtime）、配置页、插件运行页、
// 自动化测试等内部路由不对外开放（它们需要运行时参数，直接跳过去只会得到空页面）。
const CLIENT_ROUTES = [
  { path: '/home', name: 'home', title: '首页', titleKey: 'nav.home' },
  { path: '/devices', name: 'devices', title: '设备管理', titleKey: 'nav.devices' },
  { path: '/devices/firmware/ota', name: 'firmware_ota', title: '固件更新（在线升级）', titleKey: 'firmware.ota' },
  { path: '/devices/firmware/wired', name: 'firmware_wired', title: '固件更新（插线烧录）', titleKey: 'firmware.wired' },
  { path: '/plays', name: 'play_library', title: '游戏库', titleKey: 'nav.plays' },
  { path: '/remote', name: 'remote_session', title: '远程连接', titleKey: 'nav.remote' },
  { path: '/browser', name: 'browser', title: '游戏站', titleKey: 'nav.browser' },
  { path: '/network', name: 'network', title: '网络设置', titleKey: 'nav.network' },
  { path: '/account', name: 'account', title: '账号', titleKey: 'nav.account' },
  { path: '/settings', name: 'settings', title: '设置', titleKey: 'nav.settings' },
  { path: '/logs', name: 'logs', title: '日志管理', titleKey: 'nav.logs' },
  { path: '/support', name: 'support', title: '客服', titleKey: 'nav.support' },
];

function listClientRoutes() {
  return CLIENT_ROUTES.map((route) => ({ ...route }));
}

/**
 * 校验导航路径：只接受清单内的静态路由（允许 query/hash）。
 * 返回 { path, name, title } 或 null。
 */
function resolveClientRoute(input) {
  const raw = String(input || '').trim();
  if (!raw.startsWith('/')) return null;
  let url;
  try {
    url = new URL(raw, 'http://localhost');
  } catch (_) {
    return null;
  }
  // 不允许协议/主机（URL 解析后必须仍是本机根路径），也不允许路径穿越
  if (url.origin !== 'http://localhost') return null;
  if (url.pathname.includes('..')) return null;
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const route = CLIENT_ROUTES.find((item) => item.path === pathname);
  if (!route) return null;
  return {
    path: `${pathname}${url.search}${url.hash}`,
    name: route.name,
    title: route.title,
  };
}

module.exports = {
  CLIENT_ROUTES,
  listClientRoutes,
  resolveClientRoute,
};
