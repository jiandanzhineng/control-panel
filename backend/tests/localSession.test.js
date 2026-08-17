const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

jest.mock('../services/accountService', () => {
  class UpstreamError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    UpstreamError,
    getMe: jest.fn(),
    getBaseUrl: jest.fn(() => 'https://api.undersilicon.cn'),
    register: jest.fn(), login: jest.fn(), logout: jest.fn(),
    recovery: jest.fn(), deleteMe: jest.fn(),
  };
});

jest.mock('../utils/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(),
}));

const accountService = require('../services/accountService');
const localSession = require('../services/localSessionService');
const USER = { id: '01HX', email: 'a@b.com', provider: 'email' };

describe('local session for digital-human', () => {
  let tempDir;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-session-'));
    process.env.LOCAL_SESSION_PATH = path.join(tempDir, 'local-session.json');
    localSession._resetForTests();
  });

  afterEach(() => {
    delete process.env.LOCAL_SESSION_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function app() {
    const server = express();
    server.use(express.json());
    server.use('/api/auth', require('../routes/auth'));
    return server;
  }

  it('isLoopback accepts ipv4/ipv6 localhost only', () => {
    expect(localSession.isLoopback({ socket: { remoteAddress: '127.0.0.1' } })).toBe(true);
    expect(localSession.isLoopback({ socket: { remoteAddress: '::1' } })).toBe(true);
    expect(localSession.isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } })).toBe(true);
    expect(localSession.isLoopback({ socket: { remoteAddress: '192.168.1.8' } })).toBe(false);
  });

  it('deposits a verified token and serves it to loopback', async () => {
    accountService.getMe.mockResolvedValue({ status: 200, data: { user: USER } });
    const server = app();
    const put = await request(server)
      .post('/api/auth/local-session')
      .set('Authorization', 'Bearer jwt-token')
      .send();
    expect(put.status).toBe(200);
    expect(put.body.user.email).toBe('a@b.com');

    const got = await request(server).get('/api/auth/relay-credential');
    expect(got.status).toBe(200);
    expect(got.body.token).toBe('jwt-token');
    expect(got.body.relay_url).toMatch(/^https:\/\//);
    expect(got.body.user.email).toBe('a@b.com');
  });

  it('returns 401 when nothing is deposited', async () => {
    const res = await request(app()).get('/api/auth/relay-credential');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('NOT_SIGNED_IN');
  });

  it('clears on delete and then refuses credential', async () => {
    accountService.getMe.mockResolvedValue({ status: 200, data: { user: USER } });
    const server = app();
    await request(server).post('/api/auth/local-session')
      .set('Authorization', 'Bearer jwt-token').send();
    const del = await request(server).delete('/api/auth/local-session');
    expect(del.status).toBe(204);
    const got = await request(server).get('/api/auth/relay-credential');
    expect(got.status).toBe(401);
  });

  it('clears deposit when /me says token is dead', async () => {
    accountService.getMe
      .mockResolvedValueOnce({ status: 200, data: { user: USER } })
      .mockRejectedValueOnce(new accountService.UpstreamError(401, 'AUTH_FAILED', '登录已失效'));
    const server = app();
    await request(server).post('/api/auth/local-session')
      .set('Authorization', 'Bearer jwt-token').send();
    const got = await request(server).get('/api/auth/relay-credential');
    expect(got.status).toBe(401);
    expect(localSession.get()).toBe(null);
  });
});
