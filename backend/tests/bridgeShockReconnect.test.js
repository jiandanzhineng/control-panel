// 同配置快速重连会销毁旧会话；旧页面发出的电击必须先补发 stop，不能连同自动停止定时器一起丢掉。
const EventEmitter = require('events');

jest.mock('../services/logService', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/virtualDeviceService', () => ({ isVirtualDevice: jest.fn(() => false), interceptCommand: jest.fn() }));
jest.mock('../devices/registry', () => ({
  getDeviceCapabilities: jest.fn(() => ['shock']),
  hasCapability: jest.fn(() => true),
}));
jest.mock('../devices/capabilities', () => ({ getCapabilityDefinition: jest.fn(() => null) }));
jest.mock('../services/deviceService', () => ({
  onDeviceDataChange: jest.fn(),
  onDeviceRawMessage: jest.fn(),
  listDevicesForApi: jest.fn(() => []),
  getDeviceById: jest.fn((id) => (id === 'dev1' ? { id: 'dev1', type: 'dianji' } : null)),
  invokeDeviceCapability: jest.fn(),
  publishDeviceMessage: jest.fn(),
}));

class MockWebSocketServer extends EventEmitter {
  constructor() { super(); MockWebSocketServer.instance = this; }
}
jest.mock('ws', () => ({ WebSocketServer: MockWebSocketServer }));

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
}

function connect(bridgeService) {
  const ws = new FakeWs();
  MockWebSocketServer.instance.emit('connection', ws, {});
  ws.emit('message', Buffer.from(JSON.stringify({
    id: 'init', action: 'init', deviceMap: { shock: ['dev1'] }, params: { shockDuration: 5 },
  })));
  return ws;
}

describe('bridge 同配置快速重连', () => {
  afterEach(() => { jest.useRealTimers(); });

  it('旧会话电击未自动停止时，重连前补发 shock stop', () => {
    jest.useFakeTimers();
    jest.resetModules();
    const deviceService = require('../services/deviceService');
    const bridgeService = require('../services/bridgeService');
    bridgeService.init({});
    const ws1 = connect(bridgeService);
    ws1.emit('message', Buffer.from(JSON.stringify({
      id: 's1', action: 'invoke', deviceId: 'shock', capability: 'shock', actionName: 'start', params: { voltage: 10 },
    })));
    expect(deviceService.invokeDeviceCapability).toHaveBeenCalledWith('dev1', 'shock', 'start', expect.any(Object));
    ws1.close();
    connect(bridgeService);
    expect(deviceService.invokeDeviceCapability).toHaveBeenCalledWith('dev1', 'shock', 'stop', {});
    bridgeService.exitCurrent();
  });
});
