// game-runtime-bridge.js 是纯浏览器 IIFE（挂 window.GameRuntimeBridge）。
// 新协议：SSE（snapshot 首帧 + patch 增量）为主，EventSource 不可用/失败时回落轮询。
// 这里用 Node 注入 window/location/fetch/EventSource/定时器替身来验证两种路径。
const fs = require('fs');
const path = require('path');

const BRIDGE_PATH = path.join(__dirname, '..', 'public', 'game-runtime-bridge.js');
const PATCH_PATH = path.join(__dirname, '..', 'public', 'game-state-patch.js');
const code = fs.readFileSync(BRIDGE_PATH, 'utf8');
const patchLib = require('../public/game-state-patch');

function fakeEventSource() {
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.handlers = {};
      this.onerror = null;
      instances.push(this);
    }
    addEventListener(type, handler) {
      (this.handlers[type] = this.handlers[type] || []).push(handler);
    }
    emit(type, data) {
      for (const handler of this.handlers[type] || []) handler({ data: JSON.stringify(data) });
    }
    fail() {
      if (this.onerror) this.onerror();
    }
    close() { this.closed = true; }
  }
  return { FakeEventSource, instances };
}

function loadBridge(search, statusBody, { withEventSource = true } = {}) {
  const calls = [];
  const windowObj = { GameStatePatch: patchLib };
  const fetchMock = jest.fn(async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: true,
      json: async () => statusBody || { active: true, authorized: true, snapshot: { running: true, gameId: 'surge-edging' } },
    };
  });
  const intervals = [];
  const timeouts = [];
  const timers = {
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout: () => {},
  };
  const { FakeEventSource, instances } = fakeEventSource();
  const documentObj = { createElement: () => ({}), head: { appendChild: () => {} } };
  const runner = new Function(
    'window', 'location', 'fetch', 'EventSource', 'document',
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'URLSearchParams',
    code,
  );
  runner(
    windowObj,
    { search },
    fetchMock,
    withEventSource ? FakeEventSource : undefined,
    documentObj,
    timers.setInterval, timers.clearInterval, timers.setTimeout, timers.clearTimeout,
    URLSearchParams,
  );
  return { bridge: windowObj.GameRuntimeBridge, calls, fetchMock, intervals, timeouts, sources: instances };
}

