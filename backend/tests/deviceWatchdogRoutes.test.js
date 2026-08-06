const express = require('express');
const request = require('supertest');

jest.mock('../services/mqttClientService', () => ({
  publish: jest.fn(),
}));

jest.mock('../utils/fileStorage', () => ({
  getItem: jest.fn(() => null),
  setItem: jest.fn(),
}));

jest.mock('../services/nicknameService', () => ({
  getNickname: jest.fn(() => null),
}));

jest.mock('../services/firmwareOtaService', () => ({}));

const mqttClient = require('../services/mqttClientService');
const deviceService = require('../services/deviceService');
const watchdog = require('../services/deviceWatchdogService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/device-watchdog', require('../routes/deviceWatchdog'));
  return app;
}

describe('device watchdog HTTP interface', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-04T12:00:00.000Z'));
    mqttClient.publish.mockReset();
    await deviceService.clearAllDevices();
    watchdog.resetForTests();
  });

  afterEach(() => {
    watchdog.resetForTests();
    jest.useRealTimers();
  });

  it('creates a default 30 second lease', async () => {
    const response = await request(createApp())
      .post('/api/device-watchdog/heartbeat')
      .send({ clientId: 'xiaonian-client' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      clientId: 'xiaonian-client',
      ttlSeconds: 30,
      expiresAt: '2026-08-04T12:00:30.000Z',
    });
  });

  it.each([
    [{ clientId: 'bad id', ttlSeconds: 30 }, 'INVALID_CLIENT_ID'],
    [{ clientId: 'valid', ttlSeconds: 4 }, 'INVALID_TTL_SECONDS'],
    [{ clientId: 'valid', ttlSeconds: 601 }, 'INVALID_TTL_SECONDS'],
  ])('returns 400 for an invalid heartbeat', async (body, code) => {
    const response = await request(createApp())
      .post('/api/device-watchdog/heartbeat')
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(code);
  });

  it('stops all execution devices immediately', async () => {
    deviceService.connectTransportDevice(
      { id: 'motor-1', name: 'motor', type: 'TD01', connectionType: 'mqtt' },
      {
        kind: 'mqtt',
        send: (message) => mqttClient.publish('/drecv/motor-1', message),
      },
    );

    const response = await request(createApp())
      .post('/api/device-watchdog/stop-all')
      .send({ clientId: 'xiaonian-client', reason: 'client-shutdown' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      trigger: 'client-request',
      clientId: 'xiaonian-client',
      reason: 'client-shutdown',
      stopped: [expect.objectContaining({ deviceId: 'motor-1', commandSent: true })],
    });
  });
});
