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
  executeDeviceOperation: jest.fn(() => ({ success: true })),
}));

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const mqttClient = require('../services/mqttClientService');
const testService = require('../services/testService');
const deviceService = require('../services/deviceService');
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
    expect(deviceService.executeDeviceOperation).not.toHaveBeenCalled();
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
    expect(deviceService.executeDeviceOperation).toHaveBeenCalledWith('ctrl_td01', 'start', {});
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
});
