const { EventEmitter } = require('events');
const { SerialConnectionService } = require('../services/serialConnectionService');

class FakeSerialPort extends EventEmitter {
  static instances = [];
  static responseForPath = new Map();

  constructor(options) {
    super();
    this.path = options.path;
    this.options = options;
    this.isOpen = false;
    this.writes = [];
    this.drains = 0;
    FakeSerialPort.instances.push(this);
  }

  open(callback) {
    this.isOpen = true;
    callback();
  }

  write(data, callback) {
    this.writes.push(data);
    callback?.();
    const response = FakeSerialPort.responseForPath.get(this.path);
    if (data === '@DEBUG START\r\n' && response && !this.responded) {
      this.responded = true;
      setImmediate(() => this.emit('data', response));
    }
  }

  drain(callback) {
    this.drains += 1;
    callback();
  }

  close(callback) {
    this.isOpen = false;
    callback?.();
    this.emit('close');
  }
}

function createHarness(options = {}) {
  const devices = new Map();
  const deviceService = {
    connectTransportDevice: jest.fn((metadata) => {
      const device = {
        id: metadata.id,
        type: metadata.type,
        connected: true,
        controlConnection: 'serial',
        connections: [{ type: 'serial', portPath: metadata.transportMetadata.portPath }],
        data: metadata.data || {},
      };
      devices.set(metadata.id, device);
      return device;
    }),
    getDeviceForApi: jest.fn((id) => devices.get(id) || null),
    handleTransportMessage: jest.fn((id, message) => {
      const device = devices.get(id);
      if (device && message.device_type) device.type = message.device_type;
      return true;
    }),
    disconnectTransportDevice: jest.fn(),
  };
  const values = new Map();
  const storage = {
    getItem: jest.fn((key) => values.get(key) || null),
    setItem: jest.fn((key, value) => values.set(key, value)),
  };
  const ports = options.ports || [{ path: 'COM5', manufacturer: 'Espressif' }];
  const service = new SerialConnectionService({
    SerialPortClass: FakeSerialPort,
    listPorts: jest.fn(async () => ports),
    deviceService,
    storage,
  });
  return { service, deviceService, storage, devices };
}

describe('SerialConnectionService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FakeSerialPort.instances = [];
    FakeSerialPort.responseForPath = new Map();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('accepts strict identity, preserves a same-chunk report and queues commands', async () => {
    const response = '@DEBUG READY {"device_id":"aabbccddeeff","firmware_version":"v1.2.3"}\r\n'
      + '@MSG {"method":"report","device_type":"CUNZHI01","power":0}\r\n';
    FakeSerialPort.responseForPath.set('COM5', response);
    const { service, deviceService } = createHarness();

    const pending = service.connect('COM5');
    await jest.runAllTimersAsync();
    const device = await pending;
    expect(device).toMatchObject({ id: 'aabbccddeeff', type: 'CUNZHI01' });
    expect(deviceService.handleTransportMessage).toHaveBeenCalledWith(
      'aabbccddeeff',
      { method: 'report', device_type: 'CUNZHI01', power: 0 },
      'serial',
    );

    const adapter = deviceService.connectTransportDevice.mock.calls[0][1];
    adapter.send({ method: 'stop' });
    await Promise.resolve();
    await Promise.resolve();
    expect(FakeSerialPort.instances[0].writes).toContain('@CMD {"method":"stop"}\r\n');
    expect(FakeSerialPort.instances[0].drains).toBe(1);
    await service.shutdown();
  });

  it('rejects legacy READY immediately and closes the port', async () => {
    FakeSerialPort.responseForPath.set('COM5', '@DEBUG READY\r\n');
    const { service } = createHarness();
    const pending = service.connect('COM5');
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'SERIAL_IDENTITY_INVALID', status: 409,
    });
    await jest.runAllTimersAsync();
    await rejected;
    expect(FakeSerialPort.instances[0].isOpen).toBe(false);
  });

  it('retries START every 500ms, times out at 3 seconds and enters backoff', async () => {
    const { service } = createHarness();
    const pending = service.connect('COM5');
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'SERIAL_PROBE_TIMEOUT', status: 408,
    });
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(FakeSerialPort.instances[0].writes.filter((line) => line === '@DEBUG START\r\n').length)
      .toBeGreaterThanOrEqual(6);
    const ports = await service.listPorts();
    expect(ports[0].status).toBe('backoff');
    expect(FakeSerialPort.instances[0].isOpen).toBe(false);
  });

  it('cancels an in-flight probe during shutdown', async () => {
    const { service } = createHarness();
    const pending = service.connect('COM5');
    await Promise.resolve();
    await Promise.resolve();
    await service.shutdown();
    await expect(pending).rejects.toMatchObject({ code: 'SERIAL_PROBE_CANCELLED' });
    expect(FakeSerialPort.instances[0].isOpen).toBe(false);
    expect(service.pendingConnections.size).toBe(0);
  });

  it('persists auto-connect and reports port state directly', async () => {
    const { service, storage } = createHarness();
    const settings = await service.setSettings({ autoConnect: true });
    expect(settings).toEqual({ autoConnect: true });
    expect(storage.setItem).toHaveBeenCalledWith(
      'serial-connection-settings',
      JSON.stringify({ autoConnect: true }),
    );
    expect(await service.listPorts()).toEqual([
      expect.objectContaining({ path: 'COM5', status: 'probing' }),
    ]);
    await service.setSettings({ autoConnect: false });
  });
});
