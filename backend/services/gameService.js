const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fileStorage = require('../utils/fileStorage');
const logger = require('../utils/logger');
const { withPlayI18n } = require('../utils/playI18n');

const backendRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(backendRoot, '..');
const newGameDir = path.resolve(backendRoot, 'games');
const SAVED_GAMES_KEY = 'games';
const REMOVED_BUILTIN_GAMES_KEY = 'removedBuiltinGames';

function getGameRoot() {
  return process.env.BACKEND_GAMES_DIR
    ? path.resolve(process.env.BACKEND_GAMES_DIR)
    : newGameDir;
}

function ensureGameDir() {
  const gameRoot = getGameRoot();
  if (!fs.existsSync(gameRoot)) fs.mkdirSync(gameRoot, { recursive: true });
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

function readRemovedBuiltinGameIds() {
  const raw = fileStorage.getItem(REMOVED_BUILTIN_GAMES_KEY);
  if (!raw) return [];
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch (_) { return []; }
}

function markBuiltinGameRemoved(id) {
  const ids = new Set(readRemovedBuiltinGameIds());
  ids.add(String(id));
  fileStorage.setItem(REMOVED_BUILTIN_GAMES_KEY, JSON.stringify(Array.from(ids)));
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
  const gameRoot = getGameRoot();
  if (!fs.existsSync(gameRoot)) return results;
  const entries = fs.readdirSync(gameRoot, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const indexPath = path.join(gameRoot, ent.name, 'index.html');
    if (!fs.existsSync(indexPath)) continue;
    try {
      const html = fs.readFileSync(indexPath, 'utf8');
      const manifest = extractManifestFromHtml(html);
      if (!manifest) continue;
      const gameId = manifest.id || ent.name;
      results.push(withPlayI18n({
        id: gameId,
        name: manifest.title || ent.name,
        description: manifest.description || '',
        howTo: typeof manifest.howTo === 'string' ? manifest.howTo : '',
        status: 'idle',
        type: 'html',
        gamePath: `/games/${ent.name}/index.html`,
        folder: ent.name,
        devices: manifest.devices || [],
        params: manifest.params || [],
        version: manifest.version || '1.0.0',
        createdAt: Date.now(),
        lastPlayed: null,
      }, manifest));
    } catch (e) {
      logger.warn('Scan HTML game failed', { dir: ent.name, err: e?.message });
    }
  }
  return results;
}

function listGames() {
  const removedBuiltinIds = new Set(readRemovedBuiltinGameIds());
  const htmlGames = scanHtmlGames().filter((game) => !removedBuiltinIds.has(String(game.id)));
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
  const removedBuiltinIds = new Set(readRemovedBuiltinGameIds());
  const games = scanHtmlGames().filter((game) => !removedBuiltinIds.has(String(game.id)));
  return { ok: true, count: games.length, games };
}

function deleteGameById(id, { removeFile } = {}) {
  const game = getGameById(id);
  if (!game) return { ok: false, notFound: true };
  const saved = readGames();
  const nextSaved = saved.filter((g) => g && String(g.id) !== String(id));
  if (nextSaved.length !== saved.length) writeGames(nextSaved);
  if (game.folder) markBuiltinGameRemoved(id);
  if (removeFile && game.folder) {
    const dir = path.join(getGameRoot(), game.folder);
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        // Packaged Electron resources may be read-only. The persisted removal marker
        // still prevents the deleted game from being rediscovered on refresh.
        logger.warn('Remove built-in game files failed; keeping game hidden', {
          id,
          dir,
          err: error?.message,
        });
      }
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

  return withPlayI18n({
    id,
    title,
    name: title,
    description: cleanString(input.description || existing?.description),
    howTo: cleanString(input.howTo || existing?.howTo),
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
  }, input.i18n || existing?.i18n);
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
  getGameRoot,
  extractManifestFromHtml,
  scanHtmlGames,
};
