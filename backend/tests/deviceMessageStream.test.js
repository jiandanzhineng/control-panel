const express = require('express');
const http = require('http');

// 真实 deviceService 的轻量替身：只保留消息流测试需要的最小接口
jest.mock('../services/mqttClientService', () => ({
  publish: jest.fn(),
}));

jest.mock('../utils/fileStorage', () => ({
  getItem: jest.fn(() => null),
  setItem: jest.fn(),
}));

jest.mock('../services/logService', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../services/nicknameService', () => ({
  getNickname: jest.fn(() => null),
}));

jest.mock('../services/firmwareOtaService', () => ({
  recordOtaStatus: jest.fn(),
}));

const deviceService = require('../services/deviceService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/devices', require('../routes/devices'));
  return app;
}

function listenSse(server, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    }, (res) => resolve({ req, res }));
    req.on('error', reject);
    req.end();
  });
}

describe('device message stream route', () => {
  let server;

  beforeEach(() => {
    deviceService.state.devices = [];
    deviceService.clearRuntimeTransports();
    deviceService.stopOfflineCheck();
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  it('returns 404 for unknown device', async () => {
    server = createApp().listen(0);
    const { res } = await listenSse(server, '/api/devices/nope/message-stream');
    expect(res.statusCode).toBe(404);
    res.destroy();
  });

  it('streams raw messages only for the target device', async () => {
    deviceService.connectTransportDevice(
      { id: 'lock-1', name: '自动锁', type: 'ZIDONGSUO', connectionType: 'mqtt' },
      { kind: 'mqtt', send: () => {} },
    );

    server = createApp().listen(0);
    const { req, res } = await listenSse(server, '/api/devices/lock-1/message-stream');
    expect(res.statusCode).toBe(200);

    let buffer = '';
    const events = [];
    res.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const eventMatch = part.match(/^event: (.+)$/m);
        const dataMatch = part.match(/^data: (.+)$/m);
        if (eventMatch && dataMatch) {
          events.push({ event: eventMatch[1], data: JSON.parse(dataMatch[1]) });
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // 其它设备的消息不应进入该流
    deviceService.emitRawMessage('other-device', { method: 'action', action: 'key_clicked' });
    deviceService.emitRawMessage('lock-1', { method: 'action', action: 'key_clicked' });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events.some((e) => e.event === 'ready' && e.data.deviceId === 'lock-1')).toBe(true);
    const messages = events.filter((e) => e.event === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0].data).toEqual({
      deviceId: 'lock-1',
      payload: { method: 'action', action: 'key_clicked' },
    });

    req.destroy();
  });
});
