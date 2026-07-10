const http = require('http');

jest.mock('../services/logService', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  log: jest.fn(),
  cleanOldLogs: jest.fn(),
}));

jest.mock('../services/deviceService', () => ({
  initDeviceList: jest.fn(),
  cleanup: jest.fn(),
  onDeviceDataChange: jest.fn(),
  onDeviceRawMessage: jest.fn(),
  handleDeviceMessage: jest.fn(),
}));

jest.mock('../services/mqttService', () => ({
  start: jest.fn(async () => ({ running: false })),
  stop: jest.fn(async () => {}),
}));

jest.mock('../services/mdnsService', () => ({
  publish: jest.fn(() => ({ running: false })),
  unpublish: jest.fn(),
}));

jest.mock('../services/mqttClientService', () => ({
  init: jest.fn(),
  onMessage: jest.fn(),
}));

jest.mock('../services/gameCacheService', () => ({
  getCacheRoot: jest.fn(() => __dirname),
}));

jest.mock('../routes/gameProxy', () => {
  const express = require('express');
  return express.Router();
});

[
  '../routes/mqtt',
  '../routes/network',
  '../routes/mdns',
  '../routes/mqttClient',
  '../routes/devices',
  '../routes/deviceTypes',
  '../routes/deviceCapabilities',
  '../routes/games',
  '../routes/gameRegistry',
  '../routes/gameCache',
  '../routes/plugins',
  '../routes/logs',
  '../routes/test',
  '../routes/virtualDevices',
].forEach((routePath) => {
  jest.mock(routePath, () => {
    const express = require('express');
    return express.Router();
  });
});

class MockWebSocketServer {
  constructor(options) {
    this.options = options;
    MockWebSocketServer.instance = this;
  }
  on() {}
}

jest.mock('ws', () => ({
  WebSocketServer: MockWebSocketServer,
}));

describe('legacy bridge access guards', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('blocks direct bridge-api access without the internal proxy header', async () => {
    const request = require('supertest');
    const backend = require('../index');

    const res = await request(backend).get('/bridge-api/device-api-bridge.js');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Bridge script access denied' });
  });

  it('allows bridge-api access when the request comes through the internal proxy', async () => {
    const request = require('supertest');
    const backend = require('../index');

    const res = await request(backend)
      .get('/bridge-api/device-api-bridge.js')
      .set(backend.BRIDGE_INTERNAL_HEADER, '1');

    expect(res.status).toBe(200);
    expect(res.text).toContain('window.DeviceAPI');
  });

  it('rejects browser websocket upgrades without the internal proxy header', () => {
    const bridgeService = require('../services/bridgeService');
    const server = http.createServer();
    bridgeService.init(server);

    const result = MockWebSocketServer.instance?.options?.verifyClient({
      origin: 'http://127.0.0.1:4177',
      req: { headers: { host: '127.0.0.1:5278' } },
    });

    expect(result).toBe(false);
  });

  it('allows browser websocket upgrades with the internal proxy header', () => {
    const bridgeService = require('../services/bridgeService');
    const server = http.createServer();
    bridgeService.init(server);

    const result = MockWebSocketServer.instance.options.verifyClient({
      origin: 'http://127.0.0.1:4177',
      req: { headers: { host: '127.0.0.1:5278', 'x-control-panel-bridge-internal': '1' } },
    });

    expect(result).toBe(true);
  });

  it('still allows native/plugin websocket upgrades without Origin', () => {
    const bridgeService = require('../services/bridgeService');
    const server = http.createServer();
    bridgeService.init(server);

    const result = MockWebSocketServer.instance.options.verifyClient({
      origin: '',
      req: { headers: { host: '127.0.0.1:5278' } },
    });

    expect(result).toBe(true);
  });
});
