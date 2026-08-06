const express = require('express');
const request = require('supertest');

jest.mock('../services/deviceService', () => ({
  setControlConnection: jest.fn(),
}));
jest.mock('../services/nicknameService', () => ({}));
jest.mock('../services/firmwareOtaService', () => ({}));
jest.mock('../utils/logger', () => ({ info: jest.fn(), error: jest.fn() }));

const deviceService = require('../services/deviceService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/devices', require('../routes/devices'));
  return app;
}

describe('device control connection route', () => {
  beforeEach(() => jest.clearAllMocks());

  it('switches to an online transport', async () => {
    deviceService.setControlConnection.mockReturnValue({
      id: 'aabbccddeeff', controlConnection: 'serial', connections: [{ type: 'serial' }],
    });
    const response = await request(createApp())
      .put('/api/devices/aabbccddeeff/control-connection')
      .send({ type: 'serial' });
    expect(response.status).toBe(200);
    expect(response.body.controlConnection).toBe('serial');
  });

  it('returns 400 for invalid types and 409 for offline connections', async () => {
    expect((await request(createApp())
      .put('/api/devices/aabbccddeeff/control-connection')
      .send({ type: 'usb' })).status).toBe(400);

    deviceService.setControlConnection.mockImplementation(() => {
      throw Object.assign(new Error('not online'), { code: 'CONNECTION_NOT_AVAILABLE' });
    });
    expect((await request(createApp())
      .put('/api/devices/aabbccddeeff/control-connection')
      .send({ type: 'ble' })).status).toBe(409);
  });
});
