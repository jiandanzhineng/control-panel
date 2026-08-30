// GameHost 宿主侧纯逻辑：请求校验与 payload 构造。
// 与 DeviceAPI 分离，仅服务于官方网站在内置浏览器 <webview> 里通过
// window.GameHost.{cache,launch} 发起的调用。抽成纯函数便于单测——
// Electron IPC / 主进程集成层无法直接在 jest 里跑。

const { isLocalLoopbackOrigin } = require('../backend/services/externalGameAccessService.js');

// 只允许官方顶层 origin 调用（用宿主侧记录的 origin 校验，不信任消息内容）。
const OFFICIAL_GAME_ORIGIN = 'https://game.undersilicon.cn';

// gameId 允许字符与长度上限。
const GAME_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MAX_GAME_ID_LENGTH = 128;

const { formatElectronText } = require('./locale');

function gameHostError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hostLocale(options) {
  return options && options.locale === 'en' ? 'en' : 'zh';
}

// 官方站点始终允许；开发者模式开启时额外允许任意端口的本地回环来源。
function assertAllowedOrigin(origin, options = {}) {
  const { developerModeEnabled = false } = options;
  const locale = hostLocale(options);
  const allowed = origin === OFFICIAL_GAME_ORIGIN
    || (developerModeEnabled && isLocalLoopbackOrigin(origin));
  if (!allowed) {
    const error = gameHostError('GAME_HOST_FORBIDDEN_ORIGIN', formatElectronText(locale, 'gameHostForbidden'));
    error.origin = origin;
    throw error;
  }
  return origin;
}

// 校验 gameId：非空字符串、仅允许 [a-zA-Z0-9._-]、长度上限。
function validateGameId(gameId, locale = 'zh') {
  if (typeof gameId !== 'string' || gameId.length === 0) {
    throw gameHostError('GAME_HOST_INVALID_GAME_ID', formatElectronText(locale, 'gameHostInvalidId'));
  }
  if (gameId.length > MAX_GAME_ID_LENGTH) {
    throw gameHostError('GAME_HOST_INVALID_GAME_ID', formatElectronText(locale, 'gameHostIdTooLong', { n: MAX_GAME_ID_LENGTH }));
  }
  if (!GAME_ID_PATTERN.test(gameId)) {
    throw gameHostError('GAME_HOST_INVALID_GAME_ID', formatElectronText(locale, 'gameHostIdChars'));
  }
  return gameId;
}

// 解析并校验来自网页的请求：只接受 v(===1) 与 gameId，其它字段一律忽略。
function parseGameHostRequest(req, localeOrOptions) {
  const locale = hostLocale(typeof localeOrOptions === 'string' ? { locale: localeOrOptions } : (localeOrOptions || {}));
  if (!req || typeof req !== 'object') {
    throw gameHostError('GAME_HOST_INVALID_REQUEST', formatElectronText(locale, 'gameHostInvalidRequest'));
  }
  if (req.v !== 1) {
    throw gameHostError('GAME_HOST_UNSUPPORTED_VERSION', formatElectronText(locale, 'gameHostUnsupportedVersion'));
  }
  const gameId = validateGameId(req.gameId, locale);
  return { gameId };
}

// 构造原生配置页导航路径（hash 路由，source=remote 走远程仓库）。
function buildLaunchPath(gameId) {
  return `/plays/game/${encodeURIComponent(gameId)}/config?source=remote`;
}

// 构造缓存安装接口 URL。
function buildInstallUrl(baseUrl, gameId) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}/api/game-cache/install/${encodeURIComponent(gameId)}`;
}

module.exports = {
  OFFICIAL_GAME_ORIGIN,
  GAME_ID_PATTERN,
  MAX_GAME_ID_LENGTH,
  assertAllowedOrigin,
  validateGameId,
  parseGameHostRequest,
  buildLaunchPath,
  buildInstallUrl,
};
