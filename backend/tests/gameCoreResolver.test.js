const fs = require('fs');
const os = require('os');
const path = require('path');
const { GameCoreResolver } = require('../game-runtime/gameCoreResolver');

const tempDirs = [];
let seq = 0;

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-resolver-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function manifestScript(manifest) {
  return `<script type="application/json" id="game-manifest">${JSON.stringify(manifest)}</script>`;
}

// 造一个真实的游戏包目录：index.html（内联 manifest）+ 可选核心文件
function makePackage(root, folder, { manifest, core } = {}) {
  const dir = path.join(root, folder);
  writeFile(path.join(dir, 'index.html'), `<!doctype html><html><body>${manifestScript(manifest)}</body></html>`);
  if (typeof core === 'string') writeFile(path.join(dir, 'game-core.js'), core);
  return dir;
}

const HOST_CORE = `
class PkgCore {
  constructor({ params, random } = {}) {
    this.params = params || {};
    this.random = random;
    this.started = false;
  }
  start(nowMs) { this.started = true; return { ok: true, snapshot: this.snapshot(), effects: [], nowMs }; }
  step({ nowMs } = {}) { return { ok: true, snapshot: this.snapshot(), effects: [], nowMs }; }
  snapshot() { return { gameId: 'pkg-game', marker: 'pkg-core', started: this.started, params: this.params }; }
  pause() {}
  resume() {}
  stop() {}
  setParams(params) { this.params = params || {}; }
  action() {}
}
module.exports = { PkgCore };
`;

const MISSING_STEP_CORE = `
class BrokenCore {
  constructor() {}
  start() {}
  snapshot() { return {}; }
  pause() {}
  resume() {}
  stop() {}
  setParams() {}
  action() {}
}
module.exports = { BrokenCore };
`;

// 收集所有测试用到的临时目录，结束后统一清理
function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pkgManifest(id, version, extra = {}) {
  return { id, title: `${id} 标题`, version, devices: [], params: [], ...extra };
}

function countingRead(counter) {
  return (filePath, ...rest) => {
    if (String(filePath).endsWith('game-core.js')) counter.count += 1;
    return fs.readFileSync(filePath, ...rest);
  };
}

