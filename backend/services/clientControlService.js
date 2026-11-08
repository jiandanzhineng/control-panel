// 客户端控制通道（A2）：后端 → Electron 主进程 → 前端。
// 后端与 Electron 主进程同进程：main.js 启动时 registerHost(handler)；
// 纯后端（dev:all / node backend/index.js）没有 host，控制接口统一 503 CLIENT_UNAVAILABLE。
const eventBus = require('./eventBus');
const { listClientRoutes, resolveClientRoute } = require('../constants/clientRoutes');

const WINDOW_ACTIONS = new Set(['show', 'hide', 'focus', 'minimize', 'maximize', 'restore']);
const SCREENSHOT_FORMATS = new Set(['png', 'jpeg']);
// 运行态页面（iframe/host）在卸载时会 POST /games/stop-current；agent 从这些页面
// 直接启动新玩法会被旧页面的卸载请求把刚启动的玩法停掉，必须先离开再启动。
const RUN_PAGE_PREFIXES = ['/plays/game/current', '/plays/game/runtime'];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let host = null;
let currentRoute = null;
let currentWindow = null;
let currentLocale = null;
let clientVersion = null;

function clientUnavailableError() {
  const error = new Error('客户端不可用：当前未在 Electron 中运行');
  error.code = 'CLIENT_UNAVAILABLE';
  return error;
}

function invalidRequest(message, code = 'INVALID_REQUEST') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Electron 主进程注册 host；返回注销函数。 */
function registerHost(handler) {
  if (typeof handler !== 'function') throw new TypeError('client host handler must be a function');
  host = handler;
  return () => {
    if (host === handler) host = null;
  };
}

function isAvailable() {
  return typeof host === 'function';
}

async function invoke(command = {}) {
  if (!isAvailable()) throw clientUnavailableError();
  const result = await host(command);
  if (result && typeof result === 'object') {
    if (result.window) currentWindow = result.window;
    if (result.route) currentRoute = result.route;
    if (result.version) clientVersion = result.version;
    if (result.locale) currentLocale = result.locale;
  }
  return result;
}

/** 主进程通过 IPC 上报当前路由（frontend router.afterEach → client:route-changed）。 */
function reportRoute(path) {
  const value = typeof path === 'string' ? path.trim() : '';
  if (!value) return;
  currentRoute = value;
  eventBus.publish('client.route', { path: value });
}

/** 主进程窗口事件（show/hide/focus/minimize/maximize/restore）上报。 */
function reportWindow(state) {
  if (!state || typeof state !== 'object') return;
  currentWindow = {
    visible: !!state.visible,
    focused: !!state.focused,
    minimized: !!state.minimized,
    maximized: !!state.maximized,
  };
  eventBus.publish('client.window', { ...currentWindow });
}

function cachedState(available = isAvailable()) {
  return {
    available,
    version: clientVersion,
    window: currentWindow,
    route: currentRoute,
    locale: currentLocale,
  };
}

async function getState() {
  if (!isAvailable()) return cachedState(false);
  const result = await invoke({ type: 'state' });
  return { available: true, ...(result || {}) };
}

async function windowAction(action) {
  const value = String(action || '').trim();
  if (!WINDOW_ACTIONS.has(value)) {
    throw invalidRequest(`不支持的窗口操作: ${value || '(空)'}`, 'INVALID_WINDOW_ACTION');
  }
  const result = await invoke({ type: 'window', action: value });
  reportWindow(result?.window || currentWindow || {});
  return cachedState();
}

async function navigate(path, { show = true } = {}) {
  const route = resolveClientRoute(path);
  if (!route) throw invalidRequest('只允许跳转到客户端路由清单内的页面', 'ROUTE_NOT_ALLOWED');
  await invoke({ type: 'navigate', path: route.path, show: show !== false });
  return getState();
}

function getRoutes() {
  return listClientRoutes();
}

