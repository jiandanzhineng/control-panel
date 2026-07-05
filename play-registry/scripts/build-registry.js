#!/usr/bin/env node
// build-registry.js — 扫描 games/*/index.html，生成 registry.json。
// 设计要点（见 control-panel 仓 plan）：
//  - 内联 <script id="game-manifest"> 为唯一真相源
//  - extractManifestFromHtml 正则与面板侧 gameService.js 保持一致（双端 fixture 锁定）
//  - 校验：id 唯一、version 合法 semver
//  - 资源引用 lint：只允许相对路径或 /bridge-api/ 开头的绝对路径
//    （前缀式 proxy 不改写绝对 URL，根绝对路径会静默命中面板本地 /games 静态路由）
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games');
const OUT = path.join(ROOT, 'registry.json');
const SCHEMA_VERSION = 1;

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

function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// 整个游戏目录的内容指纹：对所有文件 (相对路径:文件sha256) 排序后整体 sha256。
function fingerprintGame(gameDir) {
  const files = walkDir(gameDir).sort();
  const parts = files.map((f) => {
    const rel = path.relative(gameDir, f).replace(/\\/g, '/');
    return `${rel}:${sha256OfFile(f)}`;
  });
  return {
    sha256: crypto.createHash('sha256').update(parts.join('\n')).digest('hex'),
    size: files.reduce((n, f) => n + fs.statSync(f).size, 0),
    fileCount: files.length,
  };
}

// 资源引用 lint：扫描 index.html 里所有 src=/href= 的值。
function lintResourceRefs(html, gameId) {
  const refs = [];
  const re = /\b(?:src|href)\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) refs.push(m[1]);
  const bad = [];
  for (const ref of refs) {
    // 允许：相对路径（不以 / 开头）、/bridge-api/ 前缀、内联 data:/blob:。
    if (/^data:/i.test(ref) || /^blob:/i.test(ref) || /^mailto:/i.test(ref)) continue;
    if (ref.startsWith('/bridge-api/')) continue;
    if (!ref.startsWith('/')) continue; // 相对路径 OK
    bad.push(ref);
  }
  if (bad.length) {
    throw new Error(`[${gameId}] 资源引用 lint 失败：发现根绝对路径 ${JSON.stringify(bad)}。前缀式 proxy 不改写绝对 URL，根绝对路径会静默命中面板本地 /games 静态路由。请改为相对路径。`);
  }
}

function build() {
  if (!fs.existsSync(GAMES_DIR)) throw new Error('games 目录不存在');
  const games = [];
  const seenIds = new Set();
  for (const ent of fs.readdirSync(GAMES_DIR, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const gameDir = path.join(GAMES_DIR, ent.name);
    const indexHtml = path.join(gameDir, 'index.html');
    if (!fs.existsSync(indexHtml)) continue;
    const html = fs.readFileSync(indexHtml, 'utf8');
    const manifest = extractManifestFromHtml(html);
    if (!manifest) throw new Error(`[${ent.name}] index.html 缺少内联 game-manifest`);
    lintResourceRefs(html, ent.name);

    const id = String(manifest.id || ent.name).trim();
    const version = String(manifest.version || '').trim();
    if (!id) throw new Error(`[${ent.name}] manifest 缺少 id`);
    if (seenIds.has(id)) throw new Error(`id 重复：${id}`);
    seenIds.add(id);
    if (!SEMVER_RE.test(version)) throw new Error(`[${id}] version 非法 semver: ${version}`);

    const fp = fingerprintGame(gameDir);
    games.push({
      id,
      title: manifest.title || id,
      description: manifest.description || '',
      version,
      devices: Array.isArray(manifest.devices) ? manifest.devices : [],
      params: Array.isArray(manifest.params) ? manifest.params : [],
      path: `games/${ent.name}/index.html`,
      sha256: fp.sha256,
      size: fp.size,
      fileCount: fp.fileCount,
    });
  }
  games.sort((a, b) => a.id.localeCompare(b.id));
  const registry = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    games,
  };
  fs.writeFileSync(OUT, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log(`registry.json: ${games.length} games → ${path.relative(ROOT, OUT)}`);
  games.forEach((g) => console.log(`  - ${g.id} v${g.version}  (${g.fileCount} files, ${g.size}B)`));
}

if (require.main === module) {
  try { build(); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { extractManifestFromHtml, build, MANIFEST_RE };
