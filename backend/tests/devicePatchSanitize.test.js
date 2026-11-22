const express = require('express');
const request = require('supertest');

jest.mock('../services/deviceService', () => ({
  updateDeviceMeta: jest.fn(),
  notifyDeviceUpdate: jest.fn(),
  toApiDevice: jest.fn(),
  getDeviceById: jest.fn(),
}));

jest.mock('../services/nicknameService', () => ({
  setNickname: jest.fn(),
}));

jest.mock('../services/firmwareOtaService', () => ({}));

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const deviceService = require('../services/deviceService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/devices', require('../routes/devices'));
  return app;
}

describe('device metadata PATCH', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    deviceService.updateDeviceMeta.mockReturnValue({ id: 'dev01', name: 'new' });
    deviceService.toApiDevice.mockImplementation((device) => device);
  });

  it('only forwards name/nickname and drops output fields', async () => {
    const res = await request(createApp())
      .patch('/api/devices/dev01')
      .send({ name: 'new', nickname: 'n', power: 255, voltage: 100, shock: 1 });

    expect(res.status).toBe(200);
    expect(deviceService.updateDeviceMeta).toHaveBeenCalledWith('dev01', { name: 'new', nickname: 'n' });
    expect(deviceService.notifyDeviceUpdate).toHaveBeenCalledWith('dev01', { name: 'new', nickname: 'n' });
    expect(deviceService.notifyDeviceUpdate.mock.calls[0][1]).not.toHaveProperty('power');
  });

  it('an empty patch never forwards arbitrary properties', async () => {
    await request(createApp())
      .patch('/api/devices/dev01')
      .send({ power: 255 });

    expect(deviceService.updateDeviceMeta).toHaveBeenCalledWith('dev01', {});
    expect(deviceService.notifyDeviceUpdate).toHaveBeenCalledWith('dev01', {});
  });
});
