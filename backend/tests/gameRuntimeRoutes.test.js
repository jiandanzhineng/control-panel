const express = require('express');
const request = require('supertest');

jest.mock('../services/bridgeService', () => ({
  exitCurrent: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/localAppProcessService', () => ({
  stopAll: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../game-runtime/gameHostService', () => ({
  isHostGame: (id) => id === 'surge-edging',
  start: jest.fn(() => ({
    sessionId: 'session-1',
    gameId: 'surge-edging',
    deviceMap: { sensor: ['s1'] },
    snapshot: { running: true, phase: 'INITIAL_CALM' },
    runtimeMode: 'host',
  })),
  stop: jest.fn(() => ({ running: false })),
  getStatus: jest.fn(() => ({
    running: true,
    runtimeMode: 'host',
    gameId: 'surge-edging',
    snapshot: { phase: 'INITIAL_CALM', running: true },
  })),
}));

const bridgeService = require('../services/bridgeService');
const gameHost = require('../game-runtime/gameHostService');
const gamesRouter = require('../routes/games');

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/games', gamesRouter);
  return server;
}

describe('host game routes', () => {
  test('status exposes the host runtime instead of a permanent idle stub', async () => {
    const res = await request(app()).get('/api/games/status');
    expect(res.status).toBe(200);
    expect(res.body.running).toBe(true);
    expect(res.body.runtimeMode).toBe('host');
    expect(res.body.snapshot.phase).toBe('INITIAL_CALM');
  });

  test('surge-edging start is delegated to the host runtime', async () => {
    const res = await request(app())
      .post('/api/games/surge-edging/start')
      .send({ deviceMapping: { sensor: 's1' }, parameters: { duration: 5 } });
    expect(res.status).toBe(200);
    expect(res.body.runtime.mode).toBe('host');
    expect(res.body.runtime.sessionId).toBe('session-1');
    expect(gameHost.start).toHaveBeenCalledWith(expect.objectContaining({
      gameId: 'surge-edging',
      deviceMap: { sensor: ['s1'] },
    }));
    expect(bridgeService.exitCurrent).toHaveBeenCalled();
  });

  test('deferred start does not launch the host and unknown games stay iframe-compatible', async () => {
    gameHost.start.mockClear();
    const deferred = await request(app())
      .post('/api/games/surge-edging/start')
      .send({ defer: true, deviceMapping: {}, parameters: {} });
    expect(deferred.body.runtime.mode).toBe('host');
    expect(deferred.body.deferred).toBe(true);
    expect(gameHost.start).not.toHaveBeenCalled();

    const missing = await request(app()).post('/api/games/not-a-game/start').send({});
    expect(missing.status).toBe(404);
  });

  test('stop-current stops both the host runtime and the bridge session', async () => {
    const res = await request(app()).post('/api/games/stop-current').send({});
    expect(res.status).toBe(200);
    expect(gameHost.stop).toHaveBeenCalled();
    expect(bridgeService.exitCurrent).toHaveBeenCalled();
  });
});
