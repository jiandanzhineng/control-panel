const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fileStorage = require('../utils/fileStorage');
const logger = require('../utils/logger');

const backendRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(backendRoot, '..');
const newGameDir = path.resolve(backendRoot, 'games');

function ensureGameDir() {
  if (!fs.existsSync(newGameDir)) fs.mkdirSync(newGameDir, { recursive: true });
}

function readGames() {
  const raw = fileStorage.getItem('games');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function writeGames(rows) {
  fileStorage.setItem('games', JSON.stringify(rows || []));
}

function stableIdForPath(relPath) {
  const h = crypto.createHash('md5').update(relPath).digest('hex').slice(0, 12);
  return `game_${h}`;
}

function extractManifestFromHtml(htmlContent) {
  const m = htmlContent.match(/<script[^>]+id\s*=\s*["']game-manifest["'][^>]*>([\s\S]*?)<\/script>/i);
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
  return htmlGames;
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

module.exports = {
  listGames,
  getGameById,
  reloadGames,
  deleteGameById,
  ensureGameDir,
  updateGameById,
  extractManifestFromHtml,
  scanHtmlGames,
};
