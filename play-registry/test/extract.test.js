// test/extract.test.js — 锁定 extractManifestFromHtml 的行为，防与面板侧漂移。
// 面板侧 backend/services/gameService.js 用同一正则；任一方改正则，此 fixture 会立刻暴露。
// 运行：npm test（node --test）
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { extractManifestFromHtml, build, MANIFEST_RE } = require('../scripts/build-registry');

const ROOT = path.resolve(__dirname, '..');

// 固定 fixture：覆盖 id 在最前 / type 在前 两种写法，确保正则都匹配。
const CASE_TYPE_FIRST = `<html><head>
<script type="application/json" id="game-manifest">
{ "id": "demo", "title": "演示", "version": "1.2.3", "devices": [], "params": [] }
</script></head><body></body></html>`;

const CASE_ID_FIRST = `<html><head>
<script id="game-manifest" type="application/json">
{ "id": "demo2", "title": "演示2", "version": "0.9.0" }
</script></head><body></body></html>`;

const CASE_NO_MANIFEST = `<html><head></head><body>no manifest here</body></html>`;

test('提取 type 在前的 manifest', () => {
  const m = extractManifestFromHtml(CASE_TYPE_FIRST);
  assert.strictEqual(m.id, 'demo');
  assert.strictEqual(m.title, '演示');
  assert.strictEqual(m.version, '1.2.3');
});

test('提取 id 在最前的 manifest（旧正则 [^>]+id 会失配，新正则 [^>]*\\bid 通过）', () => {
  const m = extractManifestFromHtml(CASE_ID_FIRST);
  assert.ok(m, 'id 在最前的写法必须能匹配');
  assert.strictEqual(m.id, 'demo2');
});

test('无 manifest 返回 null', () => {
  assert.strictEqual(extractManifestFromHtml(CASE_NO_MANIFEST), null);
});

test('正则字面量导出（供双端一致性人工核对）', () => {
  assert.ok(MANIFEST_RE instanceof RegExp);
});

test('build 生成 registry 包元数据和完整 zip 包', () => {
  build();

  const registryPath = path.join(ROOT, 'registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.ok(Array.isArray(registry.games));
  assert.ok(registry.games.length > 0);

  for (const game of registry.games) {
    assert.strictEqual(game.cacheable, true);
    assert.match(game.packageUrl, /^packages\/.+\.zip$/);
    assert.match(game.packageSha256, /^[a-f0-9]{64}$/);
    assert.ok(game.packageSize > 0);

    const packagePath = path.join(ROOT, game.packageUrl);
    assert.ok(fs.existsSync(packagePath), `${game.packageUrl} must exist`);
    assert.strictEqual(fs.statSync(packagePath).size, game.packageSize);

    const zip = new AdmZip(packagePath);
    const entries = zip.getEntries().map((entry) => entry.entryName);
    assert.ok(entries.includes('index.html'), `${game.packageUrl} must include index.html`);
    assert.ok(entries.some((name) => name === 'game.js' || name.endsWith('/game.js')), `${game.packageUrl} must include game.js`);
    assert.ok(entries.every((name) => !name.startsWith('games/')), `${game.packageUrl} must be rooted at index.html`);
  }
});

function writeFixtureGame(root, folder, manifest) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'game.js'), 'window.__fixtureGame = true;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html>
<head>
<script id="game-manifest" type="application/json">
${JSON.stringify(manifest, null, 2)}
</script>
<script src="game.js"></script>
</head>
<body>${manifest.title}</body>
</html>
`, 'utf8');
  return dir;
}

test('build 合并默认游戏和网站扩展游戏', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-merge-'));
  try {
    const builtinRoot = path.join(tmp, 'backend-games');
    const onlineRoot = path.join(tmp, 'online-games');
    writeFixtureGame(builtinRoot, 'builtin-default', {
      id: 'builtin-default',
      title: '默认游戏',
      version: '1.0.0',
      devices: [],
      params: [],
    });
    writeFixtureGame(onlineRoot, 'online-extra', {
      id: 'online-extra',
      title: '网站扩展游戏',
      version: '1.1.0',
      devices: [],
      params: [],
    });

    const outFile = path.join(tmp, 'registry.json');
    const packagesDir = path.join(tmp, 'packages');
    build({
      sourceRoots: [
        { source: 'builtin', dir: builtinRoot },
        { source: 'online', dir: onlineRoot },
      ],
      outFile,
      packagesDir,
    });

    const registry = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.deepStrictEqual(registry.games.map((game) => game.id), ['builtin-default', 'online-extra']);
    assert.deepStrictEqual(registry.games.map((game) => game.source), ['builtin', 'online']);
    assert.strictEqual(registry.games[0].path, 'games/builtin-default/index.html');
    assert.strictEqual(registry.games[1].path, 'games/online-extra/index.html');
    for (const game of registry.games) {
      assert.ok(fs.existsSync(path.join(tmp, game.packageUrl)), `${game.packageUrl} must exist`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('build 拒绝默认游戏和网站扩展游戏使用重复 id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-duplicate-'));
  try {
    const builtinRoot = path.join(tmp, 'backend-games');
    const onlineRoot = path.join(tmp, 'online-games');
    writeFixtureGame(builtinRoot, 'same-id', {
      id: 'same-id',
      title: '默认游戏',
      version: '1.0.0',
      devices: [],
      params: [],
    });
    writeFixtureGame(onlineRoot, 'same-id', {
      id: 'same-id',
      title: '网站扩展游戏',
      version: '1.0.0',
      devices: [],
      params: [],
    });

    assert.throws(() => build({
      sourceRoots: [
        { source: 'builtin', dir: builtinRoot },
        { source: 'online', dir: onlineRoot },
      ],
      outFile: path.join(tmp, 'registry.json'),
      packagesDir: path.join(tmp, 'packages'),
    }), /id 重复：same-id/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
