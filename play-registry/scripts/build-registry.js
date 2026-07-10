#!/usr/bin/env node
// build-registry.js — 扫描游戏目录，生成 registry.json 和离线 zip 包。
// 设计要点：
//  - 内联 <script id="game-manifest"> 为唯一真相源
//  - 默认游戏来自 ../backend/games，网站扩展游戏来自 play-registry/games
//  - 资源引用 lint 只允许相对路径、/bridge-api/ 或 manifest.allowedOrigins 显式声明的外部源
//  - registry schema v2 保留 v1 聚合字段，并新增 files[] 逐文件清单
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE_ROOTS = [
  { source: 'builtin', dir: path.resolve(ROOT, '..', 'backend', 'games') },
  { source: 'online', dir: path.join(ROOT, 'games') },
];
const DEFAULT_PACKAGES_DIR = path.join(ROOT, 'packages');
const DEFAULT_OUT = path.join(ROOT, 'registry.json');
const DEFAULT_PREVIOUS_REGISTRY_URL = 'https://game.undersilicon.cn/registry.json';
const SCHEMA_VERSION = 2;
const ZIP_ENTRY_TIME = new Date('2000-01-01T00:00:00.000Z');

// —— vendored from backend/services/gameService.js#extractManifestFromHtml ——
// 注意：用 [^>]*\bid= 而非面板旧版的 [^>]+id=（后者要求 id 前至少一个字符）。
// 面板侧同步修正后两端一致；test/extract.test.js 锁定输出防漂移。
const MANIFEST_RE = /<script[^>]*\bid\s*=\s*["']game-manifest["'][^>]*>([\s\S]*?)<\/script>/i;

function extractManifestFromHtml(html) {
  const m = html.match(MANIFEST_RE);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function walkDir(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkDir(full, base));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256OfFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function ensureCleanPackagesDir(packagesDir) {
  fs.rmSync(packagesDir, { recursive: true, force: true });
  fs.mkdirSync(packagesDir, { recursive: true });
}

function sanitizePackagePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'game';
}

// 整个游戏目录的内容指纹：对所有文件 (相对路径:文件sha256) 排序后整体 sha256。
// files[] 是 schema v2 的逐文件清单，sha256 顶层字段保留给 v1 兼容和变更检测展示。
function fingerprintGame(gameDir) {
  const files = walkDir(gameDir)
    .map((filePath) => {
      const rel = path.relative(gameDir, filePath).replace(/\\/g, '/');
      const stat = fs.statSync(filePath);
      return {
        path: rel,
        sha256: sha256OfFile(filePath),
        size: stat.size,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const parts = files.map((file) => `${file.path}:${file.sha256}`);
  return {
    sha256: sha256(Buffer.from(parts.join('\n'), 'utf8')),
    size: files.reduce((n, file) => n + file.size, 0),
    fileCount: files.length,
    files,
  };
}

function writeGamePackage(gameDir, id, version, packagesDir, files) {
  const zip = new AdmZip();
  for (const file of files) {
    const entry = zip.addFile(
      file.path,
      fs.readFileSync(path.join(gameDir, file.path)),
      '',
      0o644,
    );
    entry.header.time = ZIP_ENTRY_TIME;
  }

  const tmpName = `.${sanitizePackagePart(id)}-${sanitizePackagePart(version)}-${process.pid}.zip.tmp`;
  const tmpPath = path.join(packagesDir, tmpName);
  zip.writeZip(tmpPath);

  const packageSha256 = sha256OfFile(tmpPath);
  const packageName = `${sanitizePackagePart(id)}-${sanitizePackagePart(version)}-${packageSha256.slice(0, 8)}.zip`;
  const packagePath = path.join(packagesDir, packageName);
  fs.renameSync(tmpPath, packagePath);

  const legacyPackageName = `${sanitizePackagePart(id)}-${sanitizePackagePart(version)}.zip`;
  if (legacyPackageName !== packageName) {
    fs.copyFileSync(packagePath, path.join(packagesDir, legacyPackageName));
  }

  return {
    packageUrl: `packages/${packageName}`,
    packageSha256,
    packageSize: fs.statSync(packagePath).size,
  };
}

function normalizeAllowedOrigins(value, gameId) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`[${gameId}] allowedOrigins 必须是数组`);
  }

  const origins = [];
  for (const item of value) {
    const raw = String(item || '').trim();
    if (!raw) continue;
    let url;
    try {
      url = raw.startsWith('//') ? new URL(`https:${raw}`) : new URL(raw);
    } catch (_) {
      throw new Error(`[${gameId}] allowedOrigins 含非法 URL: ${raw}`);
    }
    if (!/^https?:$/.test(url.protocol)) {
      throw new Error(`[${gameId}] allowedOrigins 只允许 http(s): ${raw}`);
    }
    origins.push(url.origin);
  }
  return Array.from(new Set(origins)).sort();
}

function originForAbsoluteRef(ref) {
  try {
    if (/^https?:\/\//i.test(ref)) return new URL(ref).origin;
    if (ref.startsWith('//')) return new URL(`https:${ref}`).origin;
  } catch (_) {
    return null;
  }
  return null;
}

function classifyResourceRef(ref, allowedOrigins, options = {}) {
  const value = String(ref || '').trim();
  if (!value) return null;
  if (/^(data|blob|mailto):/i.test(value)) return null;
  if (value.startsWith('/bridge-api/')) return null;

  const origin = originForAbsoluteRef(value);
  if (origin) {
    return options.allowExternalOrigin && allowedOrigins.includes(origin)
      ? null
      : `外部资源 ${value} 未在 allowedOrigins 声明 origin ${origin}`;
  }

  if (value.startsWith('/')) {
    return `根绝对路径 ${value}`;
  }

  return null;
}

function collectHtmlAttributeRefs(html) {
  const refs = [];
  const re = /\b(?:src|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"'=]+))/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    refs.push({ ref: m[2] ?? m[3] ?? m[4] ?? '', source: 'index.html' });
  }
  return refs;
}

function collectCssUrlRefs(css, source) {
  const refs = [];
  const re = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)]*?))\s*\)/gi;
  let m;
  while ((m = re.exec(css)) !== null) {
    refs.push({ ref: (m[1] ?? m[2] ?? m[3] ?? '').trim(), source });
  }
  return refs;
}

