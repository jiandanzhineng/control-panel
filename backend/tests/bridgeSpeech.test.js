const EventEmitter = require('events');

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

const mockStatus = jest.fn();
const mockTranscribe = jest.fn();
jest.mock('../services/sttService', () => ({
  status: (...args) => mockStatus(...args),
  transcribe: (...args) => mockTranscribe(...args),
}));

const mockRemoteStatus = jest.fn(() => ({ active: false }));
jest.mock('../services/remoteSessionService', () => ({
  getStatus: (...args) => mockRemoteStatus(...args),
}));

const mockProjectionStatus = jest.fn(() => ({ active: false }));
jest.mock('../services/remoteProjectionService', () => ({
  getStatus: (...args) => mockProjectionStatus(...args),
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

describe('bridgeService speech actions', () => {
  let bridgeService;
  let ws;

  function initSession() {
    bridgeService.init({});
    const server = MockWebSocketServer.instance;
    ws = new FakeWs();
    server.emit('connection', ws, {});
    ws.emit('message', Buffer.from(JSON.stringify({ id: 'init-1', action: 'init', deviceMap: {}, params: {} })));
  }

  beforeEach(() => {
    jest.resetModules();
    mockStatus.mockReset();
    mockTranscribe.mockReset();
    mockRemoteStatus.mockReset().mockReturnValue({ active: false });
    mockProjectionStatus.mockReset().mockReturnValue({ active: false });
    bridgeService = require('../services/bridgeService');
    initSession();
  });

  afterEach(() => {
    try { bridgeService.exitCurrent(); } catch (_) {}
  });

  it('answers speechStatus from sttService', async () => {
    mockStatus.mockReturnValue({ ready: true, mode: 'relay' });
    ws.emit('message', Buffer.from(JSON.stringify({ id: 's1', action: 'speechStatus' })));
    await expect(waitForReply(ws, 's1')).resolves.toEqual({ id: 's1', result: { ready: true, mode: 'relay' } });
  });

  it('forwards speechToText args and returns text/mode/latency', async () => {
    mockTranscribe.mockResolvedValue({ text: '在小小的花园里', mode: 'own_key', latencyMs: 123 });
    ws.emit('message', Buffer.from(JSON.stringify({
      id: 't1', action: 'speechToText', audio: 'AAAA', format: 'wav', timeoutMs: 5000,
    })));
    await expect(waitForReply(ws, 't1')).resolves.toEqual({
      id: 't1',
      result: { text: '在小小的花园里', mode: 'own_key', latencyMs: 123 },
    });
    expect(mockTranscribe).toHaveBeenCalledWith({ audio: 'AAAA', format: 'wav', timeoutMs: 5000 });
  });

  it('rejects with the error code from sttService', async () => {
    const error = new Error('音频超过 1MB');
    error.code = 'BAD_AUDIO';
    mockTranscribe.mockRejectedValue(error);
    ws.emit('message', Buffer.from(JSON.stringify({ id: 't2', action: 'speechToText', audio: 'AAAA' })));
    await expect(waitForReply(ws, 't2')).resolves.toEqual({
      id: 't2', error: '音频超过 1MB', code: 'BAD_AUDIO',
    });
  });

  it('refuses speech while a remote session is active', async () => {
    mockRemoteStatus.mockReturnValue({ active: true, role: 'operator' });
    ws.emit('message', Buffer.from(JSON.stringify({ id: 's2', action: 'speechStatus' })));
    await expect(waitForReply(ws, 's2')).resolves.toEqual({
      id: 's2', result: { ready: false, mode: 'none', reason: 'REMOTE_LOCKED' },
    });

    ws.emit('message', Buffer.from(JSON.stringify({ id: 't3', action: 'speechToText', audio: 'AAAA' })));
    const reply = await waitForReply(ws, 't3');
    expect(reply.code).toBe('NO_STT');
    expect(mockStatus).not.toHaveBeenCalled();
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it('refuses speech while a projection is active', async () => {
    mockProjectionStatus.mockReturnValue({ active: true, role: 'owner' });
    ws.emit('message', Buffer.from(JSON.stringify({ id: 's3', action: 'speechStatus' })));
    await expect(waitForReply(ws, 's3')).resolves.toMatchObject({
      result: { ready: false, reason: 'REMOTE_LOCKED' },
    });
  });

  it('requires a host-issued vocabulary token for offline commands', async () => {
    ws.emit('message', Buffer.from(JSON.stringify({ id: 'k1', action: 'speechCommandsStart', generation: 1, seq: 1, gameId: 'vocab-game' })));
    await expect(waitForReply(ws, 'k1')).resolves.toMatchObject({ code: 'NO_KWS' });
    const token = require('../services/gameLaunchTokenService').issue('vocab-game');
    ws = new FakeWs();
    MockWebSocketServer.instance.emit('connection', ws, {});
    ws.emit('message', Buffer.from(JSON.stringify({ id: 'reinit', action: 'init', deviceMap: {}, params: {}, gameToken: token })));
    ws.emit('message', Buffer.from(JSON.stringify({ id: 'k2', action: 'speechCommandsStatus' })));
    await expect(waitForReply(ws, 'k2')).resolves.toMatchObject({ result: { ready: true, mode: 'kws' } });
    mockRemoteStatus.mockReturnValue({ active: true });
    ws.emit('message', Buffer.from(JSON.stringify({ id: 'k3', action: 'speechCommandsStart', generation: 1, seq: 1 })));
    await expect(waitForReply(ws, 'k3')).resolves.toMatchObject({ code: 'NO_KWS' });
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(mockStatus).not.toHaveBeenCalled();
  });
});
