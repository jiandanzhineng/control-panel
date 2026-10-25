const express = require('express');
const request = require('supertest');

jest.mock('../services/deviceService', () => ({
  batchExecuteOperation: jest.fn(),
  listDevicesForApi: jest.fn(),
  getDeviceById: jest.fn(),
}));

jest.mock('../services/firmwareOtaService', () => ({
  getLatestFirmwareForDevice: jest.fn(),
  getLatestFirmwareForDevices: jest.fn(),
  updateDeviceToLatest: jest.fn(),
  updateDevicesToLatest: jest.fn(),
  blinkLatestDevices: jest.fn(),
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

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/devices', require('../routes/devices'));
  return app;
}

describe('device batch operation route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('posts batch operations and returns service result', async () => {
    const payload = { type: 'ZIDONGSUO', operationKey: 'unlock', total: 2, ok: 2, failed: 0, skipped: 0, results: [] };
    deviceService.batchExecuteOperation.mockReturnValue(payload);
    const res = await request(createApp())
      .post('/api/devices/batch/operations')
      .send({ type: 'ZIDONGSUO', operationKey: 'unlock' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(deviceService.batchExecuteOperation).toHaveBeenCalledWith({
      type: 'ZIDONGSUO',
      operationKey: 'unlock',
      deviceIds: undefined,
      params: {},
    });
  });

  it('maps validation errors to 400', async () => {
    const error = new Error('设备类型 ZIDONGSUO 不支持操作: start');
    error.code = 'DEVICE_OPERATION_NOT_SUPPORTED';
    error.status = 400;
    deviceService.batchExecuteOperation.mockImplementation(() => { throw error; });
    const res = await request(createApp())
      .post('/api/devices/batch/operations')
      .send({ type: 'ZIDONGSUO', operationKey: 'start' });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'DEVICE_OPERATION_NOT_SUPPORTED',
      message: '设备类型 ZIDONGSUO 不支持操作: start',
    });
  });
});