function collectInlineStyleRefs(html) {
  const refs = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    refs.push(...collectCssUrlRefs(m[1], 'index.html <style>'));
  }
  return refs;
}

function collectJsAbsoluteRefs(js, source) {
  const refs = [];
  const re = /(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    const value = m[2].trim();
    if (/^https?:\/\//i.test(value) || value.startsWith('//') || value.startsWith('/')) {
      refs.push({ ref: value, source, allowExternalOrigin: true });
    }
  }
  return refs;
}

function lintResourceRefs(html, gameDir, gameId, allowedOrigins) {
  const refs = [
    ...collectHtmlAttributeRefs(html),
    ...collectInlineStyleRefs(html),
  ];

  for (const filePath of walkDir(gameDir).sort()) {
    const rel = path.relative(gameDir, filePath).replace(/\\/g, '/');
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.css') {
      refs.push(...collectCssUrlRefs(fs.readFileSync(filePath, 'utf8'), rel));
    } else if (ext === '.js') {
      refs.push(...collectJsAbsoluteRefs(fs.readFileSync(filePath, 'utf8'), rel));
    }
  }

  const bad = [];
  for (const item of refs) {
    const reason = classifyResourceRef(item.ref, allowedOrigins, {
      allowExternalOrigin: item.allowExternalOrigin === true,
    });
    if (reason) bad.push(`${item.source}: ${reason}`);
  }

  if (bad.length) {
    throw new Error(
      `[${gameId}] 资源引用 lint 失败：\n` +
      bad.map((item) => `  - ${item}`).join('\n') +
      '\n请改为相对路径、/bridge-api/，或在 manifest.allowedOrigins 显式声明合法外部 origin。',
    );
  }
}

function normalizeSourceRoots(sourceRoots) {
  return sourceRoots.map((root) => ({
    source: String(root.source || 'online'),
    dir: path.resolve(root.dir),
  }));
}

function shouldCheckVersionDrift(options) {
  if (typeof options.checkVersionDrift === 'boolean') return options.checkVersionDrift;
  return /^(1|true)$/i.test(String(process.env.CI || ''));
}

