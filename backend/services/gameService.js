const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fileStorage = require('../utils/fileStorage');
const logger = require('../utils/logger');

const backendRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(backendRoot, '..');
const newGameDir = path.resolve(backendRoot, 'games');
const SAVED_GAMES_KEY = 'games';

function ensureGameDir() {
  if (!fs.existsSync(newGameDir)) fs.mkdirSync(newGameDir, { recursive: true });
}

function readGames() {
  const raw = fileStorage.getItem(SAVED_GAMES_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function writeGames(rows) {
  fileStorage.setItem(SAVED_GAMES_KEY, JSON.stringify(rows || []));
}

function stableIdForPath(relPath) {
  const h = crypto.createHash('md5').update(relPath).digest('hex').slice(0, 12);
  return `game_${h}`;
}

function extractManifestFromHtml(htmlContent) {
  // 与 play-registry/scripts/build-registry.js 的正则保持一致（test/extract.test.js 双端锁定）。
  // 用 [^>]*\bid= 而非旧 [^>]+id=：后者要求 id 前至少一字符，id 写在最前时会失配。
  const m = htmlContent.match(/<script[^>]*\bid\s*=\s*["']game-manifest["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

function scanHtmlGames() {
  const results = [];
  if (!fs.existsSync(newGameDir)) return results;
  const entries = fs.readdirSync(newGameDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const indexPath = path.join(newGameDir, ent.name, 'index.html');
    if (!fs.existsSync(indexPath)) continue;
    try {
      const html = fs.readFileSync(indexPath, 'utf8');
      const manifest = extractManifestFromHtml(html);
      if (!manifest) continue;
      const gameId = manifest.id || ent.name;
      results.push({
        id: gameId,
        name: manifest.title || ent.name,
        description: manifest.description || '',
        status: 'idle',
        type: 'html',
        gamePath: `/games/${ent.name}/index.html`,
        folder: ent.name,
        devices: manifest.devices || [],
        params: manifest.params || [],
        version: manifest.version || '1.0.0',
        createdAt: Date.now(),
        lastPlayed: null,
      });
    } catch (e) {
      logger.warn('Scan HTML game failed', { dir: ent.name, err: e?.message });
    }
  }
  return results;
}

function listGames() {
  const htmlGames = scanHtmlGames();
  const byId = new Map(htmlGames.map((g) => [g.id, { ...g, source: 'builtin' }]));
  for (const saved of readGames()) {
    const normalized = normalizeSavedGame(saved, { existing: saved, markPlayed: false });
    if (!normalized) continue;
    const current = byId.get(normalized.id);
    if (current) {
      byId.set(normalized.id, {
        ...current,
        lastPlayed: normalized.lastPlayed || current.lastPlayed || null,
        lastDeviceMap: normalized.lastDeviceMap || {},
        lastParams: normalized.lastParams || {},
        savedAt: normalized.savedAt || current.savedAt,
        playCount: normalized.playCount || 0,
        cached: normalized.cached || current.cached || false,
        localGamePath: normalized.localGamePath || current.localGamePath || '',
        packageSha256: normalized.packageSha256 || current.packageSha256 || '',
      });
    } else {
      byId.set(normalized.id, normalized);
    }
  }
  return Array.from(byId.values());
}

function getGameById(id) {
  const games = listGames();
  return games.find((g) => g.id === id) || null;
}

function reloadGames() {
  ensureGameDir();
  const games = scanHtmlGames();
  return { ok: true, count: games.length, games };
}

function deleteGameById(id, { removeFile } = {}) {
  const game = getGameById(id);
  if (!game) return { ok: false, notFound: true };
  const saved = readGames();
  const nextSaved = saved.filter((g) => g && String(g.id) !== String(id));
  if (nextSaved.length !== saved.length) writeGames(nextSaved);
  if (removeFile && game.folder) {
    const dir = path.join(newGameDir, game.folder);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
    }
  }
  return { ok: true };
}

function updateGameById(id, changes = {}) {
  return { ok: true };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanString(value, fallback = '') {
  const s = String(value == null ? '' : value).trim();
  return s || fallback;
}

function normalizeSavedGame(input, { existing = null, markPlayed = true } = {}) {
  if (!input || typeof input !== 'object') return null;
  const externalUrl = cleanString(input.externalUrl || existing?.externalUrl);
  const gamePath = cleanString(input.gamePath || existing?.gamePath);
  const id = cleanString(input.id || existing?.id || (externalUrl ? stableIdForPath(externalUrl) : ''));
  if (!id || (!gamePath && !externalUrl)) return null;

  const now = Date.now();
  const title = cleanString(input.title || input.name || existing?.title || existing?.name, id);
  const lastDeviceMap = asObject(input.deviceMap || input.lastDeviceMap || existing?.lastDeviceMap);
  const lastParams = asObject(input.parameters || input.paramsValues || input.lastParams || existing?.lastParams);
  const localGamePath = cleanString(input.localGamePath || existing?.localGamePath);
  const packageSha256 = cleanString(input.packageSha256 || existing?.packageSha256);
  const cached = input.cached === true || existing?.cached === true || gamePath.startsWith('/games/cache/');

  return {
    id,
    title,
    name: title,
    description: cleanString(input.description || existing?.description),
    status: 'idle',
    type: 'html',
    source: 'saved',
    origin: cleanString(input.origin || existing?.origin, externalUrl ? 'external' : 'remote'),
    gamePath,
    externalUrl,
    cached,
    localGamePath,
    packageSha256,
    devices: asArray(input.devices || existing?.devices),
    params: asArray(input.params || existing?.params),
    version: cleanString(input.version || existing?.version, '1.0.0'),
    createdAt: Number(existing?.createdAt || input.createdAt || now),
    savedAt: markPlayed ? now : Number(input.savedAt || existing?.savedAt || now),
    lastPlayed: markPlayed ? now : Number(input.lastPlayed || existing?.lastPlayed || 0) || null,
    playCount: Number(existing?.playCount || input.playCount || 0) + (markPlayed ? 1 : 0),
    lastDeviceMap,
    lastParams,
  };
}

function savePlayedGame(input) {
  const rows = readGames();
  const idx = rows.findIndex((g) => g && String(g.id) === String(input?.id));
  const existing = idx >= 0 ? rows[idx] : null;
  const normalized = normalizeSavedGame(input, { existing, markPlayed: true });
  if (!normalized) {
    const error = new Error('需提供 id 以及 gamePath 或 externalUrl');
    error.code = 'INVALID_PLAYED_GAME';
    throw error;
  }
  if (idx >= 0) rows[idx] = normalized;
  else rows.push(normalized);
  writeGames(rows);
  return normalized;
}

module.exports = {
  listGames,
  getGameById,
  reloadGames,
  deleteGameById,
  ensureGameDir,
  updateGameById,
  savePlayedGame,
  extractManifestFromHtml,
  scanHtmlGames,
};
