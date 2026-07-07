const express = require('express');
const request = require('supertest');

jest.mock('../services/gameCacheService', () => ({
  getStatus: jest.fn(),
  installGame: jest.fn(),
  deleteCache: jest.fn(),
}));

const gameCacheService = require('../services/gameCacheService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/game-cache', require('../routes/gameCache'));
  return app;
}

describe('game cache routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET status returns cache service status', async () => {
    gameCacheService.getStatus.mockResolvedValue({
      id: 'demo-game',
      cacheable: true,
      installed: true,
      version: '1.0.0',
      localGamePath: '/games/cache/demo-game/1.0.0/index.html',
      needsUpdate: false,
      error: null,
    });

    const res = await request(createApp()).get('/api/game-cache/status/demo-game');

    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(true);
    expect(gameCacheService.getStatus).toHaveBeenCalledWith('demo-game');
  });

  it('POST install returns install result', async () => {
    gameCacheService.installGame.mockResolvedValue({
      id: 'demo-game',
      cacheable: true,
      installed: true,
      version: '1.0.0',
      localGamePath: '/games/cache/demo-game/1.0.0/index.html',
      needsUpdate: false,
      error: null,
    });

    const res = await request(createApp()).post('/api/game-cache/install/demo-game').send({});

    expect(res.status).toBe(200);
    expect(res.body.localGamePath).toBe('/games/cache/demo-game/1.0.0/index.html');
    expect(gameCacheService.installGame).toHaveBeenCalledWith('demo-game');
  });

  it('maps service errors to HTTP status and code', async () => {
    const error = new Error('该游戏未提供完整缓存包');
    error.code = 'GAME_CACHE_NOT_CACHEABLE';
    error.status = 400;
    gameCacheService.installGame.mockRejectedValue(error);

    const res = await request(createApp()).post('/api/game-cache/install/not-cacheable').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'GAME_CACHE_NOT_CACHEABLE',
      message: '该游戏未提供完整缓存包',
    });
  });

  it('DELETE removes cache', async () => {
    gameCacheService.deleteCache.mockReturnValue({ ok: true });

    const res = await request(createApp()).delete('/api/game-cache/demo-game/1.0.0');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(gameCacheService.deleteCache).toHaveBeenCalledWith('demo-game', '1.0.0');
  });

  it('DELETE returns 404 when cache is missing', async () => {
    gameCacheService.deleteCache.mockReturnValue({ ok: false, notFound: true });

    const res = await request(createApp()).delete('/api/game-cache/demo-game/1.0.0');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('GAME_CACHE_NOT_FOUND');
  });
});