async function fetchPreviousRegistry(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadPreviousRegistry(options) {
  if (!shouldCheckVersionDrift(options)) return null;
  if (options.previousRegistry) return options.previousRegistry;

  const url = options.previousRegistryUrl || process.env.PLAY_REGISTRY_PREVIOUS_URL || DEFAULT_PREVIOUS_REGISTRY_URL;
  try {
    return await fetchPreviousRegistry(url);
  } catch (error) {
    throw new Error(`version 漂移检查失败：无法读取上一次发布的 registry (${url}): ${error?.message || error}`);
  }
}

function validateVersionDrift(games, previousRegistry) {
  if (!previousRegistry || !Array.isArray(previousRegistry.games)) return;
  const previousById = new Map(previousRegistry.games.map((game) => [String(game.id || ''), game]));
  const errors = [];
  const warnings = [];

  for (const current of games) {
    const previous = previousById.get(current.id);
    if (!previous || !previous.sha256) continue;

    const sameVersion = String(previous.version || '') === current.version;
    const sameContent = String(previous.sha256 || '').toLowerCase() === current.sha256;
    if (!sameContent && sameVersion) {
      errors.push(`内容已变化但 version 未更新：${current.id}（仍为 ${current.version}）`);
    } else if (sameContent && !sameVersion) {
      warnings.push(`${current.id}: version 从 ${previous.version || '(empty)'} 改为 ${current.version}，但内容指纹未变化`);
    }
  }

  if (warnings.length) {
    warnings.forEach((item) => console.warn(`[registry] ${item}`));
  }
  if (errors.length) {
    throw new Error(`version 漂移检查失败：\n${errors.map((item) => `  - ${item}`).join('\n')}`);
  }
}

async function build(options = {}) {
  const sourceRoots = normalizeSourceRoots(options.sourceRoots || DEFAULT_SOURCE_ROOTS);
  const outFile = path.resolve(options.outFile || DEFAULT_OUT);
  const packagesDir = path.resolve(options.packagesDir || DEFAULT_PACKAGES_DIR);

  ensureCleanPackagesDir(packagesDir);
  const games = [];
  const seenIds = new Set();
  const seenPaths = new Set();

  for (const root of sourceRoots) {
    if (!fs.existsSync(root.dir)) continue;
    for (const ent of fs.readdirSync(root.dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const gameDir = path.join(root.dir, ent.name);
      const indexHtml = path.join(gameDir, 'index.html');
      if (!fs.existsSync(indexHtml)) continue;

      const html = fs.readFileSync(indexHtml, 'utf8');
      const manifest = extractManifestFromHtml(html);
      if (!manifest) throw new Error(`[${ent.name}] index.html 缺少内联 game-manifest`);

      const id = String(manifest.id || ent.name).trim();
      const version = String(manifest.version || '').trim();
      const publicPath = `games/${ent.name}/index.html`;
      if (!id) throw new Error(`[${ent.name}] manifest 缺少 id`);
      if (id !== ent.name) throw new Error(`[${ent.name}] manifest id 必须等于目录名: ${id}`);
      if (seenIds.has(id)) throw new Error(`id 重复：${id}`);
      if (seenPaths.has(publicPath)) throw new Error(`游戏发布路径重复：${publicPath}`);
      seenIds.add(id);
      seenPaths.add(publicPath);
      if (!SEMVER_RE.test(version)) throw new Error(`[${id}] version 非法 semver: ${version}`);

      const allowedOrigins = normalizeAllowedOrigins(manifest.allowedOrigins, id);
      lintResourceRefs(html, gameDir, id, allowedOrigins);

      const fp = fingerprintGame(gameDir);
      const pkg = writeGamePackage(gameDir, id, version, packagesDir, fp.files);
      games.push({
        id,
        title: manifest.title || id,
        description: manifest.description || '',
        version,
        source: root.source,
        devices: Array.isArray(manifest.devices) ? manifest.devices : [],
        params: Array.isArray(manifest.params) ? manifest.params : [],
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
        allowedOrigins,
        manifest: {
          ...manifest,
          id,
          title: manifest.title || id,
          description: manifest.description || '',
          version,
          devices: Array.isArray(manifest.devices) ? manifest.devices : [],
          params: Array.isArray(manifest.params) ? manifest.params : [],
          permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
          allowedOrigins,
        },
        path: publicPath,
        sha256: fp.sha256,
        size: fp.size,
        fileCount: fp.fileCount,
        files: fp.files,
        packageUrl: pkg.packageUrl,
        packageSha256: pkg.packageSha256,
        packageSize: pkg.packageSize,
        cacheable: true,
      });
    }
  }

  if (!games.length) throw new Error('未发现可发布游戏');
  games.sort((a, b) => a.id.localeCompare(b.id));

  const previousRegistry = await loadPreviousRegistry(options);
  validateVersionDrift(games, previousRegistry);

  const registry = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    games,
  };
  fs.writeFileSync(outFile, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log(`registry.json: ${games.length} games -> ${path.relative(ROOT, outFile)}`);
  games.forEach((g) => console.log(`  - ${g.id} v${g.version}  (${g.fileCount} files, ${g.size}B, package ${g.packageSize}B)`));
  return registry;
}

if (require.main === module) {
  build().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = {
  extractManifestFromHtml,
  build,
  MANIFEST_RE,
  DEFAULT_SOURCE_ROOTS,
  fingerprintGame,
  lintResourceRefs,
};