async function screenshot({ format = 'png', maxWidth = 1280 } = {}) {
  const fmt = String(format || 'png').toLowerCase();
  if (!SCREENSHOT_FORMATS.has(fmt)) {
    throw invalidRequest('format 只支持 png / jpeg', 'INVALID_SCREENSHOT_FORMAT');
  }
  const width = Number(maxWidth);
  const maxWidthValue = Number.isFinite(width) ? Math.max(1, Math.min(4096, Math.round(width))) : 1280;
  const result = await invoke({ type: 'screenshot', format: fmt, maxWidth: maxWidthValue });
  if (!result || typeof result.data !== 'string') {
    throw invalidRequest('截图失败：宿主没有返回图像数据', 'SCREENSHOT_FAILED');
  }
  return {
    mime: result.mime || (fmt === 'jpeg' ? 'image/jpeg' : 'image/png'),
    data: result.data,
    width: result.width || null,
    height: result.height || null,
  };
}

/**
 * 按界面同等流程启动游戏：先停当前玩法 → startGame（与 POST /api/games/:id/start 同一实现）
 * → 让前端跳到对应的运行页面（iframe 游戏由 GameCurrentView 加载 iframe）。
 */
async function launchGame({
  gameId,
  deviceMap = {},
  parameters = {},
  show = true,
} = {}) {
  if (!isAvailable()) throw clientUnavailableError();
  const id = String(gameId || '').trim();
  if (!id) throw invalidRequest('缺少游戏 ID', 'GAME_ID_REQUIRED');

  // 当前若停在旧玩法的运行页，先离开并等它卸载时的 stop-current 落地，避免互相踩。
  if (RUN_PAGE_PREFIXES.some((prefix) => String(currentRoute || '').startsWith(prefix))) {
    await invoke({ type: 'navigate', path: '/plays', show: false });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await delay(100);
      if (!RUN_PAGE_PREFIXES.some((prefix) => String(currentRoute || '').startsWith(prefix))) break;
      const state = await getState().catch(() => null);
      if (!RUN_PAGE_PREFIXES.some((prefix) => String(state?.route || '').startsWith(prefix))) break;
    }
    // 卸载钩子里的 stop-current 是异步 fetch，留一点时间让它落地
    await delay(200);
  }

  const gameLaunchService = require('./gameLaunchService');
  await gameLaunchService.stopCurrentPlay({ gameId: id, reason: 'agent-launch' });
  // 启动失败会把错误原样抛给路由（GAME_NOT_FOUND / HOST_PLAY_ACTIVE …）
  const started = await gameLaunchService.startGame({
    gameId: id,
    deviceMapping: deviceMap,
    parameters,
    source: 'local',
  });
  const mode = started?.runtime?.mode === 'host' ? 'host' : 'iframe';
  const query = new URLSearchParams();
  query.set('id', id);
  const gamePath = String(started?.gamePath || '');
  if (gamePath) query.set('gamePath', gamePath);
  const gameToken = String(started?.runtime?.gameToken || '');
  if (gameToken) query.set('gameToken', gameToken);
  query.set('deviceMap', JSON.stringify(started?.deviceMap || deviceMap || {}));
  query.set('params', JSON.stringify(started?.params || parameters || {}));
  if (currentLocale) {
    query.set('locale', String(currentLocale));
    query.set('localeTag', String(currentLocale) === 'en' ? 'en-US' : 'zh-CN');
  }
  const page = mode === 'host' ? '/plays/game/runtime' : '/plays/game/current';
  const path = `${page}?${query.toString()}`;
  await invoke({ type: 'navigate', path, show: show !== false });
  return {
    ok: true,
    gameId: id,
    mode,
    started,
    path,
    state: await getState(),
  };
}

function _resetForTests() {
  host = null;
  currentRoute = null;
  currentWindow = null;
  currentLocale = null;
  clientVersion = null;
}

module.exports = {
  WINDOW_ACTIONS,
  registerHost,
  isAvailable,
  getState,
  windowAction,
  navigate,
  getRoutes,
  screenshot,
  launchGame,
  reportRoute,
  reportWindow,
  cachedState,
  _resetForTests,
};
