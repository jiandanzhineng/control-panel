const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

jest.mock('../services/logService', () => ({
  info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

jest.mock('../services/virtualDeviceService', () => ({
  isVirtualDevice: jest.fn(() => false),
  interceptCommand: jest.fn(),
}));

jest.mock('../devices/registry', () => ({
  getDeviceCapabilities: jest.fn(() => []),
}));

jest.mock('../devices/capabilities', () => ({
  getCapabilityDefinition: jest.fn(() => null),
}));

jest.mock('../services/deviceService', () => ({
  onDeviceDataChange: jest.fn(),
  onDeviceRawMessage: jest.fn(),
  listDevicesForApi: jest.fn(() => []),
  getDeviceById: jest.fn(() => null),
  invokeDeviceCapability: jest.fn(),
  publishDeviceMessage: jest.fn(),
}));

jest.mock('../services/sttService', () => ({
  status: jest.fn(() => ({ ready: false, mode: 'none' })),
  transcribe: jest.fn(),
}));

jest.mock('../services/remoteSessionService', () => ({
  getStatus: jest.fn(() => ({ active: false })),
}));

jest.mock('../services/remoteProjectionService', () => ({
  getStatus: jest.fn(() => ({ active: false })),
}));

// 账号后端地址由每个用例指向本地假上游。
const mockAccountBase = { url: 'http://127.0.0.1:1' };
jest.mock('../services/accountService', () => ({
  getBaseUrl: () => mockAccountBase.url,
}));

class MockWebSocketServer extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    MockWebSocketServer.instance = this;
  }
}

jest.mock('ws', () => ({ WebSocketServer: MockWebSocketServer }));

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
}

function waitForReply(ws, id) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const found = ws.sent.find((msg) => msg.id === id);
      if (found) { clearInterval(timer); resolve(found); }
    }, 5);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function startUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const body = await readBody(req);
      seen.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body,
      });
      const reply = upstream.reply || { status: 200, body: {} };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

let seen;
let upstream;
let upstreamServer;
let tempDir;

