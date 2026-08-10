const express = require('express');
const request = require('supertest');

jest.mock('../services/testService', () => ({
  startPlatform: jest.fn(),
  stopPlatform: jest.fn(),
  startTest: jest.fn(),
  handleSSE: jest.fn((req, res) => res.end()),
}));

jest.mock('../services/autoProvisionService', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  getState: jest.fn(),
  setSettings: jest.fn(),
  retry: jest.fn(),
}));

const testService = require('../services/testService');
const provision = require('../services/autoProvisionService');

const STATE = {
  enabled: true,
  settings: { autoFlash: true, deviceType: 'CUNZHI01' },
  ports: [{ path: 'COM9', stage: 'connected' }],
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/test', require('../routes/test'));
  return app;
}

describe('test platform routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('start/stop 同时驱动测试平台与串口自动供给', async () => {
    provision.start.mockResolvedValue(STATE);
    provision.stop.mockResolvedValue({ ...STATE, enabled: false });

    const started = await request(createApp()).post('/api/test/start');
    expect(started.status).toBe(200);
    expect(started.body.provision).toEqual(STATE);
    expect(testService.startPlatform).toHaveBeenCalled();

    const stopped = await request(createApp()).post('/api/test/stop');
    expect(stopped.body.provision.enabled).toBe(false);
    expect(testService.stopPlatform).toHaveBeenCalled();
  });

  it('返回供给状态并更新设置', async () => {
    provision.getState.mockReturnValue(STATE);
    expect((await request(createApp()).get('/api/test/provision')).body).toEqual(STATE);

    const updated = await request(createApp())
      .put('/api/test/provision/settings')
      .send({ autoFlash: true, deviceType: 'CUNZHI01' });
    expect(updated.status).toBe(200);
    expect(provision.setSettings).toHaveBeenCalledWith({ autoFlash: true, deviceType: 'CUNZHI01' });
  });

  it('设置非法时返回 400 与错误码', async () => {
    const error = new Error('autoFlash must be a boolean');
    error.code = 'AUTO_FLASH_INVALID';
    error.status = 400;
    provision.setSettings.mockImplementation(() => { throw error; });

    const res = await request(createApp()).put('/api/test/provision/settings').send({ autoFlash: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTO_FLASH_INVALID');
  });

  it('重试指定端口，未跟踪端口返回 404', async () => {
    provision.retry.mockResolvedValue(STATE);
    const ok = await request(createApp()).post('/api/test/provision/ports/COM9/retry');
    expect(ok.status).toBe(200);
    expect(provision.retry).toHaveBeenCalledWith('COM9');

    const notTracked = new Error('端口 COM3 不在测试台管理范围内');
    notTracked.code = 'PORT_NOT_TRACKED';
    notTracked.status = 404;
    provision.retry.mockRejectedValue(notTracked);
    const missing = await request(createApp()).post('/api/test/provision/ports/COM3/retry');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('PORT_NOT_TRACKED');
  });
});
