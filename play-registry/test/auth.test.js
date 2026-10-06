// test/auth.test.js — 锁定 SiteAuth 的纯逻辑：回跳地址校验、存储优先级、登录/过期处理。
// 用 vm + 极简 stub 加载真实的 assets/js/auth.js（不依赖 jsdom）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'assets/js/auth.js'), 'utf8');

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

function makeElement() {
  const el = {
    className: '',
    textContent: '',
    hidden: false,
    children: [],
    attributes: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] == null ? null : this.attributes[k]; },
    addEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { children.forEach((c) => this.children.push(c)); },
    replaceChildren(...children) { this.children = children; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

// 每个用例一个干净的沙箱：可传入 location、fetch 与预置存储。
function makeContext(options) {
  const opts = options || {};
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  (opts.local || []).forEach(([k, v]) => localStorage.setItem(k, v));
  (opts.session || []).forEach(([k, v]) => sessionStorage.setItem(k, v));

  const location = Object.assign({
    href: 'https://game.example/submit.html',
    pathname: '/submit.html',
    search: '',
    hash: '',
    replaced: [],
    assigned: [],
    replace(url) { this.replaced.push(url); },
    assign(url) { this.assigned.push(url); },
  }, opts.location || {});

  const document = {
    readyState: 'complete',
    currentScript: { src: 'https://game.example/assets/js/auth.js' },
    addEventListener() {},
    dispatchEvent() {},
    querySelectorAll() { return []; },
    createElement: () => makeElement(),
  };

  const calls = [];
  const fetchImpl = opts.fetch || function () {
    return Promise.reject(new Error('unexpected fetch'));
  };

  const sandbox = {
    console,
    URL,
    Promise,
    Object,
    JSON,
    Array,
    String,
    Number,
    Math,
    Date,
    Error,
    RegExp,
    setTimeout,
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    localStorage,
    sessionStorage,
    location,
    document,
    GamePlatformConfig: { apiBase: 'https://api.example', identityApiBase: 'https://id.example' },
    addEventListener() {},
    fetch(url, init) { calls.push({ url: String(url), init: init || {} }); return fetchImpl(String(url), init || {}); },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { auth: sandbox.SiteAuth, sandbox, localStorage, sessionStorage, location, calls };
}

const jsonResponse = (status, body) => Promise.resolve({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(body == null ? '' : JSON.stringify(body)),
});

const flush = () => new Promise((r) => setImmediate(r));

// ---------- 回跳地址校验 ----------

test('consumeReturn 只接受站内相对路径', () => {
  const cases = [
    ['submit.html', 'https://game.example/submit.html'],
    ['docs/contribute.html', 'https://game.example/docs/contribute.html'],
    ['game-intro.html?id=demo#top', 'https://game.example/game-intro.html?id=demo#top'],
    ['', 'https://game.example/submit.html'],
    ['//evil.example/x', 'https://game.example/submit.html'],
    ['http://evil.example/x', 'https://game.example/submit.html'],
    ['javascript:alert(1)', 'https://game.example/submit.html'],
    ['/submit.html', 'https://game.example/submit.html'],
    ['../../etc/passwd', 'https://game.example/submit.html'],
    ['..%2f..%2fetc/passwd', 'https://game.example/submit.html'],
    ['login.html', 'https://game.example/submit.html'],
  ];
  for (const [stored, expected] of cases) {
    const { auth } = makeContext({ session: [['auth-return', stored]] });
    assert.strictEqual(auth.consumeReturn(), expected, `stored=${JSON.stringify(stored)}`);
  }
});

test('consumeReturn 读完即删，第二次回落到默认页', () => {
  const { auth, sessionStorage } = makeContext({ session: [['auth-return', 'docs/contribute.html']] });
  assert.strictEqual(auth.consumeReturn(), 'https://game.example/docs/contribute.html');
  assert.strictEqual(sessionStorage.getItem('auth-return'), null);
  assert.strictEqual(auth.consumeReturn(), 'https://game.example/submit.html');
});

test('docs 子目录下站内回跳仍然可用', () => {
  const { auth } = makeContext({
    location: { pathname: '/docs/devices.html', href: 'https://game.example/docs/devices.html' },
    session: [['auth-return', '../submit.html']],
  });
  assert.strictEqual(auth.consumeReturn(), 'https://game.example/submit.html');
});

test('requireLogin 无 token 时记录当前页并跳登录页', () => {
  const { auth, sessionStorage, location } = makeContext({
    location: { pathname: '/docs/devices.html', search: '?a=1', hash: '#x', href: 'https://game.example/docs/devices.html' },
  });
  assert.strictEqual(auth.requireLogin(), false);
  assert.deepStrictEqual(location.replaced, ['https://game.example/login.html']);
  assert.strictEqual(sessionStorage.getItem('auth-return'), 'docs/devices.html?a=1#x');
});

test('requireLogin 有 token 时直接放行', () => {
  const { auth, location } = makeContext({ local: [['game-platform-mobile-token', 't1']] });
  assert.strictEqual(auth.requireLogin(), true);
  assert.deepStrictEqual(location.replaced, []);
});

// ---------- 存储 ----------

test('localStorage 优先，sessionStorage 里的旧会话仍可读', () => {
  const both = makeContext({
    local: [['game-platform-mobile-token', 'local-token'], ['game-platform-user', '{"email":"a@b.com","role":"admin"}']],
    session: [['game-platform-mobile-token', 'session-token']],
  });
  assert.strictEqual(both.auth.token(), 'local-token');
  assert.strictEqual(both.auth.user().email, 'a@b.com');
  assert.strictEqual(both.auth.isLoggedIn(), true);

  const legacy = makeContext({ session: [['game-platform-mobile-token', 'session-token']] });
  assert.strictEqual(legacy.auth.token(), 'session-token');
});

// ---------- 登录 / 校验 / 过期 ----------

test('login 用平台 /api/auth/me 的 role 覆盖身份，remember=false 存 sessionStorage', async () => {
  const ctx = makeContext({
    fetch: (url) => {
      if (url === 'https://id.example/auth/login') return jsonResponse(200, { token: 'tok', user: { email: 'a@b.com' } });
      if (url === 'https://api.example/api/auth/me') return jsonResponse(200, { user: { email: 'a@b.com', role: 'admin' } });
      return jsonResponse(404, {});
    },
  });
  const user = await ctx.auth.login({ email: 'a@b.com', password: 'password1', remember: false });
  assert.strictEqual(user.role, 'admin');
  assert.strictEqual(ctx.sessionStorage.getItem('game-platform-mobile-token'), 'tok');
  assert.strictEqual(ctx.localStorage.getItem('game-platform-mobile-token'), null);
  const sent = JSON.parse(ctx.calls[0].init.body);
  assert.deepStrictEqual(sent, { email: 'a@b.com', password: 'password1' });
});

test('login 后 /api/auth/me 非 401 失败时保留身份服务返回的会话', async () => {
  const ctx = makeContext({
    fetch: (url) => {
      if (url === 'https://id.example/auth/login') return jsonResponse(200, { token: 'tok', user: { email: 'a@b.com', role: 'user' } });
      return Promise.reject(new Error('offline'));
    },
  });
  const user = await ctx.auth.login({ email: 'a@b.com', password: 'password1', remember: true });
  assert.strictEqual(user.role, 'user');
  assert.strictEqual(ctx.localStorage.getItem('game-platform-mobile-token'), 'tok');
});

test('平台接口 401 视为会话过期：清空本地并抛出可本地化的错误', async () => {
  const ctx = makeContext({
    local: [['game-platform-mobile-token', 'tok'], ['game-platform-user', '{"email":"a@b.com","role":"user"}']],
    fetch: () => jsonResponse(401, { error: { code: 'unauthorized', message: 'Invalid token' } }),
  });
  await assert.rejects(() => ctx.auth.api('/api/submissions'), (err) => {
    assert.strictEqual(err.status, 401);
    assert.strictEqual(err.message, '登录已过期，请重新登录。');
    return true;
  });
  assert.strictEqual(ctx.auth.token(), '');
  assert.strictEqual(ctx.auth.isLoggedIn(), false);
});

test('verify 遇到 401 返回 null，遇到网络错误回落到缓存用户', async () => {
  const expired = makeContext({
    local: [['game-platform-mobile-token', 'tok'], ['game-platform-user', '{"email":"a@b.com","role":"user"}']],
    fetch: () => jsonResponse(401, {}),
  });
  assert.strictEqual(await expired.auth.verify(), null);

  const offline = makeContext({
    local: [['game-platform-mobile-token', 'tok'], ['game-platform-user', '{"email":"a@b.com","role":"admin"}']],
    fetch: () => Promise.reject(new Error('offline')),
  });
  const cached = await offline.auth.verify();
  assert.strictEqual(cached.email, 'a@b.com');
  assert.strictEqual(cached.role, 'admin');
});

test('本地化的错误文案：409 / 400 / 429 / 500 / 网络失败', async () => {
  const cases = [
    [409, '该邮箱已注册，请直接登录。'],
    [400, '提交的内容不符合要求，请检查后重试。'],
    [429, '操作过于频繁，请稍后再试。'],
    [500, '服务器开小差了，请稍后再试。'],
  ];
  for (const [status, message] of cases) {
    const ctx = makeContext({ fetch: () => jsonResponse(status, { error: { message: 'server text' } }) });
    await assert.rejects(() => ctx.auth.identity('/auth/login', { method: 'POST', body: '{}' }), (err) => {
      assert.strictEqual(err.status, status);
      assert.strictEqual(err.message, message);
      return true;
    });
  }

  const net = makeContext({ fetch: () => Promise.reject(new Error('failed to fetch')) });
  await assert.rejects(() => net.auth.identity('/auth/login', { method: 'POST', body: '{}' }), (err) => {
    assert.strictEqual(err.status, 0);
    assert.strictEqual(err.message, '网络连接失败，请检查网络后重试。');
    return true;
  });
});

test('logout 即使身份服务报错也清空本地会话', async () => {
  const ctx = makeContext({
    local: [['game-platform-mobile-token', 'tok'], ['game-platform-user', '{"email":"a@b.com","role":"user"}']],
    fetch: () => Promise.reject(new Error('offline')),
  });
  await ctx.auth.logout();
  assert.strictEqual(ctx.auth.token(), '');
  assert.strictEqual(ctx.auth.user(), null);
});

test('register 走身份服务 /auth/register 并沿用同一套登录流程', async () => {
  const ctx = makeContext({
    fetch: (url) => {
      if (url === 'https://id.example/auth/register') return jsonResponse(201, { token: 'tok2', user: { email: 'n@b.com' } });
      if (url === 'https://api.example/api/auth/me') return jsonResponse(200, { user: { email: 'n@b.com', role: 'user' } });
      return jsonResponse(404, {});
    },
  });
  const user = await ctx.auth.register({ email: 'n@b.com', password: 'password1', remember: true });
  assert.strictEqual(user.email, 'n@b.com');
  assert.strictEqual(ctx.localStorage.getItem('game-platform-mobile-token'), 'tok2');
  await flush();
});
