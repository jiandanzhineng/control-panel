const express = require('express');
const request = require('supertest');
const router = require('../routes/gameProxy');

function createApp() {
  const app = express();
  app.use('/games/proxy', router);
  return app;
}

describe('game proxy route', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('rejects hosts outside the allowlist without fetching upstream', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await request(createApp())
      .get('/games/proxy/https/evil.example.com/index.html')
      .expect(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('proxies allowlisted hosts and strips framing headers for them', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200,
      headers: new Headers({
        'content-type': 'text/html',
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
      }),
      arrayBuffer: async () => Buffer.from('<html></html>'),
    });

    const response = await request(createApp())
      .get('/games/proxy/https/game.undersilicon.cn/games/surge-edging/index.html')
      .expect(200);
    expect(response.headers['x-frame-options']).toBeUndefined();
    expect(response.headers['content-security-policy']).toBeUndefined();
  });

  test('does not strip framing headers for hosts that are not embeddable', async () => {
    // 回环（开发态）在白名单内，属于可嵌入来源。
    const allowlist = require('../services/gameProxyAllowlist');
    jest.spyOn(allowlist, 'isEmbeddableHost').mockReturnValue(false);
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200,
      headers: new Headers({
        'content-type': 'text/html',
        'x-frame-options': 'DENY',
      }),
      arrayBuffer: async () => Buffer.from('<html></html>'),
    });

    const response = await request(createApp())
      .get('/games/proxy/https/game.undersilicon.cn/index.html')
      .expect(200);
    expect(response.headers['x-frame-options']).toBe('DENY');
  });
});