// 注入版 resolver：games 根 / 缓存根都指向临时目录，安装列表由 packages 造出来
function makeResolver({ packages = [], now, readFile } = {}) {
  const gameRoot = makeTempDir();
  const cacheRoot = makeTempDir();
  const rows = [];
  for (const pkg of packages) {
    const rel = pkg.cached ? `${pkg.id}/${pkg.manifest.version}` : (pkg.folder || pkg.id);
    makePackage(pkg.cached ? cacheRoot : gameRoot, rel, pkg);
    rows.push({
      id: pkg.id,
      title: pkg.manifest.title,
      version: pkg.manifest.version,
      folder: rel,
      gamePath: pkg.cached
        ? `/games/cache/${rel}/index.html`
        : `/games/${rel}/index.html`,
    });
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const resolver = new GameCoreResolver({
    getGameById: (id) => byId.get(id) || null,
    listGames: () => Array.from(byId.values()),
    getGameRoot: () => gameRoot,
    getCacheRoot: () => cacheRoot,
    readFile: readFile || fs.readFileSync,
    now: now || (() => Date.now()),
  });
  return { resolver, gameRoot, cacheRoot, rows, byId };
}

function pkgGame({ id = 'pkg-game', version = '1.0.0', core = HOST_CORE, extra = {} } = {}) {
  return {
    id,
    cached: true,
    manifest: pkgManifest(id, version, { runtime: 'host', core: 'game-core.js', ...extra }),
    core,
  };
}

afterAll(() => {
  cleanupTempDirs();
});

describe('内置核心兜底', () => {
  test('surge-edging 返回可运行的内置核心', () => {
    const { resolver } = makeResolver();
    const core = resolver.createCore('surge-edging');
    expect(core.snapshot().gameId).toBe('surge-edging');
    const result = core.step({ nowMs: 0, events: [] });
    expect(typeof result).toBe('object');
    expect(result.snapshot).toBeTruthy();
    expect(Array.isArray(result.effects)).toBe(true);
  });

  test('pressure-edging-v2 返回可运行的内置核心', () => {
    const { resolver } = makeResolver();
    const core = resolver.createCore('pressure-edging-v2', { params: {}, random: () => 0.5 });
    expect(core.snapshot().gameId).toBe('pressure-edging-v2');
    const result = core.step({ nowMs: 0, events: [] });
    expect(result.snapshot).toBeTruthy();
    expect(Array.isArray(result.effects)).toBe(true);
  });

  test('未知 id 抛 GAME_NOT_HOSTED', () => {
    const { resolver } = makeResolver();
    expect(resolver.isHostGame('not-exist')).toBe(false);
    expect(() => resolver.createCore('not-exist')).toThrow(/尚未接入/);
    try {
      resolver.createCore('not-exist');
      throw new Error('should throw');
    } catch (error) {
      expect(error.code).toBe('GAME_NOT_HOSTED');
    }
  });
});

describe('包内宿主核心', () => {
  test('声明 runtime:host 的包会被加载并使用其核心', () => {
    const { resolver } = makeResolver({ packages: [pkgGame()] });
    expect(resolver.isHostGame('pkg-game')).toBe(true);
    const core = resolver.createCore('pkg-game', { params: { a: 1 } });
    const snap = core.snapshot();
    expect(snap.gameId).toBe('pkg-game');
    expect(snap.marker).toBe('pkg-core');
    expect(snap.params).toEqual({ a: 1 });
    const result = core.step({ nowMs: 0, events: [] });
    expect(result.ok).toBe(true);
  });

  test('resolveGamePackage 返回包目录、核心路径与 manifest', () => {
    const { resolver, cacheRoot } = makeResolver({ packages: [pkgGame()] });
    const pkg = resolver.resolveGamePackage('pkg-game');
    expect(pkg.source).toBe('package');
    expect(pkg.id).toBe('pkg-game');
    expect(pkg.version).toBe('1.0.0');
    expect(pkg.corePath).toBe(path.join(cacheRoot, 'pkg-game', '1.0.0', 'game-core.js'));
    expect(pkg.manifest.runtime).toBe('host');
    expect(resolver.resolveGamePackage('surge-edging')).toBeNull();
  });

  test('games 根下的包（非缓存）同样可解析', () => {
    const pkg = pkgGame({ id: 'local-pkg' });
    pkg.cached = false;
    pkg.folder = 'local-pkg';
    const { resolver, gameRoot } = makeResolver({ packages: [pkg] });
    const resolved = resolver.resolveGamePackage('local-pkg');
    expect(resolved.source).toBe('builtin');
    expect(resolved.dir).toBe(path.join(gameRoot, 'local-pkg'));
  });

  test('listHostGames 同时包含内置行与包行，包行 source 为 package', () => {
    const { resolver } = makeResolver({ packages: [pkgGame()] });
    const rows = resolver.listHostGames();
    const ids = rows.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining(['surge-edging', 'pressure-edging-v2', 'pkg-game']));
    const builtin = rows.find((row) => row.id === 'surge-edging');
    expect(builtin.source).toBe('builtin');
    expect(builtin.runtimeMode).toBe('host');
    expect(Array.isArray(builtin.params)).toBe(true);
    expect(builtin.params.length).toBeGreaterThan(0);
    const pkg = rows.find((row) => row.id === 'pkg-game');
    expect(pkg.source).toBe('package');
    expect(pkg.version).toBe('1.0.0');
  });

  test('同 id 的包行覆盖内置行', () => {
    const pkg = pkgGame({ id: 'surge-edging', version: '9.9.9' });
    const { resolver } = makeResolver({ packages: [pkg] });
    const rows = resolver.listHostGames();
    const row = rows.find((item) => item.id === 'surge-edging');
    expect(row.source).toBe('package');
    expect(row.version).toBe('9.9.9');
  });

  test('列表结果按 listTtlMs 缓存，避免热路径重复扫描', () => {
    const gameRoot = makeTempDir();
    const cacheRoot = makeTempDir();
    makePackage(cacheRoot, 'pkg-game/1.0.0', pkgGame());
    const row = { id: 'pkg-game', title: 'pkg', version: '1.0.0', folder: 'pkg-game/1.0.0', gamePath: '/games/cache/pkg-game/1.0.0/index.html' };
    let scans = 0;
    let clock = 1000;
    const resolver = new GameCoreResolver({
      getGameById: (id) => (id === 'pkg-game' ? row : null),
      listGames: () => { scans += 1; return [row]; },
      getGameRoot: () => gameRoot,
      getCacheRoot: () => cacheRoot,
      now: () => clock,
    });
    resolver.listHostGames();
    resolver.listHostGames();
    expect(scans).toBe(1);
    clock += 6000;
    resolver.listHostGames();
    expect(scans).toBe(2);
  });
});