// 让 loadPatchLib / openStream 的微任务链跑完
async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('game-runtime-bridge', () => {
  test('不带 runtime 参数时不暴露桥（页面保持自驱动）', () => {
    const { bridge } = loadBridge('');
    expect(bridge).toBeUndefined();
  });

  test('host 模式：订阅 SSE，snapshot 首帧后应用增量 patch', async () => {
    const { bridge, calls, sources, intervals } = loadBridge('?runtime=host');
    expect(bridge.mode).toBe('host');
    let got = null;
    bridge.onSnapshot((status, snapshot) => { got = { status, snapshot }; });
    bridge.start();
    await settle();
    expect(sources[0].url).toBe('/api/game-runtime/stream');
    expect(intervals.length).toBe(0); // 有 SSE 就不轮询

    sources[0].emit('snapshot', {
      type: 'snapshot',
      rev: 1,
      state: {
        active: true,
        running: true,
        gameSessionId: 's1',
        snapshot: { running: true, gameId: 'surge-edging', currentPressure: 1 },
      },
    });
    expect(got.snapshot.running).toBe(true);
    expect(got.snapshot.currentPressure).toBe(1);

    sources[0].emit('patch', {
      type: 'patch',
      rev: 2,
      baseRev: 1,
      ops: [{ op: 'set', path: 'snapshot.currentPressure', value: 9 }],
    });
    expect(got.snapshot.currentPressure).toBe(9);
    expect(calls.length).toBe(0); // 推送通道不发任何 REST 请求

    await bridge.sendAction('pause');
    await bridge.sendAction('addIntensity', { delta: 10 });
    await bridge.setParams({ duration: 30 });
    await bridge.stop('user_stop');
    const posts = calls.filter((c) => c.body);
    expect(posts[0]).toEqual({ url: '/api/game-runtime/action', body: { action: 'pause', payload: {} } });
    expect(posts[1]).toEqual({ url: '/api/game-runtime/action', body: { action: 'addIntensity', payload: { delta: 10 } } });
    expect(posts[2]).toEqual({ url: '/api/game-runtime/params', body: { params: { duration: 30 } } });
    expect(posts[3]).toEqual({ url: '/api/game-runtime/stop', body: { reason: 'user_stop' } });
  });

  test('rev 断档：重开流补全量，不应用对不上的 patch', async () => {
    const { bridge, sources } = loadBridge('?runtime=host');
    let got = null;
    bridge.onSnapshot((status, snapshot) => { got = snapshot; });
    bridge.start();
    await settle();
    sources[0].emit('snapshot', { type: 'snapshot', rev: 3, state: { snapshot: { currentPressure: 3 } } });
    expect(got.currentPressure).toBe(3);
    sources[0].emit('patch', {
      type: 'patch', rev: 8, baseRev: 6, ops: [{ op: 'set', path: 'snapshot.currentPressure', value: 8 }],
    });
    expect(got.currentPressure).toBe(3);
    expect(sources[0].closed).toBe(true);
    expect(sources.length).toBe(2);
  });

  test('remote 模式：订阅 remote-game 流，命令映射为白名单 command', async () => {
    const { bridge, calls, sources } = loadBridge('?runtime=remote');
    expect(bridge.mode).toBe('remote');
    bridge.start();
    await settle();
    expect(sources[0].url).toBe('/api/remote-game/stream');
    sources[0].emit('snapshot', {
      type: 'snapshot',
      rev: 1,
      state: { active: true, authorized: true, snapshot: { running: true, gameId: 'surge-edging' } },
    });

    await bridge.sendAction('pause');
    await bridge.sendAction('shockOnce', {});
    await bridge.setParams({ duration: 30 });
    await bridge.stop();
    const posts = calls.filter((c) => c.body);
    expect(posts[0]).toEqual({ url: '/api/remote-game/command', body: { type: 'game.pause', payload: {} } });
    expect(posts[1]).toEqual({
      url: '/api/remote-game/command',
      body: { type: 'game.action', payload: { action: 'shockOnce', payload: {} } },
    });
    expect(posts[2]).toEqual({
      url: '/api/remote-game/command',
      body: { type: 'game.setParams', payload: { params: { duration: 30 } } },
    });
    expect(posts[3]).toEqual({ url: '/api/remote-game/command', body: { type: 'game.stop', payload: {} } });
  });

  test('remote 模式：带上 status 里的 gameSessionId，防止旧局命令误停新局', async () => {
    const { bridge, calls, sources } = loadBridge('?runtime=remote');
    bridge.start();
    await settle();
    sources[0].emit('snapshot', {
      type: 'snapshot',
      rev: 1,
      state: {
        active: true, authorized: true, gameSessionId: 'game-session-7',
        snapshot: { running: true, gameId: 'surge-edging' },
      },
    });
    await bridge.sendAction('pause');
    await bridge.sendAction('shockOnce', {});
    await bridge.setParams({ duration: 30 });
    await bridge.stop();
    const posts = calls.filter((c) => c.body);
    expect(posts[0].body).toEqual({ type: 'game.pause', payload: { gameSessionId: 'game-session-7' } });
    expect(posts[1].body).toEqual({
      type: 'game.action',
      payload: { action: 'shockOnce', payload: {}, gameSessionId: 'game-session-7' },
    });
    expect(posts[2].body).toEqual({
      type: 'game.setParams',
      payload: { params: { duration: 30 }, gameSessionId: 'game-session-7' },
    });
    expect(posts[3].body).toEqual({ type: 'game.stop', payload: { gameSessionId: 'game-session-7' } });
  });

  test('requestSnapshot：远程发补全量命令，本机重开流', async () => {
    const remote = loadBridge('?runtime=remote');
    remote.bridge.start();
    await settle();
    remote.sources[0].emit('snapshot', {
      type: 'snapshot', rev: 1, state: { active: true, gameSessionId: 's7', snapshot: { running: true } },
    });
    await remote.bridge.requestSnapshot();
    expect(remote.calls.filter((c) => c.body)[0].body).toEqual({
      type: 'game.snapshot.request', payload: { gameSessionId: 's7' },
    });

    const host = loadBridge('?runtime=host');
    host.bridge.start();
    await settle();
    await host.bridge.requestSnapshot();
    expect(host.sources.length).toBe(2); // 重开流拿全量
    expect(host.calls.filter((c) => c.body).length).toBe(0);
  });

  test('没有 EventSource 时回落到轮询 /api/.../status', async () => {
    const { bridge, calls, intervals, sources } = loadBridge('?runtime=host', null, { withEventSource: false });
    bridge.start();
    await settle();
    expect(sources.length).toBe(0);
    expect(intervals[0].ms).toBe(500);
    await Promise.resolve(); await Promise.resolve();
    expect(calls[0].url).toBe('/api/game-runtime/status');
  });

  test('host 模式不带 gameSessionId（保持本机行为不变）', async () => {
    const { bridge, calls, sources } = loadBridge('?runtime=host');
    bridge.start();
    await settle();
    sources[0].emit('snapshot', {
      type: 'snapshot', rev: 1, state: { active: true, running: true, sessionId: 'host-session-1', snapshot: { running: true } },
    });
    await bridge.sendAction('pause');
    await bridge.setParams({ duration: 30 });
    await bridge.stop('user_stop');
    const posts = calls.filter((c) => c.body);
    expect(posts[0].body).toEqual({ action: 'pause', payload: {} });
    expect(posts[1].body).toEqual({ params: { duration: 30 } });
    expect(posts[2].body).toEqual({ reason: 'user_stop' });
  });
});
