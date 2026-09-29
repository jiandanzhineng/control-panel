// game-runtime-bridge.js 是纯浏览器 IIFE（挂 window.GameRuntimeBridge），
// 这里用 Node 注入 window/location/fetch 替身来验证命令映射与轮询行为。
const fs = require('fs');
const path = require('path');

const BRIDGE_PATH = path.join(__dirname, '..', 'public', 'game-runtime-bridge.js');
const code = fs.readFileSync(BRIDGE_PATH, 'utf8');

function loadBridge(search) {
  const calls = [];
  const listeners = [];
  const windowObj = {};
  const fetchMock = jest.fn(async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, json: async () => ({ active: true, authorized: true, snapshot: { running: true, gameId: 'surge-edging' } }) };
  });
  const timerIds = [];
  const fakeSetInterval = (fn, ms) => { timerIds.push({ fn, ms }); return timerIds.length; };
  const runner = new Function('window', 'location', 'fetch', 'setInterval', 'URLSearchParams', code);
  runner(windowObj, { search }, fetchMock, fakeSetInterval, URLSearchParams);
  return { bridge: windowObj.GameRuntimeBridge, calls, fetchMock, timerIds };
}

describe('game-runtime-bridge', () => {
  test('不带 runtime 参数时不暴露桥（页面保持自驱动）', () => {
    const { bridge } = loadBridge('');
    expect(bridge).toBeUndefined();
  });

  test('host 模式：轮询 /api/game-runtime/status，命令直达 game-runtime 接口', async () => {
    const { bridge, calls } = loadBridge('?runtime=host');
    expect(bridge.mode).toBe('host');
    let got = null;
    bridge.onSnapshot((status, snapshot) => { got = { status, snapshot }; });
    bridge.start();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(calls[0].url).toBe('/api/game-runtime/status');
    expect(got.snapshot.running).toBe(true);

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

  test('remote 模式：轮询 /api/remote-game/status，命令映射为白名单 command', async () => {
    const { bridge, calls, timerIds } = loadBridge('?runtime=remote');
    expect(bridge.mode).toBe('remote');
    bridge.start();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(calls[0].url).toBe('/api/remote-game/status');
    expect(timerIds[0].ms).toBe(1000);

    await bridge.sendAction('pause');
    await bridge.sendAction('shockOnce', {});
    await bridge.setParams({ duration: 30 });
    await bridge.stop();
    const posts = calls.filter((c) => c.body);
    expect(posts[0]).toEqual({ url: '/api/remote-game/command', body: { type: 'game.pause' } });
    expect(posts[1]).toEqual({ url: '/api/remote-game/command', body: { type: 'game.action', payload: { action: 'shockOnce', payload: {} } } });
    expect(posts[2]).toEqual({ url: '/api/remote-game/command', body: { type: 'game.setParams', payload: { params: { duration: 30 } } } });
    expect(posts[3]).toEqual({ url: '/api/remote-game/command', body: { type: 'game.stop' } });
  });
});
