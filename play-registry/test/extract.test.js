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

function sha256(buffer) {
  return require('node:crypto').createHash('sha256').update(buffer).digest('hex');
}

test('build 生成 schema v2 registry、逐文件清单和内容寻址 zip 包', async () => {
  await build({ checkVersionDrift: false });

  const registryPath = path.join(ROOT, 'registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.strictEqual(registry.schemaVersion, 2);
  assert.ok(Array.isArray(registry.games));
  assert.ok(registry.games.length > 0);

  for (const game of registry.games) {
    assert.strictEqual(game.cacheable, true);
    assert.match(game.packageSha256, /^[a-f0-9]{64}$/);
    assert.match(game.packageUrl, new RegExp(`^packages/${game.id}-${game.version}-${game.packageSha256.slice(0, 8)}\\.zip$`));
    assert.ok(game.packageSize > 0);
    assert.ok(Array.isArray(game.files), `${game.id} must expose files[]`);
    assert.strictEqual(game.files.length, game.fileCount);
    assert.strictEqual(game.size, game.files.reduce((sum, file) => sum + file.size, 0));
    assert.deepStrictEqual(game.files.map((file) => file.path), [...game.files.map((file) => file.path)].sort());
    assert.deepStrictEqual(game.allowedOrigins, []);
    assert.ok(game.manifest, `${game.id} must expose manifest`);
    assert.strictEqual(game.manifest.id, game.id);
    assert.deepStrictEqual(game.manifest.devices, game.devices);
    assert.deepStrictEqual(game.manifest.params, game.params);
    assert.deepStrictEqual(game.manifest.permissions, game.permissions);

    const packagePath = path.join(ROOT, game.packageUrl);
    assert.ok(fs.existsSync(packagePath), `${game.packageUrl} must exist`);
    assert.strictEqual(fs.statSync(packagePath).size, game.packageSize);
    assert.strictEqual(sha256(fs.readFileSync(packagePath)), game.packageSha256);
    const legacyPackagePath = path.join(ROOT, 'packages', `${game.id}-${game.version}.zip`);
    assert.ok(fs.existsSync(legacyPackagePath), `${game.id} legacy package must be retained for one release cycle`);
    assert.strictEqual(sha256(fs.readFileSync(legacyPackagePath)), game.packageSha256);

    const zip = new AdmZip(packagePath);
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory).map((entry) => entry.entryName).sort();
    assert.deepStrictEqual(entries, game.files.map((file) => file.path));
    assert.ok(entries.includes('index.html'), `${game.packageUrl} must include index.html`);
    assert.ok(entries.some((name) => name === 'game.js' || name.endsWith('/game.js')), `${game.packageUrl} must include game.js`);
    assert.ok(entries.every((name) => !name.startsWith('games/')), `${game.packageUrl} must be rooted at index.html`);
    for (const file of game.files) {
      const entry = zip.getEntry(file.path);
      assert.ok(entry, `${game.packageUrl} must include ${file.path}`);
      const data = entry.getData();
      assert.strictEqual(data.length, file.size);
      assert.strictEqual(sha256(data), file.sha256);
    }
  }
});

