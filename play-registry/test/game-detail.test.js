'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'assets/js/i18n.js'), 'utf8');
const DETAIL_SRC = fs.readFileSync(path.join(ROOT, 'assets/js/game-detail.js'), 'utf8');

const flush = () => new Promise((r) => setImmediate(r));

function makeEl(id) {
  const listeners = {};
  return {
    id,
    listeners,
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, ev) { (listeners[type] || []).forEach((fn) => fn(ev)); },
    closest() { return null; },
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) { this._html = v; },
    textContent: '',
  };
}

function makeContext(options) {
  const opts = options || {};
  const elements = {
    'detail-content': makeEl('detail-content'),
    toast: makeEl('toast'),
    modal: makeEl('modal'),
    'modal-cancel': makeEl('modal-cancel'),
  };
  const state = { fetchCalls: [] };
  const document = {
    getElementById(id) { return elements[id] || null; },
    addEventListener(type, fn) { (document.listeners[type] = document.listeners[type] || []).push(fn); },
    dispatchEvent(ev) { (document.listeners[ev.type] || []).forEach((fn) => fn(ev)); },
    querySelectorAll() { return []; },
    readyState: 'complete',
    documentElement: { lang: 'zh-CN' },
    listeners: {},
  };
  const sandbox = {
    window: {},
    document,
    fetch(url) {
      state.fetchCalls.push(String(url));
      if (String(url).indexOf('registry.json') >= 0) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ games: opts.games || [] }) });
      }
      return Promise.reject(new Error('unexpected ' + url));
    },
    location: {
      href: opts.href || 'https://site.example/game-intro.html?id=demo',
      search: opts.search || '?id=demo',
      pathname: opts.pathname || '/game-intro.html',
      protocol: opts.protocol || 'https:',
    },
    URL,
    URLSearchParams,
    localStorage: { getItem() { return opts.locale || 'zh'; }, setItem() {} },
    navigator: { language: 'zh-CN' },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    Promise,
    JSON,
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  sandbox.__state = state;
  sandbox.__elements = elements;
  return sandbox;
}

function load(ctx) {
  vm.runInContext(I18N_SRC, ctx);
  vm.runInContext(DETAIL_SRC, ctx);
}

const DEMO = {
  id: 'demo',
  title: '演示玩法',
  description: '这是中文介绍',
  version: '1.2.0',
  source: 'builtin',
  size: 2048,
  sha256: 'abcdef0123456789ffff',
  path: 'games/demo/index.html',
  devices: [
    { id: 'lock', label: '自动锁', required: true, capabilities: ['lock'] },
    { id: 'vibe', label: '振动', required: false, capabilities: ['strength'] },
  ],
  params: [
    { key: 'durationSec', label: '时长', unit: '秒', description: '最长时长' },
  ],
  manifest: {
    howTo: '1. 映射自动锁\n2. 开始后按提示操作',
    i18n: {
      en: {
        title: 'Demo play',
        description: 'English intro',
        howTo: '1. Map the lock\n2. Follow prompts',
        devices: { lock: 'Auto lock', vibe: 'Vibrator' },
        params: { durationSec: 'Duration' },
        paramDescriptions: { durationSec: 'Max duration' },
        paramUnits: { durationSec: 's' },
      },
    },
  },
};

test('介绍页从 registry 渲染标题、设备和启动按钮', async () => {
  const ctx = makeContext({ games: [DEMO] });
  const calls = { open: [], cache: [] };
  ctx.window.PlayLauncher = {
    open(g) { calls.open.push(g.id); },
    cache(g) { calls.cache.push(g.id); },
    closeModal() {},
  };
  load(ctx);
  await flush();
  await flush();
  const html = ctx.__elements['detail-content'].innerHTML;
  assert.match(html, /演示玩法/);
  assert.match(html, /自动锁/);
  assert.match(html, /data-launch="demo"/);
  assert.match(html, /data-cache="demo"/);
  assert.match(html, /官方内置|platformAuthor|平台作者/);
  assert.ok(ctx.__state.fetchCalls.some((u) => u.indexOf('registry.json') >= 0));
});

test('clean /games/:id.html 路径从站点根加载 registry', async () => {
  const ctx = makeContext({
    games: [DEMO],
    href: 'https://site.example/games/demo.html',
    search: '',
    pathname: '/games/demo.html',
  });
  load(ctx);
  await flush();
  await flush();
  assert.deepStrictEqual(ctx.__state.fetchCalls, ['/registry.json']);
  assert.match(ctx.__elements['detail-content'].innerHTML, /演示玩法/);
});

test('英文切换后使用 manifest.i18n.en', async () => {
  const ctx = makeContext({ games: [DEMO], locale: 'en' });
  load(ctx);
  await flush();
  await flush();
  const html = ctx.__elements['detail-content'].innerHTML;
  assert.match(html, /Demo play/);
  assert.match(html, /English intro/);
  assert.match(html, /Auto lock/);
  assert.match(html, /What you need/);
  assert.match(html, /Max duration/);
  assert.match(html, />s</);
});

test('启动按钮委托 PlayLauncher.open', async () => {
  const ctx = makeContext({ games: [DEMO] });
  const calls = { open: [] };
  ctx.window.PlayLauncher = { open(g) { calls.open.push(g.id); }, cache() {}, closeModal() {} };
  load(ctx);
  await flush();
  await flush();
  ctx.__elements['detail-content'].dispatch('click', {
    target: {
      closest(sel) {
        if (sel === '[data-cache]') return null;
        if (sel === '[data-launch]') return { getAttribute() { return 'demo'; } };
        return null;
      },
    },
  });
  assert.deepStrictEqual(calls.open, ['demo']);
});
