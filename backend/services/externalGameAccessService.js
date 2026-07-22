const fs = require('fs');
const path = require('path');

// 开发者「外部本地游戏」放行开关的持久化。
// 开启后：所有本地回环端口（localhost/127.0.0.1/::1，任意端口）+ 用户显式声明的
// origin 白名单，被视为受信开发来源，可直连本机 /api、/bridge、/bridge-api。
// 默认关闭。仿 browserDeviceGrantService 的 JSON 存储范式。

function getStateFilePath() {
  if (process.env.EXTERNAL_GAME_ACCESS_PATH) {
    return path.resolve(process.env.EXTERNAL_GAME_ACCESS_PATH);
  }
  if (process.env.BACKEND_DATA_DIR) {
    return path.join(path.resolve(process.env.BACKEND_DATA_DIR), 'external-game-access.json');
  }
  return path.join(path.resolve(__dirname, '..'), 'data', 'external-game-access.json');
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normalizeOrigin(input) {
  try {
    const parsed = new URL(String(input || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    if (!parsed.origin || parsed.origin === 'null') return '';
    return parsed.origin;
  } catch (_) {
    return '';
  }
}

// 判断某 origin 是否为本地回环（任意端口）。
function isLocalLoopbackOrigin(origin) {
  try {
    const parsed = new URL(String(origin || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname;
    if (LOCAL_HOSTNAMES.has(host)) return true;
    // 127.0.0.0/8 全段视为本地回环
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

function defaultState() {
  return { enabled: false, origins: [] };
}

function readState() {
  const filePath = getStateFilePath();
  try {
    if (!fs.existsSync(filePath)) return defaultState();
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultState();
    const origins = Array.isArray(parsed.origins)
      ? parsed.origins.map(normalizeOrigin).filter(Boolean)
      : [];
    return { enabled: !!parsed.enabled, origins: Array.from(new Set(origins)) };
  } catch (_) {
    return defaultState();
  }
}

function writeState(state) {
  const filePath = getStateFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function getStatus() {
  return readState();
}

// 更新开关与白名单。origins 里的无效/非 http(s) 项会被剔除。
function setStatus({ enabled, origins } = {}) {
  const current = readState();
  const next = {
    enabled: enabled === undefined ? current.enabled : !!enabled,
    origins: origins === undefined
      ? current.origins
      : Array.from(new Set((Array.isArray(origins) ? origins : []).map(normalizeOrigin).filter(Boolean))),
  };
  writeState(next);
  return next;
}

// 核心判定：开关开启时，本地回环任意端口 或 命中白名单 → 受信。
function isTrustedDevOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const state = readState();
  if (!state.enabled) return false;
  if (isLocalLoopbackOrigin(normalized)) return true;
  return state.origins.includes(normalized);
}

module.exports = {
  getStateFilePath,
  normalizeOrigin,
  isLocalLoopbackOrigin,
  readState,
  writeState,
  getStatus,
  setStatus,
  isTrustedDevOrigin,
};
