// gameProxy 主机白名单：只允许代理「面板自己会用到」的站点。
//
// 审查报告 §2.4：原实现是任意 host 的前缀反代，并且无条件剥掉
// X-Frame-Options / CSP，等于给本机开了一个开放代理 + 任意站点嵌框能力。
//
// 允许来源：
//   1. 游戏注册表源站（GAME_REGISTRY_URL / fileStorage['game-registry-source'] / 默认
//      https://game.undersilicon.cn）；
//   2. 用户自己保存过的外部游戏 URL 的 host（/api/games/external/meta 探测过的站点）；
//   3. 环境变量追加（GAME_PROXY_ALLOWED_HOSTS，逗号分隔）；
//   4. 开发态回环（127.0.0.1 / localhost / ::1），供本地注册表站与本地游戏页使用。
//
// 白名单命中才剥 X-Frame-Options / CSP —— 这是注册表/外部游戏能被 iframe 嵌进面板的
// 前提；非白名单站点直接 403，不代理也不改头。
const fileStorage = require('../utils/fileStorage');
const gameService = require('./gameService');

const SOURCE_KEY = 'game-registry-source';
const DEFAULT_REGISTRY_SOURCE = 'https://game.undersilicon.cn/registry.json';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

function hostOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return normalizeHost(parsed.host);
  } catch (_) {
    return '';
  }
}

function registrySourceUrl() {
  if (process.env.GAME_REGISTRY_URL) return process.env.GAME_REGISTRY_URL;
  const stored = fileStorage.getItem(SOURCE_KEY);
  if (stored) {
    try { const o = JSON.parse(stored); if (o && o.url) return o.url; } catch (_) {}
    return String(stored);
  }
  return DEFAULT_REGISTRY_SOURCE;
}

function savedGameHosts() {
  const hosts = new Set();
  let games = [];
  try {
    games = gameService.listGames() || [];
  } catch (_) {
    return hosts;
  }
  for (const game of games) {
    const host = hostOf(game?.externalUrl);
    if (host) hosts.add(host);
  }
  return hosts;
}

function envHosts() {
  return String(process.env.GAME_PROXY_ALLOWED_HOSTS || '')
    .split(',')
    .map((value) => normalizeHost(value))
    .filter(Boolean);
}

/** 当前允许被代理的 host 集合（小写、含端口）。 */
function getAllowedHosts() {
  const hosts = new Set();
  const registryHost = hostOf(registrySourceUrl());
  if (registryHost) hosts.add(registryHost);
  for (const host of savedGameHosts()) hosts.add(host);
  for (const host of envHosts()) hosts.add(host);
  return hosts;
}

function isAllowedHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  if (LOOPBACK_HOSTS.has(normalized)) return true;
  if (LOOPBACK_HOSTS.has(normalized.split(':')[0])) return true;
  return getAllowedHosts().has(normalized);
}

/** 只有白名单站点才需要「可被 iframe 嵌入」，因此只对它们剥掉这两个头。 */
function isEmbeddableHost(host) {
  return isAllowedHost(host);
}

module.exports = {
  normalizeHost,
  hostOf,
  getAllowedHosts,
  isAllowedHost,
  isEmbeddableHost,
  LOOPBACK_HOSTS,
  DEFAULT_REGISTRY_SOURCE,
  SOURCE_KEY,
};
