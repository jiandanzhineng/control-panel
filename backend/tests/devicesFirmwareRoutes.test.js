const express = require('express');
const request = require('supertest');

jest.mock('../services/deviceService', () => ({
  getDeviceById: jest.fn(),
}));

jest.mock('../services/firmwareOtaService', () => ({
  getLatestFirmwareForDevice: jest.fn(),
  updateDeviceToLatest: jest.fn(),
  getOtaStatus: jest.fn(),
  onOtaStatus: jest.fn(),
}));

jest.mock('../services/nicknameService', () => ({
  setNickname: jest.fn(),
}));

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const deviceService = require('../services/deviceService');
const firmwareOtaService = require('../services/firmwareOtaService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/devices', require('../routes/devices'));
  return app;
}

describe('device firmware routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET latest firmware returns service result', async () => {
    const device = { id: 'dev01', type: 'CUNZHI01', connected: true, data: { ver: 'v1.1.28' } };
    const latest = {
      supported: true,
      currentVersion: 'v1.1.28',
      latestVersion: 'v1.1.33',
      updateAvailable: true,
      firmware: { filename: 'under_silicon_CUNZHI01_v1.1.33.bin' },
    };

    deviceService.getDeviceById.mockReturnValue(device);
    firmwareOtaService.getLatestFirmwareForDevice.mockResolvedValue(latest);

    const res = await request(createApp()).get('/api/devices/dev01/firmware/latest');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(latest);
    expect(firmwareOtaService.getLatestFirmwareForDevice).toHaveBeenCalledWith(device);
  });

  it('POST update-latest maps service errors to HTTP status and code', async () => {
    const error = new Error('当前设备已是最新固件版本');
    error.code = 'ALREADY_LATEST';
    error.status = 409;

    deviceService.getDeviceById.mockReturnValue({ id: 'dev01', type: 'CUNZHI01', connected: true, data: {} });
    firmwareOtaService.updateDeviceToLatest.mockRejectedValue(error);

    const res = await request(createApp())
      .post('/api/devices/dev01/firmware/update-latest')
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'ALREADY_LATEST',
      message: '当前设备已是最新固件版本',
    });
  });

  it('returns 404 when device does not exist', async () => {
    deviceService.getDeviceById.mockReturnValue(null);

    const res = await request(createApp()).get('/api/devices/missing/firmware/status');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DEVICE_NOT_FOUND');
  });
});