describe('bridgeService cloud actions', () => {
  let bridgeService;
  let gameLaunchTokenService;
  let localSession;
  let ws;

  function initSession({ gameToken, forgedGameId } = {}) {
    bridgeService.init({});
    const server = MockWebSocketServer.instance;
    ws = new FakeWs();
    server.emit('connection', ws, {});
    ws.emit('message', Buffer.from(JSON.stringify({
      id: 'init-1',
      action: 'init',
      deviceMap: {},
      params: {},
      gameToken,
      gameId: forgedGameId,
    })));
  }

  function sendAsync(action, extra = {}) {
    const id = `req-${action}-${Math.random().toString(36).slice(2)}`;
    ws.emit('message', Buffer.from(JSON.stringify({ id, action, ...extra })));
    return waitForReply(ws, id);
  }

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    seen = [];
    upstream = { reply: { status: 200, body: {} } };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cloud-'));
    process.env.LOCAL_SESSION_PATH = path.join(tempDir, 'local-session.json');
    const started = await startUpstream();
    upstreamServer = started.server;
    mockAccountBase.url = started.url;

    localSession = require('../services/localSessionService');
    localSession._resetForTests();
    gameLaunchTokenService = require('../services/gameLaunchTokenService');
    gameLaunchTokenService._resetForTests();
    bridgeService = require('../services/bridgeService');
  });

  afterEach(async () => {
    try { bridgeService.exitCurrent(); } catch (_) {}
    upstreamServer.closeAllConnections?.();
    await new Promise((resolve) => upstreamServer.close(resolve));
    delete process.env.LOCAL_SESSION_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports local sign-in state without touching the network', async () => {
    initSession({ gameToken: gameLaunchTokenService.issue('vocab-game') });

    await expect(sendAsync('cloudStatus')).resolves.toEqual({
      id: expect.any(String), result: { signedIn: false },
    });

    localSession.deposit('jwt-cloud-token', { id: 'u1', nickname: '小明' });
    await expect(sendAsync('cloudStatus')).resolves.toEqual({
      id: expect.any(String), result: { signedIn: true, user: { id: 'u1', nickname: '小明' } },
    });
    expect(seen).toHaveLength(0);
  });

  it('loads the game data for the game bound to the launch token', async () => {
    localSession.deposit('jwt-cloud-token', { id: 'u1' });
    upstream.reply = {
      status: 200,
      body: { data: { v: 1, words: { cat: { k: 2 } } }, version: 3, updatedAt: '2026-11-01T00:00:00.000Z' },
    };
    initSession({ gameToken: gameLaunchTokenService.issue('vocab-game') });

    await expect(sendAsync('cloudGet')).resolves.toEqual({
      id: expect.any(String),
      result: { data: { v: 1, words: { cat: { k: 2 } } }, version: 3, updatedAt: '2026-11-01T00:00:00.000Z' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('GET');
    expect(seen[0].url).toBe('/me/game-data/vocab-game');
    expect(seen[0].auth).toBe('Bearer jwt-cloud-token');
  });

  it('puts game data and ignores a gameId forged by the page', async () => {
    localSession.deposit('jwt-cloud-token', { id: 'u1' });
    upstream.reply = { status: 200, body: { version: 4, updatedAt: '2026-11-02T00:00:00.000Z' } };
    initSession({ gameToken: gameLaunchTokenService.issue('vocab-game'), forgedGameId: 'other-game' });

    await expect(sendAsync('cloudPut', {
      data: { v: 1, words: { cat: { k: 2 } } },
      baseVersion: 3,
      gameId: 'other-game',
    })).resolves.toEqual({
      id: expect.any(String),
      result: { version: 4, updatedAt: '2026-11-02T00:00:00.000Z' },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('PUT');
    expect(seen[0].url).toBe('/me/game-data/vocab-game');
    expect(JSON.parse(seen[0].body)).toEqual({ data: { v: 1, words: { cat: { k: 2 } } }, baseVersion: 3 });
  });

  it('returns the remote snapshot on a version conflict', async () => {
    localSession.deposit('jwt-cloud-token', { id: 'u1' });
    upstream.reply = {
      status: 409,
      body: { code: 'VERSION_CONFLICT', data: { v: 1, words: { dog: { k: 1 } } }, version: 7 },
    };
    initSession({ gameToken: gameLaunchTokenService.issue('vocab-game') });

    await expect(sendAsync('cloudPut', { data: { v: 1 }, baseVersion: 6 })).resolves.toEqual({
      id: expect.any(String),
      error: '云端存档已被其他设备修改',
      code: 'VERSION_CONFLICT',
      remote: { data: { v: 1, words: { dog: { k: 1 } } }, version: 7 },
    });
  });

  it('maps an upstream 401 to NOT_SIGNED_IN', async () => {
    localSession.deposit('jwt-cloud-token', { id: 'u1' });
    upstream.reply = { status: 401, body: { code: 'AUTH_FAILED' } };
    initSession({ gameToken: gameLaunchTokenService.issue('vocab-game') });

    await expect(sendAsync('cloudGet')).resolves.toMatchObject({
      id: expect.any(String), code: 'NOT_SIGNED_IN',
    });
  });

  it('rejects oversized data before sending anything upstream', async () => {
    localSession.deposit('jwt-cloud-token', { id: 'u1' });
    initSession({ gameToken: gameLaunchTokenService.issue('vocab-game') });

    await expect(sendAsync('cloudPut', {
      data: { blob: 'x'.repeat(1024 * 1024 + 1) },
      baseVersion: 0,
    })).resolves.toMatchObject({ id: expect.any(String), code: 'TOO_LARGE' });
    expect(seen).toHaveLength(0);
  });

  it('refuses cloud saves when the session has no game token', async () => {
    localSession.deposit('jwt-cloud-token', { id: 'u1' });
    initSession({ forgedGameId: 'vocab-game' });

    await expect(sendAsync('cloudGet')).resolves.toMatchObject({
      id: expect.any(String), code: 'BAD_GAME',
    });
    expect(seen).toHaveLength(0);
  });

  it('maps upstream 413 and other statuses to the documented codes', async () => {
    localSession.deposit('jwt-cloud-token', { id: 'u1' });
    initSession({ gameToken: gameLaunchTokenService.issue('vocab-game') });

    upstream.reply = { status: 413, body: {} };
    await expect(sendAsync('cloudPut', { data: { v: 1 }, baseVersion: 0 }))
      .resolves.toMatchObject({ code: 'TOO_LARGE' });

    upstream.reply = { status: 500, body: { message: 'boom' } };
    await expect(sendAsync('cloudGet')).resolves.toMatchObject({ code: 'UPSTREAM_500' });
  });

  it('maps network failures to NETWORK', async () => {
    localSession.deposit('jwt-cloud-token', { id: 'u1' });
    initSession({ gameToken: gameLaunchTokenService.issue('vocab-game') });
    mockAccountBase.url = 'http://127.0.0.1:1';

    await expect(sendAsync('cloudGet')).resolves.toMatchObject({
      id: expect.any(String), code: 'NETWORK', error: '云存档服务不可用，请检查网络后重试',
    });
  });
});
