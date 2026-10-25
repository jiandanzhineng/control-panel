// 主控端远程模式下开始玩法：/api/games/:id/start 必须先向被控端登记占用（ADR-0004 玩法唯一性），
// 被控端本地玩法运行中被拒时启动失败可见；/api/games/stop-current 释放占用。
const express = require('express');
const request = require('supertest');

jest.mock('../services/remoteSessionService', () => ({
  isOperatorRemoteMode: jest.fn(() => false),
  localPlay: jest.fn(() => null),
  occupyPlay: jest.fn(async () => ({ ok: true })),
  releasePlay: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/localAppProcessService', () => ({ stopAll: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/bridgeService', () => ({ exitCurrent: jest.fn(() => ({ ok: true })) }));
jest.mock('../services/gameService', () => ({
  getGameById: jest.fn((id) => (id === 'surge-edging' ? { id, name: '气压突变寸止', gamePath: '/games/x/index.html' } : null)),
}));
jest.mock('../game-runtime/gameHostService', () => ({
  isHostGame: (id) => id === 'surge-edging',
  start: jest.fn(() => ({
    sessionId: 'session-1', gameId: 'surge-edging', deviceMap: {}, runtimeMode: 'host', snapshot: { running: true },
  })),
  stop: jest.fn(() => ({ running: false })),
  getStatus: jest.fn(() => ({ running: false, snapshot: null })),
}));

const remoteSession = require('../services/remoteSessionService');
const gamesRouter = require('../routes/games');
const gameRuntimeRouter = require('../routes/gameRuntime');

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/games', gamesRouter);
  server.use('/api/game-runtime', gameRuntimeRouter);
  return server;
}

describe('remote play occupancy routes', () => {
  beforeEach(() => {
    remoteSession.isOperatorRemoteMode.mockReturnValue(false);
    remoteSession.occupyPlay.mockClear();
    remoteSession.releasePlay.mockClear();
    remoteSession.localPlay.mockReturnValue(null);
  });

  test('local mode never registers a play occupancy', async () => {
    await request(app()).post('/api/games/surge-edging/start').send({ deviceMapping: {}, parameters: {} }).expect(200);
    expect(remoteSession.occupyPlay).not.toHaveBeenCalled();
  });

  test('operator remote mode registers the occupancy with the game title', async () => {
    remoteSession.isOperatorRemoteMode.mockReturnValue(true);
    await request(app()).post('/api/games/surge-edging/start').send({ deviceMapping: {}, parameters: {} }).expect(200);
    expect(remoteSession.occupyPlay).toHaveBeenCalledWith({ gameId: 'surge-edging', gameName: '气压突变寸止' });
  });

  test('a refused occupancy fails the start visibly and never launches the game', async () => {
    remoteSession.isOperatorRemoteMode.mockReturnValue(true);
    const gameHost = require('../game-runtime/gameHostService');
    gameHost.start.mockClear();
    remoteSession.occupyPlay.mockRejectedValueOnce(
      Object.assign(new Error('被控端正在运行本地玩法'), { code: 'HOST_PLAY_ACTIVE' }),
    );
    const response = await request(app())
      .post('/api/games/surge-edging/start')
      .send({ deviceMapping: {}, parameters: {} })
      .expect(409);
    expect(response.body.error).toMatchObject({ code: 'HOST_PLAY_ACTIVE' });
    expect(gameHost.start).not.toHaveBeenCalled();
  });

  test('stop-current releases an occupancy the operator registered', async () => {
    remoteSession.isOperatorRemoteMode.mockReturnValue(true);
    remoteSession.localPlay.mockReturnValue({ gameId: 'surge-edging' });
    await request(app()).post('/api/games/stop-current').send({ gameId: 'surge-edging' }).expect(200);
    expect(remoteSession.releasePlay).toHaveBeenCalledWith({ gameId: 'surge-edging' });
  });

  test('stop-current without an occupancy does not publish a release', async () => {
    remoteSession.isOperatorRemoteMode.mockReturnValue(true);
    await request(app()).post('/api/games/stop-current').send({}).expect(200);
    expect(remoteSession.releasePlay).not.toHaveBeenCalled();
  });

  // 主控端本机 HostRuntime（/api/game-runtime/start）在远程模式下同样要登记占用：
  // 远程模式下设备页/运行页走的是这条本机接口，不是 /api/games/:id/start。
  test('host runtime start registers the occupancy in operator remote mode', async () => {
    remoteSession.isOperatorRemoteMode.mockReturnValue(true);
    await request(app())
      .post('/api/game-runtime/start')
      .send({ gameId: 'surge-edging', deviceMap: {} })
      .expect(201);
    expect(remoteSession.occupyPlay).toHaveBeenCalledWith({ gameId: 'surge-edging', gameName: 'surge-edging' });
  });

  test('host runtime start is refused when the host runs a local play (nothing starts)', async () => {
    remoteSession.isOperatorRemoteMode.mockReturnValue(true);
    const gameHost = require('../game-runtime/gameHostService');
    gameHost.start.mockClear();
    remoteSession.occupyPlay.mockRejectedValueOnce(
      Object.assign(new Error('被控端正在运行本地玩法'), { code: 'HOST_PLAY_ACTIVE' }),
    );
    const response = await request(app())
      .post('/api/game-runtime/start')
      .send({ gameId: 'surge-edging', deviceMap: {} })
      .expect(409);
    expect(response.body.error).toMatchObject({ code: 'HOST_PLAY_ACTIVE' });
    expect(gameHost.start).not.toHaveBeenCalled();
  });

  test('local host runtime start never registers an occupancy', async () => {
    await request(app()).post('/api/game-runtime/start').send({ gameId: 'surge-edging' }).expect(201);
    expect(remoteSession.occupyPlay).not.toHaveBeenCalled();
  });

  test('host runtime stop releases an occupancy the operator registered', async () => {
    remoteSession.isOperatorRemoteMode.mockReturnValue(true);
    remoteSession.localPlay.mockReturnValue({ gameId: 'surge-edging' });
    await request(app()).post('/api/game-runtime/stop').send({ reason: 'user_stop' }).expect(200);
    expect(remoteSession.releasePlay).toHaveBeenCalledWith({});
  });
});
