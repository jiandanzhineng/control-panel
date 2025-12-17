const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fileStorage = require('../utils/fileStorage');
const logger = require('../utils/logger');

const backendRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(backendRoot, '..');
const gameDir = path.resolve(backendRoot, 'game');

function ensureGameDir() {
  try {
    if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir, { recursive: true });
  } catch (e) {
    // bubble up
    throw e;
  }
}

function readGames() {
  const raw = fileStorage.getItem('games');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeGames(rows) {
  try {
    fileStorage.setItem('games', JSON.stringify(rows || []));
  } catch (e) {
    throw e;
  }
}

function stableIdForPath(relPath) {
  const h = crypto.createHash('md5').update(relPath).digest('hex').slice(0, 12);
  return `game_${h}`;
}

function extractTitleFromJs(content) {
  try {
    const re = /\btitle\b\s*[:=]\s*(["'])(.*?)\1/; // title: "..." or title = '...'
    const m = content.match(re);
    if (m && m[2]) return String(m[2]).trim();
  } catch (_) {}
  return null;
}

function toConfigPath(absFilePath) {
  const relToProject = path.relative(projectRoot, absFilePath);
  const relNormalized = String(relToProject).replace(/\\/g, '/');
  return relNormalized.startsWith('backend/game')
    ? relNormalized
    : `backend/${relNormalized}`;
}

function createGameEntryForFile(absFilePath) {
  const relToBackend = path.relative(backendRoot, absFilePath); // e.g., game/foo.js
  const configPath = toConfigPath(absFilePath); // e.g., backend/game/foo.js
  let name = path.basename(absFilePath, path.extname(absFilePath));
  let description = '';
  try {
    const text = fs.readFileSync(absFilePath, 'utf8');
    const t = extractTitleFromJs(text);
    if (t) name = t;
  } catch (e) {
    // ignore read errors, fall back to filename
  }
  const id = stableIdForPath(relToBackend);
  const now = Date.now();
  return {
    id,
    name,
    description,
    status: 'idle',
    arguments: '',
    configPath,
    requiredDevices: [],
    version: '',
    author: '',
    createdAt: now,
    lastPlayed: null,
  };
}

function scanForJsFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      try {
        results.push(...scanForJsFiles(p));
      } catch (e) {
        logger.warn('Scan subdir failed', { subdir: p, err: e?.message || e });
      }
    } else if (ent.isFile()) {
      if (p.endsWith('.js')) results.push(p);
    }
  }
  return results;
}

function listGames() {
  return readGames();
}

function getGameById(id) {
  const rows = readGames();
  return rows.find((g) => g && g.id === id) || null;
}

function reloadGames() {
  ensureGameDir();
  const files = scanForJsFiles(gameDir);
  const rows = files.map((abs) => createGameEntryForFile(abs));
  writeGames(rows);
  return { ok: true, count: rows.length };
}

function saveUploadedJs({ originalName, buffer }) {
  ensureGameDir();
  if (!originalName || !/\.js$/i.test(originalName)) {
    const err = new Error('Only .js files are allowed');
    err.code = 'GAME_FILE_INVALID';
    throw err;
  }
  const abs = path.resolve(gameDir, originalName);
  fs.writeFileSync(abs, buffer);
  // Build game entry from saved file
  const entry = createGameEntryForFile(abs);

  // Merge into existing list by configPath or name
  const rows = readGames();
  const idx = rows.findIndex((g) => g && (g.configPath === entry.configPath || g.name === entry.name));
  if (idx >= 0) {
    const prev = rows[idx];
    const merged = { ...prev, ...entry, id: prev.id, createdAt: prev.createdAt || entry.createdAt };
    rows[idx] = merged;
  } else {
    rows.push(entry);
  }
  writeGames(rows);
  return entry;
}

function absPathFromConfig(configPath) {
  const prefix = 'backend/game/';
  if (!configPath || typeof configPath !== 'string') return null;
  const normalized = String(configPath).replace(/\\/g, '/');
  if (!normalized.startsWith(prefix)) return null;
  const relWithinGame = normalized.slice(prefix.length);
  const abs = path.resolve(gameDir, relWithinGame);
  // sanity: ensure inside gameDir
  const normGame = gameDir.endsWith(path.sep) ? gameDir : gameDir + path.sep;
  const normAbs = abs.endsWith(path.sep) ? abs : abs;
  if (!normAbs.startsWith(normGame)) return null;
  return abs;
}

function deleteGameById(id, { removeFile } = {}) {
  const rows = readGames();
  const idx = rows.findIndex((g) => g && g.id === id);
  if (idx < 0) return { ok: false, notFound: true };
  const g = rows[idx];
  rows.splice(idx, 1);
  writeGames(rows);

  let removedFile = false;
  if (removeFile) {
    try {
      const abs = absPathFromConfig(g.configPath);
      if (abs && fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        removedFile = true;
      }
    } catch (e) {
      const err = new Error(e?.message || String(e));
      err.code = 'GAME_DELETE_FAILED';
      throw err;
    }
  }
  return { ok: true, removedFile };
}

function updateGameById(id, changes = {}) {
  const rows = readGames();
  const idx = rows.findIndex((g) => g && g.id === id);
  if (idx < 0) return { ok: false, notFound: true };
  const g = rows[idx] || {};
  rows[idx] = { ...g, ...(changes || {}) };
  writeGames(rows);
  return { ok: true };
}

module.exports = {
  listGames,
  getGameById,
  reloadGames,
  saveUploadedJs,
  deleteGameById,
  ensureGameDir,
  updateGameById,
};
