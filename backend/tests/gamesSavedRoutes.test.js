const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

jest.mock('../services/bridgeService', () => ({
  exitCurrent: jest.fn(() => ({ ok: true })),
}));

function makeApp() {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/games', require('../routes/games'));
  return app;
}

describe('saved played games API', () => {
  let dataDir;
  let previousDataDir;
  let app;

  beforeEach(() => {
    previousDataDir = process.env.BACKEND_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-games-'));
    process.env.BACKEND_DATA_DIR = dataDir;
    jest.resetModules();
    app = makeApp();
  });

  afterEach(() => {
    if (previousDataDir == null) delete process.env.BACKEND_DATA_DIR;
    else process.env.BACKEND_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists a played external game so it can be opened from the game list later', async () => {
    const saveRes = await request(app)
      .post('/api/games/played')
      .send({
        id: 'external-training',
        title: 'External Training',
        description: 'Hosted outside the app',
        version: '2.1.0',
        devices: [{ id: 'pressure', required: true, capabilities: ['sphincterPressure'] }],
        params: [{ key: 'duration', type: 'number', default: 60 }],
        gamePath: '/games/proxy/https/example.test/games/external-training/index.html',
        externalUrl: 'https://example.test/games/external-training/index.html',
        origin: 'external',
        deviceMap: { pressure: ['device-1'] },
        parameters: { duration: 90 },
      });

    expect(saveRes.status).toBe(200);
    expect(saveRes.body).toMatchObject({
      id: 'external-training',
      title: 'External Training',
      source: 'saved',
      origin: 'external',
      gamePath: '/games/proxy/https/example.test/games/external-training/index.html',
      externalUrl: 'https://example.test/games/external-training/index.html',
      lastDeviceMap: { pressure: ['device-1'] },
      lastParams: { duration: 90 },
    });
    expect(typeof saveRes.body.lastPlayed).toBe('number');

    const listRes = await request(app).get('/api/games');
    expect(listRes.status).toBe(200);
    expect(listRes.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'external-training',
        title: 'External Training',
        source: 'saved',
        lastPlayed: saveRes.body.lastPlayed,
      }),
    ]));

    const detailRes = await request(app).get('/api/games/external-training');
    expect(detailRes.status).toBe(200);
    expect(detailRes.body).toMatchObject({
      id: 'external-training',
      title: 'External Training',
      params: [{ key: 'duration', type: 'number', default: 60 }],
      lastParams: { duration: 90 },
    });
  });

  it('lists built-in games from backend/games', async () => {
    const listRes = await request(app).get('/api/games');

    expect(listRes.status).toBe(200);
    expect(listRes.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'pressure-edging-v2',
        source: 'builtin',
        type: 'html',
        gamePath: '/games/pressure-edging-v2/index.html',
        folder: 'pressure-edging-v2',
      }),
    ]));
  });

  it('removes saved played games from the list', async () => {
    await request(app)
      .post('/api/games/played')
      .send({
        id: 'remove-me',
        title: 'Remove Me',
        gamePath: '/games/proxy/https/example.test/remove-me/index.html',
        externalUrl: 'https://example.test/remove-me/index.html',
      });

    const deleteRes = await request(app).delete('/api/games/remove-me');
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ ok: true });

    const listRes = await request(app).get('/api/games');
    expect(listRes.status).toBe(200);
    expect(listRes.body).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'remove-me' }),
    ]));
  });

  it('persists cached game paths and package metadata', async () => {
    const saveRes = await request(app)
      .post('/api/games/played')
      .send({
        id: 'cached-game',
        title: 'Cached Game',
        gamePath: '/games/cache/cached-game/1.0.0/index.html',
        externalUrl: 'https://game.undersilicon.cn/games/cached-game/index.html',
        cached: true,
        localGamePath: '/games/cache/cached-game/1.0.0/index.html',
        packageSha256: 'a'.repeat(64),
      });

    expect(saveRes.status).toBe(200);
    expect(saveRes.body).toMatchObject({
      id: 'cached-game',
      cached: true,
      gamePath: '/games/cache/cached-game/1.0.0/index.html',
      localGamePath: '/games/cache/cached-game/1.0.0/index.html',
      packageSha256: 'a'.repeat(64),
    });

    const detailRes = await request(app).get('/api/games/cached-game');
    expect(detailRes.status).toBe(200);
    expect(detailRes.body).toMatchObject({
      id: 'cached-game',
      cached: true,
      localGamePath: '/games/cache/cached-game/1.0.0/index.html',
      packageSha256: 'a'.repeat(64),
    });
  });
});
