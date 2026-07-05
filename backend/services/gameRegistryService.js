// gameRegistryService.js — 远程游戏仓库（play-registry）的拉取、缓存、解析、版本比对。
//
// 设计要点（见 control-panel 仓 plan）：
//  - 源 URL：env GAME_REGISTRY_URL > fileStorage['game-registry-source'] > DEFAULT_SOURCE
//  - 双层缓存：内存(TTL 60s) + fileStorage 持久(断网降级，标 stale:true)
//  - 每条游戏的 gamePath 预解析成 /games/proxy/<proto>/<host><pathname>，复用 gameProxy 语义
//  - 版本比对用 semver；远程为权威源，本地 backend/games 为离线兜底
const fs = require('fs');
const path = require('path');
const semver = require('semver');
const fileStorage = require('../utils/fileStorage');
const logger = require('../utils/logger');
const gameService = require('./gameService');

const SOURCE_KEY = 'game-registry-source';
const CACHE_KEY = 'game-registry-cache';
const CACHE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const KNOWN_SCHEMA_VERSION = 1;

// 默认源：play-registry 的 OSS/CDN 站点（同一产物也会部署到 GitHub Pages）。
// 可被 env GAME_REGISTRY_URL 或 fileStorage['game-registry-source'] 覆盖。
const DEFAULT_SOURCE = 'https://game.undersilicon.cn/registry.json';

let memCache = null; // { source, fetchedAt, data, stale, schemaWarning }

function getSource() {
  if (process.env.GAME_REGISTRY_URL) return process.env.GAME_REGISTRY_URL;
  const stored = fileStorage.getItem(SOURCE_KEY);
  if (stored) {
    try { const o = JSON.parse(stored); if (o && o.url) return o.url; } catch (_) {}
    return String(stored);
  }
  return DEFAULT_SOURCE;
}

function setSource(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('源 URL 必须是 http(s)');
  fileStorage.setItem(SOURCE_KEY, JSON.stringify({ url, updatedAt: Date.now() }));
  memCache = null; // 换源立即失效缓存
  return getSource();
}

function readPersistentCache() {
  const raw = fileStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return (o && o.data) ? o : null;
  } catch (_) { return null; }
}

function writePersistentCache(source, data) {
  fileStorage.setItem(CACHE_KEY, JSON.stringify({ source, fetchedAt: Date.now(), data }));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// entry.path(相对 registryUrl) → 面板 gameProxy 前缀路径 + 绝对外部 URL
function resolveGamePath(entry, registryUrl) {
  const abs = new URL(entry.path, registryUrl);
  const proto = abs.protocol.replace(':', '');
  const proxyPath = `/games/proxy/${proto}/${abs.host}${abs.pathname}`;
  return { gamePath: proxyPath, externalUrl: `${abs.origin}${abs.pathname}` };
}

async function fetchFresh(source) {
  const resp = await withTimeout(fetch(source, { redirect: 'follow' }), FETCH_TIMEOUT_MS);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data || !Array.isArray(data.games)) throw new Error('registry.json 缺少 games 数组');
  return data;
}

// 拉取（带缓存）。force=true 跳过内存 TTL。
async function loadRegistry({ force = false } = {}) {
  const source = getSource();

  // 1) 内存缓存命中
  if (!force && memCache && memCache.source === source && (Date.now() - memCache.fetchedAt) < CACHE_TTL_MS) {
    return memCache;
  }

  // 2) 远程拉取
  try {
    const data = await fetchFresh(source);
    const schemaWarning = (typeof data.schemaVersion === 'number' && data.schemaVersion > KNOWN_SCHEMA_VERSION)
      ? `仓库 schemaVersion=${data.schemaVersion} 高于面板已知 ${KNOWN_SCHEMA_VERSION}，建议升级面板`
      : null;
    memCache = { source, fetchedAt: Date.now(), data, stale: false, schemaWarning };
    writePersistentCache(source, data);
    return memCache;
  } catch (e) {
    logger.warn('Game registry fetch failed, trying cache', { source, err: e?.message });
    // 3) 降级持久缓存
    const persisted = readPersistentCache();
    if (persisted && persisted.data) {
      memCache = {
        source: persisted.source || source,
        fetchedAt: persisted.fetchedAt || 0,
        data: persisted.data,
        stale: true,
        schemaWarning: null,
      };
      return memCache;
    }
    // 4) 全无 → 返回空（前端据此只显示本地兜底）
    memCache = { source, fetchedAt: 0, data: { games: [] }, stale: true, schemaWarning: null, error: e?.message || String(e) };
    return memCache;
  }
}

// 给前端用：列表，每条 gamePath 已预解析
async function listForClient({ force = false } = {}) {
  const reg = await loadRegistry({ force });
  const games = (reg.data.games || []).map((g) => {
    const resolved = resolveGamePath(g, reg.source);
    return {
      id: g.id,
      title: g.title || g.id,
      description: g.description || '',
      version: g.version || '0.0.0',
      devices: g.devices || [],
      params: g.params || [],
      gamePath: resolved.gamePath,
      externalUrl: resolved.externalUrl,
      sha256: g.sha256,
      size: g.size,
      source: 'remote',
    };
  });
  return {
    source: reg.source,
    stale: !!reg.stale,
    fetchedAt: reg.fetchedAt,
    schemaWarning: reg.schemaWarning || null,
    games,
  };
}

async function getGameById(id) {
  const reg = await loadRegistry();
  const entry = (reg.data.games || []).find((g) => g.id === id);
  if (!entry) return null;
  const resolved = resolveGamePath(entry, reg.source);
  return {
    id: entry.id,
    title: entry.title || entry.id,
    description: entry.description || '',
    version: entry.version || '0.0.0',
    devices: entry.devices || [],
    params: entry.params || [],
    gamePath: resolved.gamePath,
    externalUrl: resolved.externalUrl,
    sha256: entry.sha256,
    size: entry.size,
    source: 'remote',
    external: true, // 让 PlayConfigView 走"外部载体"确认框分支
  };
}

// 本地兜底 vs registry 的版本差
async function checkUpdates() {
  const reg = await loadRegistry();
  const remote = reg.data.games || [];
  const local = gameService.listGames(); // [{id, version, ...}]
  const localVer = (id) => {
    const g = local.find((x) => x.id === id);
    return (g && semver.valid(g.version)) ? g.version : null;
  };
  const out = [];
  for (const r of remote) {
    const rv = semver.valid(r.version) ? r.version : null;
    const lv = localVer(r.id);
    out.push({
      id: r.id,
      remoteVersion: rv,
      localVersion: lv,
      isNew: !lv,                 // 本地没有 = 新增游戏
      hasUpdate: !!(rv && lv && semver.gt(rv, lv)),
    });
  }
  return { source: reg.source, stale: !!reg.stale, updates: out };
}

module.exports = {
  getSource,
  setSource,
  loadRegistry,
  listForClient,
  getGameById,
  checkUpdates,
  resolveGamePath, // 供测试
  DEFAULT_SOURCE,
};
