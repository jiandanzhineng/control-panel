const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const gameRegistryService = require('./gameRegistryService');
const gameService = require('./gameService');

const fallbackDataDir = path.resolve(__dirname, '..', 'data');
const META_FILE = '.cache-meta.json';

function dataDir() {
  return process.env.BACKEND_DATA_DIR ? path.resolve(process.env.BACKEND_DATA_DIR) : fallbackDataDir;
}

function cacheRoot() {
  return path.join(dataDir(), 'game-cache');
}

function tempRoot() {
  return path.join(dataDir(), 'game-cache-tmp');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanPathPart(value, label) {
  const s = String(value || '').trim();
  if (!s || !/^[a-zA-Z0-9._+-]+$/.test(s)) {
    const error = new Error(`${label} contains unsafe characters`);
    error.code = 'GAME_CACHE_INVALID_ID';
    error.status = 400;
    throw error;
  }
  return s;
}

function gameCacheDir(id, version) {
  return path.join(cacheRoot(), cleanPathPart(id, 'id'), cleanPathPart(version, 'version'));
}

function localGamePath(id, version) {
  return `/games/cache/${encodeURIComponent(id)}/${encodeURIComponent(version)}/index.html`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function cacheError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function isCacheable(entry) {
  return !!(entry && entry.packageUrl && entry.packageSha256);
}

function packageUrlFor(entry) {
  try {
    if (/^https?:\/\//i.test(String(entry.packageUrl || ''))) {
      return new URL(entry.packageUrl).toString();
    }
    return new URL(entry.packageUrl, gameRegistryService.getSource()).toString();
  } catch (_) {
    throw cacheError('GAME_CACHE_INVALID_PACKAGE_URL', '游戏包地址无效', 400);
  }
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8'));
  } catch (_) {
    return null;
  }
}

function cacheMatches(entry) {
  const dir = gameCacheDir(entry.id, entry.version);
  const meta = readMeta(dir);
  return !!(
    meta &&
    meta.id === entry.id &&
    meta.version === entry.version &&
    meta.packageSha256 === entry.packageSha256 &&
    fs.existsSync(path.join(dir, 'index.html'))
  );
}

function statusForEntry(entry, installed) {
  const cacheable = isCacheable(entry);
  const version = String(entry?.version || '');
  return {
    id: entry?.id,
    cacheable,
    installed: !!installed,
    version,
    localGamePath: installed && entry?.id && version ? localGamePath(entry.id, version) : null,
    needsUpdate: cacheable && !installed,
    packageSha256: entry?.packageSha256 || null,
    error: null,
  };
}

async function getStatus(id) {
  const entry = await gameRegistryService.getGameById(id);
  if (!entry) {
    throw cacheError('GAME_CACHE_GAME_NOT_FOUND', '远程仓库无此游戏', 404);
  }
  const installed = isCacheable(entry) && cacheMatches(entry);
  return statusForEntry(entry, installed);
}

async function downloadPackage(entry) {
  const url = packageUrlFor(entry);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw cacheError('GAME_CACHE_DOWNLOAD_FAILED', `游戏包下载失败: HTTP ${response.status}`, 502);
  }
  return Buffer.from(await response.arrayBuffer());
}

function assertSafeZipEntry(entryName) {
  const normalized = entryName.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw cacheError('GAME_CACHE_UNSAFE_ZIP', '游戏包包含不安全路径', 400);
  }
  const parts = normalized.split('/');
  if (parts.includes('..')) {
    throw cacheError('GAME_CACHE_UNSAFE_ZIP', '游戏包包含路径穿越', 400);
  }
  return normalized;
}

function extractZip(buffer, targetDir) {
  const zip = new AdmZip(buffer);
  ensureDir(targetDir);
  for (const entry of zip.getEntries()) {
    const safeName = assertSafeZipEntry(entry.entryName);
    if (entry.isDirectory) {
      ensureDir(path.join(targetDir, safeName));
      continue;
    }
    const outPath = path.resolve(targetDir, safeName);
    const root = path.resolve(targetDir);
    if (!(outPath === root || outPath.startsWith(root + path.sep))) {
      throw cacheError('GAME_CACHE_UNSAFE_ZIP', '游戏包解压目标越界', 400);
    }
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, entry.getData());
  }
}

function validateExtractedPackage(entry, dir) {
  const indexPath = path.join(dir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw cacheError('GAME_CACHE_INVALID_PACKAGE', '游戏包缺少 index.html', 400);
  }
  const html = fs.readFileSync(indexPath, 'utf8');
  const manifest = gameService.extractManifestFromHtml(html);
  if (!manifest) {
    throw cacheError('GAME_CACHE_INVALID_PACKAGE', '游戏包缺少 game-manifest', 400);
  }
  if (String(manifest.id || '') !== String(entry.id) || String(manifest.version || '') !== String(entry.version)) {
    throw cacheError('GAME_CACHE_MANIFEST_MISMATCH', '游戏包 manifest 与 registry 不一致', 400);
  }
}

function writeMeta(entry, dir, packageUrl) {
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify({
    id: entry.id,
    version: entry.version,
    packageSha256: entry.packageSha256,
    packageUrl,
    installedAt: Date.now(),
  }, null, 2) + '\n', 'utf8');
}

function replaceDirectory(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  ensureDir(path.dirname(target));
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(source, target, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

async function installGame(id) {
  const entry = await gameRegistryService.getGameById(id);
  if (!entry) {
    throw cacheError('GAME_CACHE_GAME_NOT_FOUND', '远程仓库无此游戏', 404);
  }
  if (!isCacheable(entry)) {
    throw cacheError('GAME_CACHE_NOT_CACHEABLE', '该游戏未提供完整缓存包', 400);
  }
  if (cacheMatches(entry)) return statusForEntry(entry, true);

  const installId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const tmpDir = path.join(tempRoot(), installId);
  const unpackDir = path.join(tmpDir, 'unpack');
  ensureDir(tmpDir);

  try {
    const packageUrl = packageUrlFor(entry);
    const buffer = await downloadPackage(entry);
    const actualSha = sha256(buffer);
    if (actualSha !== String(entry.packageSha256).toLowerCase()) {
      throw cacheError('GAME_CACHE_SHA_MISMATCH', '游戏包校验失败', 400);
    }
    extractZip(buffer, unpackDir);
    validateExtractedPackage(entry, unpackDir);
    writeMeta(entry, unpackDir, packageUrl);
    replaceDirectory(unpackDir, gameCacheDir(entry.id, entry.version));
    return statusForEntry(entry, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function deleteCache(id, version) {
  const dir = gameCacheDir(id, version);
  if (!fs.existsSync(dir)) return { ok: false, notFound: true };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

function getCacheRoot() {
  ensureDir(cacheRoot());
  return cacheRoot();
}

function resetTempRoot() {
  fs.rmSync(tempRoot(), { recursive: true, force: true });
}

module.exports = {
  getStatus,
  installGame,
  deleteCache,
  getCacheRoot,
  resetTempRoot,
  localGamePath,
  gameCacheDir,
};
