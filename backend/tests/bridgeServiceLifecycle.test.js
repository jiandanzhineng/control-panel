const EventEmitter = require('events');

jest.mock('../services/logService', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../services/virtualDeviceService', () => ({
  isVirtualDevice: jest.fn(() => false),
  interceptCommand: jest.fn(),
}));

jest.mock('../devices/registry', () => ({
  getDeviceCapabilities: jest.fn(() => ['shock', 'strength']),
}));

jest.mock('../devices/capabilities', () => ({
  getCapabilityDefinition: jest.fn(() => null),
}));

const mockInvokeDeviceCapability = jest.fn();

jest.mock('../services/deviceService', () => ({
  onDeviceDataChange: jest.fn(),
  onDeviceRawMessage: jest.fn(),
  listDevicesForApi: jest.fn(() => []),
  getDeviceById: jest.fn(() => ({ id: 'dev-1', type: 'CUNZHI01' })),
  invokeDeviceCapability: (...args) => mockInvokeDeviceCapability(...args),
  publishDeviceMessage: jest.fn(),
}));

class MockWebSocketServer extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    MockWebSocketServer.instance = this;
  }
}

jest.mock('ws', () => ({
  WebSocketServer: MockWebSocketServer,
}));

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

function initSession(server, ws, deviceMap = { shock: ['dev-1'] }) {
  server.emit('connection', ws, {});
  ws.emit('message', Buffer.from(JSON.stringify({
    id: 'init-1',
    action: 'init',
    deviceMap,
    params: {},
  })));
}

describe('bridgeService lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    mockInvokeDeviceCapability.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resets active session on explicit exit', () => {
    const bridgeService = require('../services/bridgeService');
    bridgeService.init({});
    const server = MockWebSocketServer.instance;
    const ws = new FakeWs();
    initSession(server, ws);

    bridgeService.exitCurrent();

    expect(mockInvokeDeviceCapability).toHaveBeenCalledWith('dev-1', 'shock', 'stop', {});
    expect(mockInvokeDeviceCapability).toHaveBeenCalledWith('dev-1', 'strength', 'stop', {});
    expect(bridgeService.getActiveSessions()).toHaveLength(0);
  });

  it('does not reset immediately on websocket close', () => {
    const bridgeService = require('../services/bridgeService');
    bridgeService.init({});
    const server = MockWebSocketServer.instance;
    const ws = new FakeWs();
    initSession(server, ws);

    ws.emit('close');

    expect(mockInvokeDeviceCapability).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60000);
    expect(mockInvokeDeviceCapability).toHaveBeenCalledWith('dev-1', 'shock', 'stop', {});
  });
});
