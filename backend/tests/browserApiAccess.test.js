const express = require('express');
const request = require('supertest');

jest.mock('../services/mqttClientService', () => ({
  publish: jest.fn(),
  status: jest.fn(() => ({ running: true })),
}));

jest.mock('../services/testService', () => ({
  startPlatform: jest.fn(),
  stopPlatform: jest.fn(),
  startTest: jest.fn(),
  handleSSE: jest.fn(),
}));

jest.mock('../services/deviceService', () => ({
  executeDeviceOperationAndWait: jest.fn(async () => ({ success: true })),
  invokeDeviceCapabilityAndWait: jest.fn(async () => ({ ok: true })),
}));

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const mqttClient = require('../services/mqttClientService');
const testService = require('../services/testService');
const deviceService = require('../services/deviceService');
const externalGameAccessService = require('../services/externalGameAccessService');
const browserDeviceGrantService = require('../services/browserDeviceGrantService');
const { browserApiCors } = require('../middleware/browserApiAccess');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', browserApiCors);
  app.use('/api/devices', require('../routes/devices'));
  app.use('/api/mqtt-client', require('../routes/mqttClient'));
  app.use('/api/test', require('../routes/test'));
  return app;
}

describe('browser api access guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks untrusted browser origins from device mutation routes', async () => {
    const res = await request(createApp())
      .post('/api/devices/ctrl_td01/operations/start')
      .set('Origin', 'http://127.0.0.1:3011')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({
      code: 'BROWSER_API_FORBIDDEN',
      message: '当前网页不能直接访问本机控制接口',
    });
    expect(deviceService.executeDeviceOperationAndWait).not.toHaveBeenCalled();
  });

  it('blocks untrusted browser origins from capability mutation routes', async () => {
    const res = await request(createApp())
      .post('/api/devices/ctrl_td01/capabilities/strength/actions/set')
      .set('Origin', 'http://127.0.0.1:3011')
      .send({ input: { value: 123 } });

    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({
      code: 'BROWSER_API_FORBIDDEN',
      message: '当前网页不能直接访问本机控制接口',
    });
    expect(deviceService.invokeDeviceCapabilityAndWait).not.toHaveBeenCalled();
  });

  it('blocks untrusted browser origins from mqtt publish routes', async () => {
    const res = await request(createApp())
      .post('/api/mqtt-client/publish')
      .set('Origin', 'http://127.0.0.1:3011')
      .send({ topic: '/drecv/ctrl_td01', message: { method: 'update', power: 123 } });

    expect(res.status).toBe(403);
    expect(mqttClient.publish).not.toHaveBeenCalled();
  });

  it('blocks untrusted browser origins from test control routes', async () => {
    const res = await request(createApp())
      .post('/api/test/start')
      .set('Origin', 'http://127.0.0.1:3011')
      .send({});

    expect(res.status).toBe(403);
    expect(testService.startPlatform).not.toHaveBeenCalled();
  });

  it('allows trusted frontend origins', async () => {
    const res = await request(createApp())
      .post('/api/devices/ctrl_td01/operations/start')
      .set('Origin', 'http://localhost:5173')
      .send({});

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(deviceService.executeDeviceOperationAndWait).toHaveBeenCalledWith('ctrl_td01', 'start', {});
  });

  it('allows native requests without Origin', async () => {
    const res = await request(createApp())
      .post('/api/mqtt-client/publish')
      .send({ topic: '/drecv/ctrl_td01', message: { method: 'update', power: 123 } });

    expect(res.status).toBe(200);
    expect(mqttClient.publish).toHaveBeenCalledWith('/drecv/ctrl_td01', { method: 'update', power: 123 });
  });

  it('answers trusted browser preflight requests', async () => {
    const res = await request(createApp())
      .options('/api/devices/ctrl_td01/operations/start')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('rejects untrusted browser preflight requests', async () => {
    const res = await request(createApp())
      .options('/api/devices/ctrl_td01/operations/start')
      .set('Origin', 'http://127.0.0.1:3011')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(res.status).toBe(403);
  });

  describe('with external game access enabled', () => {
    let getStatusSpy;

    beforeEach(() => {
      getStatusSpy = jest
        .spyOn(externalGameAccessService, 'isTrustedDevOrigin')
        .mockImplementation((origin) => origin === 'http://localhost:8080');
    });

    afterEach(() => {
      getStatusSpy.mockRestore();
    });

    it('allows a trusted dev origin (arbitrary local port)', async () => {
      const res = await request(createApp())
        .post('/api/devices/ctrl_td01/operations/start')
        .set('Origin', 'http://localhost:8080')
        .send({});

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8080');
      expect(deviceService.executeDeviceOperationAndWait).toHaveBeenCalled();
    });

    it('still blocks origins that are not trusted dev origins', async () => {
      const res = await request(createApp())
        .post('/api/devices/ctrl_td01/operations/start')
        .set('Origin', 'http://localhost:9090')
        .send({});

      expect(res.status).toBe(403);
    });
  });

  describe('with a live DeviceAPI grant', () => {
    let isGrantedSpy;

    beforeEach(() => {
      isGrantedSpy = jest
        .spyOn(browserDeviceGrantService, 'isGranted')
        .mockImplementation((origin) => origin === 'https://game.undersilicon.cn');
    });

    afterEach(() => {
      isGrantedSpy.mockRestore();
    });

    it('allows a granted origin to reach mutation routes', async () => {
      const res = await request(createApp())
        .post('/api/devices/ctrl_td01/operations/start')
        .set('Origin', 'https://game.undersilicon.cn')
        .send({});

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://game.undersilicon.cn');
      expect(deviceService.executeDeviceOperationAndWait).toHaveBeenCalled();
    });

    it('still blocks origins without a grant', async () => {
      const res = await request(createApp())
        .post('/api/devices/ctrl_td01/operations/start')
        .set('Origin', 'https://evil.example.com')
        .send({});

      expect(res.status).toBe(403);
    });
  });
});
