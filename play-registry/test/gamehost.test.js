// test/gamehost.test.js — 锁定 GameHost 桥接契约（三端一致）。
// 覆盖：宿主存在时启动只调一次 launch 且零 127.0.0.1 请求；无宿主时走 PC 探测；
// 缓存按钮委托 GameHost.cache；并发/重复点击不重复触发。
// 用 vm + 极简 DOM stub 加载真实的 play-launcher.js / game-list.js（无 jsdom 依赖）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const LAUNCHER_SRC = fs.readFileSync(path.join(ROOT, 'assets/js/play-launcher.js'), 'utf8');
const LIST_SRC = fs.readFileSync(path.join(ROOT, 'assets/js/game-list.js'), 'utf8');

const flush = () => new Promise((r) => setImmediate(r));

// ---------- 极简 DOM stub ----------
function makeEl(id) {
  const listeners = {};
  const el = {
    id,
    value: '',
    _text: '',
    _html: '',
    listeners,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, ev) { (listeners[type] || []).forEach((fn) => fn(ev)); },
    getAttribute(name) { return this['_attr_' + name] != null ? this['_attr_' + name] : null; },
    setAttribute(name, v) { this['_attr_' + name] = v; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    closest() { return null; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
  };
  return el;
}

// 构造 vm sandbox：window/document/fetch 等浏览器全局；记录 127.0.0.1 请求数。
function makeContext(options) {
  const opts = options || {};
  const elements = {};
  ['grid', 'search', 'filters', 'toast', 'stat-games', 'stat-devices', 'stat-caps',
    'modal', 'modal-status', 'modal-body', 'modal-start', 'modal-game-title'].forEach((id) => {
    elements[id] = makeEl(id);
  });

  const state = { localCalls: 0, fetchCalls: [] };
  function fetchImpl(url) {
    state.fetchCalls.push(String(url));
    if (String(url).indexOf('127.0.0.1') >= 0) state.localCalls++;
    if (String(url).indexOf('registry.json') >= 0) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ games: opts.games || [] }) });
    }
    // 默认：本机探测连不上
    return Promise.reject(new Error('no backend'));
  }

  const win = {};
  const document = {
    getElementById(id) { return elements[id] || null; },
    addEventListener() {},
    querySelectorAll() { return []; },
  };
  const sandbox = {
    window: win,
    document,
    fetch: fetchImpl,
    setTimeout: (fn) => { return 0; }, // 探测超时定时器：不真正触发
    clearTimeout: () => {},
    setImmediate,
    console,
    location: { href: 'https://site.example/', search: opts.search || '', assign() {}, },
    URL,
    URLSearchParams,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    sessionStorage: { setItem() {}, getItem() { return null; } },
    Promise,
    JSON,
  };
  win.GameHost = opts.gameHost || undefined;
  win.location = sandbox.location;
  vm.createContext(sandbox);
  sandbox.__state = state;
  sandbox.__elements = elements;
  return sandbox;
}

function loadLauncher(ctx) { vm.runInContext(LAUNCHER_SRC, ctx); }
function loadList(ctx) { vm.runInContext(LIST_SRC, ctx); }

// ---------- 测试 ----------

// 构造一个可控 promise 的宿主方法，便于测并发/重复点击。
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('GameHost.launch 存在时点击启动只调一次 launch，且零 127.0.0.1 请求', async () => {
  let launchCount = 0;
  let lastArg = null;
  const ctx = makeContext({
    gameHost: { launch(arg) { launchCount++; lastArg = arg; return Promise.resolve(); } },
  });
  loadLauncher(ctx);
  ctx.window.PlayLauncher.open({ id: 'demo', title: '演示' });
  await flush();
  assert.strictEqual(launchCount, 1, 'launch 应只被调用一次');
  assert.strictEqual(lastArg.v, 1, '请求含 v=1');
  assert.strictEqual(lastArg.gameId, 'demo', '请求含 gameId');
  assert.deepStrictEqual(Object.keys(lastArg).sort(), ['gameId', 'v'], '请求只含 v 和 gameId');
  assert.strictEqual(ctx.__state.localCalls, 0, '不得发起任何 127.0.0.1 请求');
});

test('GameHost 不存在时走现有 PC 127.0.0.1 探测流程', async () => {
  const ctx = makeContext({ gameHost: undefined });
  loadLauncher(ctx);
  ctx.window.PlayLauncher.open({ id: 'demo', title: '演示' });
  await flush();
  await flush();
  assert.ok(ctx.__state.localCalls > 0, '无宿主时应探测 127.0.0.1');
});

test('缓存按钮点击时调 GameHost.cache 一次', async () => {
  let cacheCount = 0;
  let lastArg = null;
  const ctx = makeContext({
    gameHost: { cache(arg) { cacheCount++; lastArg = arg; return Promise.resolve(); } },
  });
  loadLauncher(ctx);
  ctx.window.PlayLauncher.cache({ id: 'demo', title: '演示' });
  await flush();
  assert.strictEqual(cacheCount, 1);
  assert.strictEqual(lastArg.v, 1);
  assert.strictEqual(lastArg.gameId, 'demo');
  assert.deepStrictEqual(Object.keys(lastArg).sort(), ['gameId', 'v']);
  assert.strictEqual(ctx.__state.localCalls, 0);
});

