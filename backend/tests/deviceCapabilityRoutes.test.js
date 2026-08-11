const express = require('express');
const request = require('supertest');

jest.mock('../services/deviceService', () => ({
  invokeDeviceCapabilityAndWait: jest.fn(),
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

describe('device capability routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('invokes a capability action with input body', async () => {
    deviceService.invokeDeviceCapabilityAndWait.mockResolvedValue({ ok: true });

    const res = await request(createApp())
      .post('/api/devices/dev01/capabilities/strength/actions/set')
      .send({ input: { value: 128 } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ok: true });
    expect(deviceService.invokeDeviceCapabilityAndWait).toHaveBeenCalledWith(
      'dev01',
      'strength',
      'set',
      { value: 128 },
    );
  });

  it('accepts params alias for capability action input', async () => {
    deviceService.invokeDeviceCapabilityAndWait.mockResolvedValue({ ok: true });

    const res = await request(createApp())
      .post('/api/devices/dev01/capabilities/reporting/actions/setReportDelay')
      .send({ params: { ms: 250 } });

    expect(res.status).toBe(200);
    expect(deviceService.invokeDeviceCapabilityAndWait).toHaveBeenCalledWith(
      'dev01',
      'reporting',
      'setReportDelay',
      { ms: 250 },
    );
  });

  it('maps missing device to 404', async () => {
    const error = new Error('设备不存在');
    error.code = 'DEVICE_NOT_FOUND';
    deviceService.invokeDeviceCapabilityAndWait.mockRejectedValue(error);

    const res = await request(createApp())
      .post('/api/devices/missing/capabilities/strength/actions/set')
      .send({ input: { value: 64 } });

    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      code: 'DEVICE_NOT_FOUND',
      message: '设备不存在',
    });
  });

  it('maps unsupported capability action to 400', async () => {
    const error = new Error('设备类型 TD01 不支持能力动作: strength.boost');
    error.code = 'DEVICE_CAPABILITY_ACTION_NOT_SUPPORTED';
    deviceService.invokeDeviceCapabilityAndWait.mockRejectedValue(error);

    const res = await request(createApp())
      .post('/api/devices/dev01/capabilities/strength/actions/boost')
      .send({ input: { value: 255 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'DEVICE_CAPABILITY_ACTION_NOT_SUPPORTED',
      message: '设备类型 TD01 不支持能力动作: strength.boost',
    });
  });
});
