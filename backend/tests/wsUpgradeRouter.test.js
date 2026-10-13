// WS upgrade 统一分发：/bridge 与 /voice-trigger 共用一个 http server，
// 谁都不认领的 upgrade 必须被立刻拒绝（400 + 销毁 socket），不能一直挂着。
const http = require('http');
const WebSocket = require('ws');

jest.mock('../services/logService', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  log: jest.fn(),
  cleanOldLogs: jest.fn(),
}));

jest.mock('../services/remoteSessionService', () => ({
  isOperatorRemoteMode: jest.fn(() => false),
}));

const wsUpgradeRouter = require('../services/wsUpgradeRouter');
const bridgeService = require('../services/bridgeService');
const voiceTriggerWs = require('../services/voiceTriggerWs');

jest.setTimeout(60000);

let server = null;
let port = 0;
const opened = [];

function open(pathname) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`);
  ws.messages = [];
  ws.on('message', (raw) => {
    try { ws.messages.push(JSON.parse(raw.toString())); } catch (_) {}
  });
  ws.on('error', () => {});
  opened.push(ws);
  return ws;
}

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === ws.OPEN) return resolve();
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

/** 未认领的路径：握手应当被拒（ws 客户端报 unexpected-response 400）。 */
function waitRejected(ws) {
  return new Promise((resolve, reject) => {
    ws.once('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    ws.once('open', () => reject(new Error('未知路径竟然握手成功')));
    ws.once('error', () => {});
    setTimeout(() => reject(new Error('等待 400 响应超时')), 8000);
  });
}

beforeAll(async () => {
  server = http.createServer();
  bridgeService.init(server);
  voiceTriggerWs.init(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  for (const ws of opened) {
    try { ws.terminate(); } catch (_) {}
  }
  voiceTriggerWs.closeAll();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('websocket upgrade router', () => {
  it('rejects an unknown upgrade path with 400 instead of leaving the socket hanging', async () => {
    const ws = open('/nope');
    const res = await waitRejected(ws);
    expect(res.status).toBe(400);
    // 被拒后服务端会销毁 socket（ws 客户端的 readyState 更新依赖后续 TCP 事件，
    // 这里直接看响应头与连接被关掉的事实，避免断言时序）
    expect(String(res.headers.connection || '').toLowerCase()).toBe('close');
  });

  it('still handshakes both known endpoints when both are registered', async () => {
    const bridge = open('/bridge');
    await waitOpen(bridge);
    const voice = open('/voice-trigger?phrase=start_game');
    await waitOpen(voice);
    expect(bridge.readyState).toBe(bridge.OPEN);
    expect(voice.readyState).toBe(voice.OPEN);
  });

  it('does not reject a path claimed by another endpoint', async () => {
    const voice = open('/voice-trigger?phrase=start_game');
    await waitOpen(voice);
    const bridge = open('/bridge');
    await waitOpen(bridge);
    expect(bridge.readyState).toBe(bridge.OPEN);
  });

  it('attaches the dispatcher to a server only once', () => {
    wsUpgradeRouter.resetForTest();
    const s = http.createServer();
    expect(wsUpgradeRouter.attach(s)).toBe(true);
    expect(wsUpgradeRouter.attach(s)).toBe(false);
    expect(s.listenerCount('upgrade')).toBe(1);
    s.close();
    // 恢复分发器（后续用例还要用）
    wsUpgradeRouter.attach(server);
    bridgeService.init(server);
    voiceTriggerWs.init(server);
  });

  it('skips servers without event support (placeholder objects in unit tests)', () => {
    expect(wsUpgradeRouter.attach({})).toBe(false);
    expect(wsUpgradeRouter.attach(null)).toBe(false);
  });

  it('matches paths ignoring the query string', () => {
    const match = wsUpgradeRouter.pathMatches('/bridge');
    expect(match('/bridge')).toBe(true);
    expect(match('/bridge?x=1')).toBe(true);
    expect(match('/bridge-extra')).toBe(false);
    expect(match('')).toBe(false);
    expect(match(undefined)).toBe(false);
  });
});