test('并发/重复点击 launch 不重复触发（busy 生效）', async () => {
  let launchCount = 0;
  const d = deferred();
  const ctx = makeContext({
    gameHost: { launch() { launchCount++; return d.promise; } },
  });
  loadLauncher(ctx);
  const game = { id: 'demo', title: '演示' };
  ctx.window.PlayLauncher.open(game);
  ctx.window.PlayLauncher.open(game); // 第一次未结束，第二次应被忽略
  ctx.window.PlayLauncher.open(game);
  await flush();
  assert.strictEqual(launchCount, 1, '进行中时重复点击应被忽略');
  d.resolve();
  await flush();
  // 完成后再次点击可再触发
  ctx.window.PlayLauncher.open(game);
  await flush();
  assert.strictEqual(launchCount, 2, '前一请求结束后可再次触发');
});

test('并发/重复点击 cache 不重复触发（busy 生效）', async () => {
  let cacheCount = 0;
  const d = deferred();
  const ctx = makeContext({
    gameHost: { cache() { cacheCount++; return d.promise; } },
  });
  loadLauncher(ctx);
  const game = { id: 'demo', title: '演示' };
  const button = makeEl('cache-demo');
  ctx.window.PlayLauncher.cache(game, button);
  ctx.window.PlayLauncher.cache(game);
  await flush();
  assert.strictEqual(cacheCount, 1);
  assert.strictEqual(button.disabled, true, '请求期间应禁用按钮');
  assert.strictEqual(button.classList.contains('is-loading'), true, '请求期间应显示 loading');
  d.resolve();
  await flush();
  await flush();
  assert.strictEqual(button.disabled, false, '请求结束后应恢复按钮');
  assert.strictEqual(button.classList.contains('is-loading'), false, '请求结束后应关闭 loading');
});

test('GameHost 同步抛错时显示错误并释放 busy', async () => {
  let cacheCount = 0;
  const ctx = makeContext({
    gameHost: { cache() { cacheCount++; throw new Error('同步失败'); } },
  });
  loadLauncher(ctx);
  const game = { id: 'demo', title: '演示' };
  const button = makeEl('cache-demo');
  ctx.window.PlayLauncher.cache(game, button);
  await flush();
  await flush();

  assert.strictEqual(button.disabled, false, '同步异常后应恢复按钮');
  assert.strictEqual(button.classList.contains('is-loading'), false, '同步异常后应关闭 loading');
  assert.match(ctx.__elements.toast.textContent, /缓存失败.*同步失败/);

  ctx.window.PlayLauncher.cache(game, button);
  await flush();
  assert.strictEqual(cacheCount, 2, '同步异常后下一次请求仍应受理');
});

test('game-list 点击委托：data-cache → PlayLauncher.cache，data-launch → PlayLauncher.open', async () => {
  const ctx = makeContext({
    games: [{ id: 'demo', title: '演示', version: '1.0.0', devices: [] }],
  });
  // 注入一个 PlayLauncher 间谍
  const calls = { open: [], cache: [] };
  ctx.window.PlayLauncher = {
    open(g) { calls.open.push(g.id); },
    cache(g) { calls.cache.push(g.id); },
    closeModal() {},
  };
  loadList(ctx);
  await flush(); // 等 registry.json 加载并 render

  const grid = ctx.__elements.grid;
  function fakeTarget(attr, id) {
    return {
      closest(sel) {
        if (sel === '[' + attr + ']') return { getAttribute() { return id; } };
        return null;
      },
    };
  }
  grid.dispatch('click', { target: fakeTarget('data-cache', 'demo') });
  grid.dispatch('click', { target: fakeTarget('data-launch', 'demo') });

  assert.deepStrictEqual(calls.cache, ['demo'], '缓存按钮应触发 cache');
  assert.deepStrictEqual(calls.open, ['demo'], '启动按钮应触发 open');
});

test('cardHtml 渲染出 data-cache 和 data-launch 两个按钮', async () => {
  const ctx = makeContext({
    games: [{ id: 'demo', title: '演示', version: '1.0.0', devices: [] }],
  });
  ctx.window.PlayLauncher = { open() {}, cache() {}, closeModal() {} };
  loadList(ctx);
  await flush();
  const html = ctx.__elements.grid.innerHTML;
  assert.match(html, /data-cache="demo"/);
  assert.match(html, /data-launch="demo"/);
});

test('无宿主时 cache 给出明确提示且不触发 127.0.0.1', async () => {
  const ctx = makeContext({ gameHost: undefined });
  loadLauncher(ctx);
  ctx.window.PlayLauncher.cache({ id: 'demo', title: '演示' });
  await flush();
  assert.strictEqual(ctx.__state.localCalls, 0);
  assert.match(ctx.__elements.toast.textContent, /客户端|App/);
});
