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

let onDataChange;
const qtz = {
  id: 'qtz-1',
  type: 'QTZ',
  connected: true,
  data: { button0: 0, button1: 0, distance: 88 },
};

jest.mock('../services/deviceService', () => ({
  onDeviceDataChange: jest.fn((handler) => { onDataChange = handler; }),
  onDeviceRawMessage: jest.fn(),
  listDevicesForApi: jest.fn(() => [qtz]),
  getDeviceById: jest.fn((id) => id === qtz.id ? qtz : null),
  invokeDeviceCapability: jest.fn(),
  publishDeviceMessage: jest.fn(),
}));

class MockWebSocketServer extends EventEmitter {
  constructor() {
    super();
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

  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

function request(ws, message) {
  ws.emit('message', Buffer.from(JSON.stringify(message)));
  return ws.sent.find((item) => item.id === message.id);
}

describe('bridge capability values', () => {
  beforeEach(() => {
    jest.resetModules();
    qtz.data = { button0: 0, button1: 0, distance: 88 };
  });

  it('reads and subscribes to semantic values without breaking raw reads', () => {
    const bridgeService = require('../services/bridgeService');
    bridgeService.init({});
    const ws = new FakeWs();
    MockWebSocketServer.instance.emit('connection', ws, {});
    request(ws, {
      id: 'init',
      action: 'init',
      deviceMap: { sensor: ['qtz-1'] },
      params: {},
    });

    expect(request(ws, {
      id: 'read-value',
      action: 'readValue',
      deviceId: 'sensor',
      capability: 'tiptoePressure',
    }).result).toEqual([0]);
    expect(request(ws, {
      id: 'read-property',
      action: 'read',
      deviceId: 'sensor',
      property: 'distance',
    }).result).toEqual([88]);

    request(ws, {
      id: 'subscribe',
      action: 'subscribeValue',
      deviceId: 'sensor',
      capability: 'tiptoePressure',
    });
    qtz.data = { ...qtz.data, button1: '1' };
    onDataChange({
      deviceId: qtz.id,
      changes: { button1: { old: 0, new: '1' } },
    });
    expect(request(ws, {
      id: 'read-held-value',
      action: 'readValue',
      deviceId: 'sensor',
      capability: 'tiptoePressure',
    }).result).toEqual([200]);

    qtz.data = { ...qtz.data, button0: 1 };
    onDataChange({
      deviceId: qtz.id,
      changes: { button0: { old: 0, new: 1 } },
    });
    qtz.data = { ...qtz.data, button1: 0 };
    onDataChange({
      deviceId: qtz.id,
      changes: { button1: { old: '1', new: 0 } },
    });
    qtz.data = { ...qtz.data, button0: 0 };
    onDataChange({
      deviceId: qtz.id,
      changes: { button0: { old: 1, new: 0 } },
    });

    const valueEvents = ws.sent.filter((item) => item.event === 'capabilityValueChange');
    expect(valueEvents).toEqual([
      expect.objectContaining({ value: 200, oldValue: 0 }),
      expect.objectContaining({ value: 0, oldValue: 200 }),
    ]);
  });
});
