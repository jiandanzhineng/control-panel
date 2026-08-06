const express = require('express');
const request = require('supertest');

const device = {
  id: 'ble:esp32-c3',
  type: 'TD01',
  connected: true,
  connectionType: 'ble',
  data: { power: 0 },
};

jest.mock('../services/deviceService', () => ({
  getDeviceById: jest.fn((id) => id === device.id ? device : null),
  publishDeviceMessage: jest.fn(() => ({ ok: true, connectionType: 'ble' })),
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

describe('device message route', () => {
  it('sends a device message through the active transport', async () => {
    const message = { method: 'update', power: 128 };
    const res = await request(createApp())
      .post('/api/devices/ble%3Aesp32-c3/message')
      .send({ message });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, connectionType: 'ble' });
    expect(deviceService.publishDeviceMessage).toHaveBeenCalledWith(device.id, message);
  });
});
