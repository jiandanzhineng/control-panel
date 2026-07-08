jest.mock('../services/logService', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockInterceptCommand = jest.fn();
jest.mock('../services/virtualDeviceService', () => ({
  isVirtualDevice: jest.fn((id) => String(id).startsWith('virtual-')),
  interceptCommand: (...args) => mockInterceptCommand(...args),
}));

jest.mock('../devices/registry', () => ({
  getDeviceCapabilities: jest.fn((type) => {
    if (type === 'DIANJI') return ['shock'];
    if (type === 'TD01') return ['strength'];
    return [];
  }),
  hasCapability: jest.fn((type, capability) => {
    if (type === 'DIANJI') return capability === 'shock';
    if (type === 'TD01') return capability === 'strength';
    return false;
  }),
}));

jest.mock('../devices/capabilities', () => ({
  getCapabilityDefinition: jest.fn(() => null),
}));

const mockInvokeDeviceCapability = jest.fn();
const mockPublishDeviceMessage = jest.fn();

jest.mock('../services/deviceService', () => ({
  onDeviceDataChange: jest.fn(),
  onDeviceRawMessage: jest.fn(),
  listDevicesForApi: jest.fn(() => [
    { id: 'shock-1', type: 'DIANJI', connected: true, data: {} },
    { id: 'motor-1', type: 'TD01', connected: true, data: { power: 0 } },
  ]),
  getDeviceById: jest.fn((id) => {
    if (id === 'shock-1') return { id: 'shock-1', type: 'DIANJI', data: {} };
    if (id === 'motor-1') return { id: 'motor-1', type: 'TD01', data: { power: 0 } };
    return null;
  }),
  invokeDeviceCapability: (...args) => mockInvokeDeviceCapability(...args),
  publishDeviceMessage: (...args) => mockPublishDeviceMessage(...args),
}));

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

describe('bridgeService browser device sessions', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    mockInvokeDeviceCapability.mockClear();
    mockPublishDeviceMessage.mockClear();
    mockInterceptCommand.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lets an origin invoke all mapped devices by physical id or compatibility aliases', () => {
    const bridgeService = require('../services/bridgeService');
    bridgeService.init({});

    bridgeService.runBrowserCommand('https://example.com', 'invoke', {
      deviceId: 'shock',
      capability: 'shock',
      actionName: 'start',
      params: { voltage: 999 },
    });
    bridgeService.runBrowserCommand('https://example.com', 'invoke', {
      deviceId: 'motor-1',
      capability: 'strength',
      actionName: 'set',
      params: { value: 999 },
    });

    expect(mockInvokeDeviceCapability).toHaveBeenCalledWith('shock-1', 'shock', 'start', { voltage: 100 });
    expect(mockInvokeDeviceCapability).toHaveBeenCalledWith('motor-1', 'strength', 'set', { value: 255 });
  });

  it('rejects unsupported capabilities even after browser access is granted', () => {
    const bridgeService = require('../services/bridgeService');
    bridgeService.init({});

    expect(() => bridgeService.runBrowserCommand('https://example.com', 'invoke', {
      deviceId: 'motor-1',
      capability: 'shock',
      actionName: 'start',
      params: { voltage: 10 },
    })).toThrow(/不支持能力/);
  });

  it('resets the active browser session when the origin exits', () => {
    const bridgeService = require('../services/bridgeService');
    bridgeService.init({});

    bridgeService.runBrowserCommand('https://example.com', 'invoke', {
      deviceId: 'shock-1',
      capability: 'shock',
      actionName: 'start',
      params: { voltage: 30 },
    });
    bridgeService.exitBrowserOrigin('https://example.com');

    expect(mockInvokeDeviceCapability).toHaveBeenCalledWith('shock-1', 'shock', 'stop', {});
    expect(mockInvokeDeviceCapability).toHaveBeenCalledWith('motor-1', 'strength', 'stop', {});
    expect(bridgeService.getActiveSessions()).toHaveLength(0);
  });

  it('does not reset another active origin', () => {
    const bridgeService = require('../services/bridgeService');
    bridgeService.init({});

    bridgeService.runBrowserCommand('https://example.com', 'getDevices', {});

    expect(bridgeService.getActiveSessions()).toHaveLength(0);
    expect(mockInvokeDeviceCapability).not.toHaveBeenCalledWith('shock-1', 'shock', 'stop', {});
  });

  it('does not create an active browser session for read-only commands', () => {
    const bridgeService = require('../services/bridgeService');
    bridgeService.init({});

    expect(bridgeService.runBrowserCommand('https://example.com', 'getDeviceMap', {})).toMatchObject({
      shock: ['shock-1'],
      vibrator: ['motor-1'],
    });
    expect(bridgeService.runBrowserCommand('https://example.com', 'read', {
      deviceId: 'motor-1',
      property: 'power',
    })).toEqual([0]);

    expect(bridgeService.getActiveSessions()).toHaveLength(0);
  });
});
