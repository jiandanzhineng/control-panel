const express = require('express');
const request = require('supertest');

jest.mock('../services/deviceService', () => ({
  getDeviceById: jest.fn(),
  listDevicesForApi: jest.fn(),
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

  it('GET batch firmware checks online devices and includes OTA status', async () => {
    const devices = [
      { id: 'dev01', type: 'CUNZHI01', connected: true, data: { ver: 'v1.1.28' } },
      { id: 'dev02', type: 'CUNZHI01', connected: false, data: { ver: 'v1.1.28' } },
    ];
    const latest = [{
      supported: true,
      currentVersion: 'v1.1.28',
      latestVersion: 'v1.1.33',
      updateAvailable: true,
      firmware: { filename: 'under_silicon_CUNZHI01_v1.1.33.bin' },
    }];
    const status = { deviceId: 'dev01', status: 'idle', progress: null };

    deviceService.listDevicesForApi.mockReturnValue(devices);
    firmwareOtaService.getLatestFirmwareForDevices.mockResolvedValue(latest);
    firmwareOtaService.getOtaStatus.mockReturnValue(status);

    const res = await request(createApp()).get('/api/devices/firmware/batch?scope=online');

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('online');
    expect(res.body.total).toBe(1);
    expect(res.body.devices[0]).toEqual({
      device: devices[0],
      firmware: latest[0],
      status,
    });
    expect(firmwareOtaService.getLatestFirmwareForDevices).toHaveBeenCalledWith([devices[0]]);
  });

  it('POST batch update requires device ids', async () => {
    const res = await request(createApp())
      .post('/api/devices/firmware/batch/update-latest')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DEVICE_IDS_REQUIRED');
  });

  it('POST batch update returns per-device results and missing devices', async () => {
    const device = { id: 'dev01', type: 'CUNZHI01', connected: true, data: { ver: 'v1.1.28' } };
    const result = {
      ok: true,
      requestedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      results: [{ deviceId: 'dev01', ok: true, skipped: false, failed: false }],
    };

    deviceService.getDeviceById.mockImplementation((id) => (id === 'dev01' ? device : null));
    firmwareOtaService.updateDevicesToLatest.mockResolvedValue(result);

    const res = await request(createApp())
      .post('/api/devices/firmware/batch/update-latest')
      .send({ deviceIds: ['dev01', 'missing', 'dev01'] });

    expect(res.status).toBe(200);
    expect(res.body.requestedCount).toBe(1);
    expect(res.body.failedCount).toBe(1);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.missing[0].deviceId).toBe('missing');
    expect(firmwareOtaService.updateDevicesToLatest).toHaveBeenCalledWith([device], { force: false });
  });

  it('POST batch blink latest checks online devices and publishes via device action helper', async () => {
    const devices = [
      { id: 'latest', type: 'CUNZHI01', connected: true, data: { ver: 'v1.1.33' } },
      { id: 'offline', type: 'CUNZHI01', connected: false, data: { ver: 'v1.1.33' } },
    ];
    const result = {
      ok: true,
      requestedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      results: [{ deviceId: 'latest', ok: true, skipped: false, failed: false }],
    };

    deviceService.listDevicesForApi.mockReturnValue(devices);
    deviceService.publishDeviceAction = jest.fn();
    firmwareOtaService.blinkLatestDevices.mockResolvedValue(result);

    const res = await request(createApp())
      .post('/api/devices/firmware/batch/blink-latest')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(firmwareOtaService.blinkLatestDevices).toHaveBeenCalledWith(
      [devices[0]],
      expect.any(Function)
    );

    const publisher = firmwareOtaService.blinkLatestDevices.mock.calls[0][1];
    publisher('latest', 'blink');
    expect(deviceService.publishDeviceAction).toHaveBeenCalledWith('latest', 'blink');
  });
});
