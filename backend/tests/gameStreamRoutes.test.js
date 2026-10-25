// 画面同步 SSE：进流先给全量 snapshot，之后只给有变化的 patch（见 docs/architecture/split-game-contract.md）。
// 两个端点协议相同，只是状态文档不同：/api/game-runtime/stream（本机）与
// /api/remote-game/stream（远程会话状态）。
const express = require('express');
const http = require('http');

jest.mock('../services/remoteSessionService', () => ({
  isOperatorRemoteMode: () => false,
  localPlay: () => null,
  occupyPlay: jest.fn(async () => ({ ok: true })),
  releasePlay: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../game-runtime/gameCoreResolver', () => ({ listHostGames: () => [] }));

// 假宿主：mock 对象本身就是共享实例，测试可直接 emit / 数订阅者
jest.mock('../game-runtime/gameHostService', () => {
  const listeners = new Set();
  return {
    status: { active: true, running: true, runtimeMode: 'host', snapshot: { running: true, currentPressure: 1 } },
    getStatus() { return this.status; },
    getStateEvent() { return { rev: 7, state: this.status }; },
    subscribeState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) { for (const listener of listeners) listener(event); },
    subscriberCount: () => listeners.size,
  };
});

const gameHost = require('../game-runtime/gameHostService');
const remoteGame = require('../services/remoteGameService');

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/game-runtime', require('../routes/gameRuntime'));
  server.use('/api/remote-game', require('../routes/remoteGame'));
  return server;
}

// 逐帧读 SSE：收集 `event:` / `data:` 配对
function openStream(server, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    }, (res) => {
      const frames = [];
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const type = /event: (.+)/.exec(raw)?.[1]?.trim();
          const data = /data: (.+)/.exec(raw)?.[1];
          if (type && data) frames.push({ type, data: JSON.parse(data) });
          index = buffer.indexOf('\n\n');
        }
      });
      resolve({ req, res, frames });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('画面同步 SSE 端点', () => {
  let server;

  afterEach(async () => {
    gameHost.status = { active: true, running: true, runtimeMode: 'host', snapshot: { running: true, currentPressure: 1 } };
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  test('host 流：进流先给全量 snapshot，之后只给 patch', async () => {
    server = app().listen(0);
    const { req, res, frames } = await openStream(server, '/api/game-runtime/stream');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe('snapshot');
    expect(frames[0].data.rev).toBe(7);
    expect(frames[0].data.state.snapshot.currentPressure).toBe(1);

    gameHost.emit({ type: 'patch', rev: 8, baseRev: 7, ops: [{ op: 'set', path: 'snapshot.currentPressure', value: 9 }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frames.length).toBe(2);
    expect(frames[1]).toEqual({ type: 'patch', data: { type: 'patch', rev: 8, baseRev: 7, ops: [{ op: 'set', path: 'snapshot.currentPressure', value: 9 }] } });

    res.destroy();
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gameHost.subscriberCount()).toBe(0); // 断流后必须退订
  });

  test('remote 流：同一套帧格式，状态文档换成 remote-game 状态', async () => {
    server = app().listen(0);
    const { req, res, frames } = await openStream(server, '/api/remote-game/stream');
    expect(res.statusCode).toBe(200);
    expect(frames[0].type).toBe('snapshot');
    expect(frames[0].data.state).toMatchObject({ active: false, authorized: false });
    expect(typeof frames[0].data.rev).toBe('number');
    res.destroy();
    req.destroy();
  });
});
