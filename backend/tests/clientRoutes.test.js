const express = require('express');
const request = require('supertest');

jest.mock('../services/gameLaunchService', () => ({
  startGame: jest.fn(),
  stopCurrentPlay: jest.fn(),
}));

const clientControl = require('../services/clientControlService');
const gameLaunchService = require('../services/gameLaunchService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/client', require('../routes/client'));
  return app;
}

const windowState = { visible: true, focused: true, minimized: false, maximized: false };

describe('client routes', () => {
  afterEach(() => {
    clientControl._resetForTests();
    jest.clearAllMocks();
  });

  it('reports unavailable without an Electron host', async () => {
    const app = createApp();
    const state = await request(app).get('/api/client/state');
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ available: false, window: null, route: null });

    const routes = await request(app).get('/api/client/routes');
    expect(routes.status).toBe(200);
    expect(routes.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/home', name: 'home' }),
      expect.objectContaining({ path: '/devices', name: 'devices' }),
    ]));
    expect(routes.body.some((route) => route.path === '/plays/game/current')).toBe(false);

    for (const call of [
      request(app).post('/api/client/window').send({ action: 'show' }),
      request(app).post('/api/client/navigate').send({ path: '/home' }),
      request(app).post('/api/client/screenshot').send({}),
      request(app).post('/api/client/games/demo/launch').send({}),
    ]) {
      const res = await call;
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('CLIENT_UNAVAILABLE');
    }
  });

  it('drives window/navigate/screenshot through a mock host', async () => {
    const host = jest.fn(async (command) => {
      if (command.type === 'state') {
        return { window: windowState, route: '/home', version: '1.2.3', locale: 'zh' };
      }
      if (command.type === 'window') {
        return {
          window: { ...windowState, visible: command.action !== 'hide' },
          route: '/home',
          version: '1.2.3',
        };
      }
      if (command.type === 'navigate') {
        return { window: windowState, route: command.path, version: '1.2.3' };
      }
      if (command.type === 'screenshot') {
        return { mime: 'image/png', data: 'AAAA', width: 100, height: 50 };
      }
      throw new Error(`unexpected command ${command.type}`);
    });
    clientControl.registerHost(host);
    const app = createApp();

    const state = await request(app).get('/api/client/state');
    expect(state.body).toMatchObject({ available: true, version: '1.2.3', route: '/home' });

    const hidden = await request(app).post('/api/client/window').send({ action: 'hide' });
    expect(hidden.status).toBe(200);
    expect(hidden.body.window.visible).toBe(false);
    expect(host).toHaveBeenCalledWith({ type: 'window', action: 'hide' });

    const nav = await request(app).post('/api/client/navigate').send({ path: '/devices?tab=brands' });
    expect(nav.status).toBe(200);
    expect(host).toHaveBeenCalledWith({ type: 'navigate', path: '/devices?tab=brands', show: true });

    const denied = await request(app).post('/api/client/navigate').send({ path: '/plays/game/current' });
    expect(denied.status).toBe(400);
    expect(denied.body.error.code).toBe('ROUTE_NOT_ALLOWED');

    const badFormat = await request(app).post('/api/client/screenshot').send({ format: 'gif' });
    expect(badFormat.status).toBe(400);

    const shot = await request(app).post('/api/client/screenshot').send({ format: 'jpeg', maxWidth: 640 });
    expect(shot.status).toBe(200);
    expect(shot.body).toMatchObject({ mime: 'image/png', data: 'AAAA', width: 100, height: 50 });
  });

  it('launches a game through the shared launch service then navigates', async () => {
    clientControl.registerHost(jest.fn(async (command) => (
      command.type === 'navigate'
        ? { window: windowState, route: command.path, version: '1.2.3' }
        : { window: windowState, route: '/plays', version: '1.2.3' }
    )));
    gameLaunchService.stopCurrentPlay.mockResolvedValue({ ok: true });
    gameLaunchService.startGame.mockResolvedValue({
      ok: true,
      gamePath: '/games/demo/index.html',
      deviceMap: { sensor: ['d1'] },
      params: { duration: 5 },
      runtime: { mode: 'iframe', gameToken: 'token-1' },
    });
    const app = createApp();

    const res = await request(app).post('/api/client/games/demo/launch').send({
      deviceMap: { sensor: 'd1' },
      parameters: { duration: 5 },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, gameId: 'demo', mode: 'iframe' });
    expect(res.body.path).toContain('/plays/game/current?');
    expect(res.body.path).toContain('gameToken=token-1');
    expect(gameLaunchService.stopCurrentPlay).toHaveBeenCalledWith({ gameId: 'demo', reason: 'agent-launch' });
    expect(gameLaunchService.startGame).toHaveBeenCalledWith(expect.objectContaining({
      gameId: 'demo',
      deviceMapping: { sensor: 'd1' },
      parameters: { duration: 5 },
      source: 'local',
    }));
    expect(gameLaunchService.stopCurrentPlay.mock.invocationCallOrder[0])
      .toBeLessThan(gameLaunchService.startGame.mock.invocationCallOrder[0]);
  });

  it('publishes client.route when the host reports navigation', async () => {
    const eventBus = require('../services/eventBus');
    const received = [];
    const unsubscribe = eventBus.subscribe((event) => received.push(event));
    clientControl.reportRoute('/settings');
    unsubscribe();
    expect(received).toEqual([
      expect.objectContaining({ type: 'client.route', path: '/settings' }),
    ]);
  });
});