describe('包内核心损坏', () => {
  test('核心语法错误 → GAME_CORE_INVALID，报错点名包与版本', () => {
    const pkg = pkgGame({ id: 'syntax-game', core: 'class BadCore { start( { ' });
    const { resolver } = makeResolver({ packages: [pkg] });
    let error = null;
    try {
      resolver.createCore('syntax-game');
    } catch (err) {
      error = err;
    }
    expect(error).toBeTruthy();
    expect(error.code).toBe('GAME_CORE_INVALID');
    expect(error.message).toContain('syntax-game');
  });

  test('核心缺少 step 方法 → GAME_CORE_INVALID 并列出缺失方法', () => {
    const pkg = pkgGame({ id: 'missing-step', core: MISSING_STEP_CORE });
    const { resolver } = makeResolver({ packages: [pkg] });
    let error = null;
    try {
      resolver.createCore('missing-step');
    } catch (err) {
      error = err;
    }
    expect(error).toBeTruthy();
    expect(error.code).toBe('GAME_CORE_INVALID');
    expect(error.message).toContain('step');
    expect(error.message).toContain('必要方法');
  });

  test('包内核心损坏但 id 有内置核心时回退，不抛错', () => {
    const pkg = pkgGame({ id: 'surge-edging', version: '1.4.1', core: MISSING_STEP_CORE });
    const { resolver } = makeResolver({ packages: [pkg] });
    const core = resolver.createCore('surge-edging');
    expect(core.snapshot().gameId).toBe('surge-edging');
    expect(core.constructor.name).toBe('SurgeEdgingCore');
    expect(resolver.lastError).toBeTruthy();
    expect(resolver.lastError.message).toContain('回退内置核心');
  });

  test('包内核心语法错误时同样回退内置核心', () => {
    const pkg = pkgGame({ id: 'pressure-edging-v2', version: '2.2.1', core: 'module.exports = {' });
    const { resolver } = makeResolver({ packages: [pkg] });
    const core = resolver.createCore('pressure-edging-v2');
    expect(core.snapshot().gameId).toBe('pressure-edging-v2');
    expect(resolver.lastError.message).toContain('pressure-edging-v2');
  });
});

describe('模块编译缓存', () => {
  test('同 id+version 只编译一次，换版本重新编译', () => {
    const pkgV1 = pkgGame({ id: 'ver-game', version: '1.0.0' });
    const pkgV2 = pkgGame({ id: 'ver-game', version: '2.0.0' });
    const counter = { count: 0 };
    const { resolver, cacheRoot } = makeResolver({ packages: [pkgV1], readFile: countingRead(counter) });
    resolver.createCore('ver-game');
    resolver.createCore('ver-game');
    expect(counter.count).toBe(1);

    makePackage(cacheRoot, 'ver-game/2.0.0', pkgV2);
    const row = { id: 'ver-game', version: '2.0.0', folder: 'ver-game/2.0.0', gamePath: '/games/cache/ver-game/2.0.0/index.html' };
    const resolver2 = new GameCoreResolver({
      getGameById: () => row,
      listGames: () => [row],
      getGameRoot: () => cacheRoot,
      getCacheRoot: () => cacheRoot,
      readFile: countingRead(counter),
    });
    resolver2.createCore('ver-game');
    resolver2.createCore('ver-game');
    expect(counter.count).toBe(2);
  });

  test('编译结果缓存：首次加载后改文件，行为仍是旧核心', () => {
    const pkg = pkgGame({ id: 'cache-game' });
    const { resolver, cacheRoot } = makeResolver({ packages: [pkg] });
    expect(resolver.createCore('cache-game').snapshot().marker).toBe('pkg-core');
    writeFile(path.join(cacheRoot, 'cache-game', '1.0.0', 'game-core.js'), HOST_CORE.replace('pkg-core', 'mutated-core'));
    expect(resolver.createCore('cache-game').snapshot().marker).toBe('pkg-core');
    resolver.clearCache();
    expect(resolver.createCore('cache-game').snapshot().marker).toBe('mutated-core');
  });
});