function writeFixtureGame(root, folder, manifest, options = {}) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'game.js'), options.gameJs || 'window.__fixtureGame = true;\n', 'utf8');
  if (options.extraFiles) {
    for (const [name, content] of Object.entries(options.extraFiles)) {
      const filePath = path.join(dir, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
    }
  }
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html>
<head>
<script id="game-manifest" type="application/json">
${JSON.stringify(manifest, null, 2)}
</script>
${options.extraHead || ''}
${options.scriptTag || '<script src="game.js"></script>'}
</head>
<body>${manifest.title}</body>
</html>
`, 'utf8');
  return dir;
}

test('build 合并默认游戏和网站扩展游戏', async () => {
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
    await build({
      sourceRoots: [
        { source: 'builtin', dir: builtinRoot },
        { source: 'online', dir: onlineRoot },
      ],
      outFile,
      packagesDir,
      checkVersionDrift: false,
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

test('build 拒绝默认游戏和网站扩展游戏使用重复 id', async () => {
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

    await assert.rejects(() => build({
      sourceRoots: [
        { source: 'builtin', dir: builtinRoot },
        { source: 'online', dir: onlineRoot },
      ],
      outFile: path.join(tmp, 'registry.json'),
      packagesDir: path.join(tmp, 'packages'),
      checkVersionDrift: false,
    }), /id 重复：same-id/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('build lint 拦截单引号和无引号的根绝对路径引用', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-lint-html-'));
  try {
    const gamesRoot = path.join(tmp, 'games');
    writeFixtureGame(gamesRoot, 'bad-html-ref', {
      id: 'bad-html-ref',
      title: 'Bad HTML Ref',
      version: '1.0.0',
      devices: [],
      params: [],
    }, {
      scriptTag: '<script src=\'/bad.js\'></script>\n<link href=/bad.css rel="stylesheet">',
    });

    await assert.rejects(() => build({
      sourceRoots: [{ source: 'online', dir: gamesRoot }],
      outFile: path.join(tmp, 'registry.json'),
      packagesDir: path.join(tmp, 'packages'),
      checkVersionDrift: false,
    }), /资源引用 lint 失败[\s\S]*\/bad\.js[\s\S]*\/bad\.css/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('build lint 拦截 HTML style 和独立 CSS 里的根绝对 url', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-lint-css-'));
  try {
    const gamesRoot = path.join(tmp, 'games');
    writeFixtureGame(gamesRoot, 'bad-css-ref', {
      id: 'bad-css-ref',
      title: 'Bad CSS Ref',
      version: '1.0.0',
      devices: [],
      params: [],
    }, {
      extraHead: '<style>.hero{background:url("/bad.png")}</style>\n<link rel="stylesheet" href="style.css">',
      extraFiles: { 'style.css': '.icon{background-image:url(/bad-icon.svg)}\n' },
    });

    await assert.rejects(() => build({
      sourceRoots: [{ source: 'online', dir: gamesRoot }],
      outFile: path.join(tmp, 'registry.json'),
      packagesDir: path.join(tmp, 'packages'),
      checkVersionDrift: false,
    }), /资源引用 lint 失败[\s\S]*\/bad\.png[\s\S]*\/bad-icon\.svg/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('build lint 要求 JS 绝对 URL 字面量显式声明 allowedOrigins', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-lint-js-'));
  try {
    const gamesRoot = path.join(tmp, 'games');
    writeFixtureGame(gamesRoot, 'bad-js-ref', {
      id: 'bad-js-ref',
      title: 'Bad JS Ref',
      version: '1.0.0',
      devices: [],
      params: [],
    }, {
      gameJs: "fetch('https://api.example.test/state');\n",
    });

    await assert.rejects(() => build({
      sourceRoots: [{ source: 'online', dir: gamesRoot }],
      outFile: path.join(tmp, 'registry.json'),
      packagesDir: path.join(tmp, 'packages'),
      checkVersionDrift: false,
    }), /allowedOrigins[\s\S]*https:\/\/api\.example\.test/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('build 将声明的 allowedOrigins 写入 registry 并放行对应 JS URL', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-allowed-origin-'));
  try {
    const gamesRoot = path.join(tmp, 'games');
    writeFixtureGame(gamesRoot, 'allowed-js-ref', {
      id: 'allowed-js-ref',
      title: 'Allowed JS Ref',
      version: '1.0.0',
      devices: [],
      params: [],
      permissions: ['camera'],
      allowedOrigins: ['https://api.example.test/path-is-ignored'],
    }, {
      gameJs: "fetch('https://api.example.test/state');\n",
    });

    const outFile = path.join(tmp, 'registry.json');
    await build({
      sourceRoots: [{ source: 'online', dir: gamesRoot }],
      outFile,
      packagesDir: path.join(tmp, 'packages'),
      checkVersionDrift: false,
    });

    const registry = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.deepStrictEqual(registry.games[0].allowedOrigins, ['https://api.example.test']);
    assert.deepStrictEqual(registry.games[0].permissions, ['camera']);
    assert.deepStrictEqual(registry.games[0].manifest.permissions, ['camera']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('allowedOrigins 不放行 HTML 或 CSS 的外部资源引用', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-allowed-origin-scope-'));
  try {
    const gamesRoot = path.join(tmp, 'games');
    writeFixtureGame(gamesRoot, 'external-asset-ref', {
      id: 'external-asset-ref',
      title: 'External Asset Ref',
      version: '1.0.0',
      devices: [],
      params: [],
      allowedOrigins: ['https://cdn.example.test'],
    }, {
      extraHead: '<link rel="stylesheet" href="https://cdn.example.test/game.css">',
    });

    await assert.rejects(() => build({
      sourceRoots: [{ source: 'online', dir: gamesRoot }],
      outFile: path.join(tmp, 'registry.json'),
      packagesDir: path.join(tmp, 'packages'),
      checkVersionDrift: false,
    }), /资源引用 lint 失败[\s\S]*https:\/\/cdn\.example\.test\/game\.css/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('build 在内容指纹变化但 version 未变化时拒绝发布', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-version-drift-'));
  try {
    const gamesRoot = path.join(tmp, 'games');
    writeFixtureGame(gamesRoot, 'drift-game', {
      id: 'drift-game',
      title: 'Drift Game',
      version: '1.0.0',
      devices: [],
      params: [],
    });

    await assert.rejects(() => build({
      sourceRoots: [{ source: 'online', dir: gamesRoot }],
      outFile: path.join(tmp, 'registry.json'),
      packagesDir: path.join(tmp, 'packages'),
      checkVersionDrift: true,
      previousRegistry: {
        schemaVersion: 2,
        games: [{ id: 'drift-game', version: '1.0.0', sha256: '0'.repeat(64) }],
      },
    }), /内容已变化但 version 未更新[\s\S]*drift-game/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
