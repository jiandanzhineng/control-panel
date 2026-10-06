// 冒烟用：在本地服务上投一个 ZIP 游戏并批准发布。
// 用法：node tools/smoke-publish.js <gameId> <version> [token]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require(path.resolve(__dirname, '..', '..', 'play-registry', 'node_modules', 'adm-zip'));

const BASE = process.env.SMOKE_API_BASE || 'http://127.0.0.1:8787';
const TOKEN = process.env.SMOKE_TOKEN || 'author-token';
const ADMIN_TOKEN = process.env.SMOKE_ADMIN_TOKEN || 'admin-token';
const gameId = process.argv[2] || 'smoke-game-a';
const version = process.argv[3] || '1.0.0';

async function api(pathname, options, token) {
  const headers = Object.assign({}, (options && options.headers) || {});
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(BASE + pathname, Object.assign({}, options, { headers }));
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {}
  if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status} ${text}`);
  return data;
}

function makeZip() {
  const zip = new AdmZip();
  const manifest = { id: gameId, title: 'Smoke ' + gameId, description: '冒烟测试游戏', version, devices: [], params: [], permissions: [], allowedOrigins: [] };
  zip.addFile('index.html', Buffer.from(`<script id="game-manifest" type="application/json">${JSON.stringify(manifest)}</script><script src="game.js"></script>`));
  zip.addFile('game.js', Buffer.from('window.smokeGame = true;'));
  const file = path.join(os.tmpdir(), `smoke-${gameId}.zip`);
  fs.writeFileSync(file, zip.toBuffer());
  return file;
}

async function main() {
  const created = await api('/api/submissions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorName: 'Smoke Author', title: 'Smoke ' + gameId, description: '冒烟', kind: 'zip', gitUrl: '' })
  }, TOKEN);
  const submissionId = created.submission.id;
  const zipPath = makeZip();
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zipPath)], { type: 'application/zip' }), `${gameId}.zip`);
  await api(`/api/submissions/${encodeURIComponent(submissionId)}/local-upload`, { method: 'POST', body: form }, TOKEN);
  await api(`/api/submissions/${encodeURIComponent(submissionId)}/complete`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }, TOKEN);
  const published = await api(`/api/admin/submissions/${encodeURIComponent(submissionId)}/publish`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }, ADMIN_TOKEN);
  console.log(`published ${published.entry.id} v${published.entry.version}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