describe('非宿主包与不安全路径', () => {
  test('未声明 runtime:host 的包不进列表，也解析为 null', () => {
    const pkg = pkgGame({ id: 'plain-game' });
    delete pkg.manifest.runtime;
    delete pkg.manifest.core;
    const { resolver } = makeResolver({ packages: [pkg] });
    expect(resolver.resolveGamePackage('plain-game')).toBeNull();
    expect(resolver.isHostGame('plain-game')).toBe(false);
    expect(resolver.listHostGames().some((row) => row.id === 'plain-game')).toBe(false);
  });

  test('core 路径越出包目录被拒绝', () => {
    const pkg = pkgGame({ id: 'escape-game', extra: { core: '../evil.js' } });
    const { resolver } = makeResolver({ packages: [pkg] });
    let error = null;
    try {
      resolver.resolveGamePackage('escape-game');
    } catch (err) {
      error = err;
    }
    expect(error).toBeTruthy();
    expect(error.code).toBe('GAME_PACKAGE_UNSAFE_PATH');
    expect(error.message).toContain('../evil.js');
    expect(resolver.isHostGame('escape-game')).toBe(false);
    expect(resolver.lastError).toBeTruthy();
  });

  test('gamePath 含 .. 被拒绝', () => {
    const { resolver, byId } = makeResolver({ packages: [pkgGame()] });
    byId.get('pkg-game').gamePath = '/games/cache/../evil/index.html';
    expect(() => resolver.resolveGamePackage('pkg-game')).toThrow(/不安全/);
    try {
      resolver.resolveGamePackage('pkg-game');
    } catch (error) {
      expect(error.code).toBe('GAME_PACKAGE_UNSAFE_PATH');
    }
  });

  test('坏包不影响列表与 isHostGame', () => {
    const bad = pkgGame({ id: 'bad-game', extra: { core: '../evil.js' } });
    const { resolver } = makeResolver({ packages: [bad, pkgGame()] });
    expect(resolver.isHostGame('bad-game')).toBe(false);
    expect(resolver.isHostGame('pkg-game')).toBe(true);
    const rows = resolver.listHostGames();
    expect(rows.some((row) => row.id === 'pkg-game')).toBe(true);
    expect(resolver.lastError).toBeTruthy();
  });

  test('包内 core 是符号链接指向包外 → 拒绝（词法包含看不出来，必须比真实路径）', () => {
    const pkg = pkgGame({ id: 'symlink-game' });
    const { resolver, cacheRoot } = makeResolver({ packages: [pkg] });
    const corePath = path.join(cacheRoot, 'symlink-game', '1.0.0', 'game-core.js');
    const outside = path.join(makeTempDir(), 'evil-core.js');
    writeFile(outside, HOST_CORE);
    fs.rmSync(corePath, { force: true });
    fs.symlinkSync(outside, corePath, 'file');
    let error = null;
    try {
      resolver.resolveGamePackage('symlink-game');
    } catch (err) {
      error = err;
    }
    expect(error).toBeTruthy();
    expect(error.code).toBe('GAME_PACKAGE_UNSAFE_PATH');
    expect(error.message).toContain('符号链接');
    expect(resolver.isHostGame('symlink-game')).toBe(false);
  });

  test('包内 core 指向包内另一个文件的符号链接照常放行', () => {
    const pkg = pkgGame({ id: 'inner-link-game' });
    const { resolver, cacheRoot } = makeResolver({ packages: [pkg] });
    const dir = path.join(cacheRoot, 'inner-link-game', '1.0.0');
    const realCore = path.join(dir, 'real-core.js');
    writeFile(realCore, HOST_CORE);
    const corePath = path.join(dir, 'game-core.js');
    fs.rmSync(corePath, { force: true });
    fs.symlinkSync(realCore, corePath, 'file');
    const resolved = resolver.resolveGamePackage('inner-link-game');
    expect(resolved.corePath).toBe(fs.realpathSync(realCore));
    expect(resolver.createCore('inner-link-game').snapshot().marker).toBe('pkg-core');
  });
});
