const { EventEmitter } = require('events');
const { SerialConnectionService } = require('../services/serialConnectionService');

class FakeSerialPort extends EventEmitter {
  static instances = [];
  static responseForPath = new Map();
  static hangCommandWrites = false;

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
    if (data.startsWith('@CMD ') && FakeSerialPort.hangCommandWrites) return;
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
    FakeSerialPort.hangCommandWrites = false;
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

  it('forces the port closed when a queued write never completes', async () => {
    FakeSerialPort.responseForPath.set(
      'COM5',
      '@DEBUG READY {"device_id":"aabbccddeeff","firmware_version":"v1.2.3"}\r\n',
    );
    const { service, deviceService } = createHarness();
    const pending = service.connect('COM5');
    await jest.runAllTimersAsync();
    await pending;

    FakeSerialPort.hangCommandWrites = true;
    const adapter = deviceService.connectTransportDevice.mock.calls[0][1];
    adapter.send({ method: 'stop' });
    await Promise.resolve();
    const shuttingDown = service.shutdown();

    await jest.advanceTimersByTimeAsync(999);
    expect(FakeSerialPort.instances[0].isOpen).toBe(true);
    await jest.advanceTimersByTimeAsync(1);
    await shuttingDown;
    expect(FakeSerialPort.instances[0].isOpen).toBe(false);
    expect(deviceService.disconnectTransportDevice)
      .toHaveBeenCalledWith('aabbccddeeff', 'serial');
  });

  it('cancels and releases an automatic probe as soon as its port is removed', async () => {
    const ports = [{ path: 'COM5', manufacturer: 'Espressif' }];
    const { service } = createHarness({ ports });
    await service.setSettings({ autoConnect: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(service.pendingConnections.has('COM5')).toBe(true);

    ports.splice(0, ports.length);
    await service.pollPorts();
    expect(FakeSerialPort.instances[0].isOpen).toBe(false);
    expect(service.pendingConnections.size).toBe(0);
    expect(service.serializePorts()).toEqual([]);
    await service.setSettings({ autoConnect: false });
  });

  it('does not put a cancelled automatic probe into backoff', async () => {
    const { service } = createHarness();
    await service.setSettings({ autoConnect: true });
    await Promise.resolve();
    await Promise.resolve();
    await service.setSettings({ autoConnect: false });

    expect(service.serializePorts()).toEqual([
      expect.objectContaining({
        path: 'COM5',
        status: 'idle',
        retryAt: null,
        lastError: null,
      }),
    ]);
    expect(service.portInfo.get('COM5')).toMatchObject({ failures: 0, nextRetryAt: 0 });
  });

  it('reuses one pending or connected session for duplicate path requests', async () => {
    FakeSerialPort.responseForPath.set(
      'COM5',
      '@DEBUG READY {"device_id":"aabbccddeeff","firmware_version":"v1.2.3"}\r\n',
    );
    const { service, deviceService } = createHarness();

    const first = service.connect('COM5');
    const duplicatePending = service.connect('COM5');
    await jest.runAllTimersAsync();
    const [firstDevice, duplicateDevice] = await Promise.all([first, duplicatePending]);
    const duplicateConnected = await service.connect('COM5');

    expect(duplicateDevice).toEqual(firstDevice);
    expect(duplicateConnected).toEqual(firstDevice);
    expect(FakeSerialPort.instances).toHaveLength(1);
    expect(deviceService.connectTransportDevice).toHaveBeenCalledTimes(1);
    await service.shutdown();
  });

  it('closes a second port that reports an already connected device identity', async () => {
    const identity = '@DEBUG READY '
      + '{"device_id":"aabbccddeeff","firmware_version":"v1.2.3"}\r\n';
    FakeSerialPort.responseForPath.set('COM5', identity);
    FakeSerialPort.responseForPath.set('COM6', identity);
    const { service, deviceService } = createHarness({
      ports: [{ path: 'COM5' }, { path: 'COM6' }],
    });

    const first = service.connect('COM5');
    await jest.runAllTimersAsync();
    await first;

    const duplicate = service.connect('COM6');
    const rejected = expect(duplicate).rejects.toMatchObject({
      code: 'SERIAL_DEVICE_ALREADY_CONNECTED', status: 409,
    });
    await jest.runAllTimersAsync();
    await rejected;

    expect(FakeSerialPort.instances).toHaveLength(2);
    expect(FakeSerialPort.instances[0].isOpen).toBe(true);
    expect(FakeSerialPort.instances[1].isOpen).toBe(false);
    expect(service.sessions.has('COM5')).toBe(true);
    expect(service.sessions.has('COM6')).toBe(false);
    expect(deviceService.connectTransportDevice).toHaveBeenCalledTimes(1);
    await service.shutdown();
  });

  it('emits port-added / port-removed as ports appear and disappear', async () => {
    const ports = [{ path: 'COM5' }];
    const { service } = createHarness({ ports });
    const added = [];
    const removed = [];
    service.on('port-added', (port) => added.push(port.path));
    service.on('port-removed', ({ path }) => removed.push(path));

    await service.refreshPortList();
    expect(added).toEqual(['COM5']);

    ports.push({ path: 'COM6' });
    await service.refreshPortList();
    expect(added).toEqual(['COM5', 'COM6']);

    ports.splice(0, 1);
    await service.refreshPortList();
    expect(removed).toEqual(['COM5']);
    await service.shutdown();
  });

  it('skips reserved ports during auto polling but allows the holder through', async () => {
    FakeSerialPort.responseForPath.set('COM5', '@DEBUG READY {"device_id":"aabbccddeeff","firmware_version":"v1.2.3"}\r\n');
    const { service } = createHarness();
    const token = Symbol('holder');
    service.settings.autoConnect = true;
    const release = service.reservePort('COM5', token);

    await service.pollPorts();
    await jest.runAllTimersAsync();
    expect(service.sessions.has('COM5')).toBe(false);

    await expect(service.connect('COM5', { automatic: false })).rejects.toMatchObject({
      code: 'SERIAL_PORT_RESERVED', status: 409,
    });

    const pending = service.connect('COM5', { reservationToken: token });
    await jest.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: 'aabbccddeeff' });

    release();
    expect(service.reservations.has('COM5')).toBe(false);
    await service.shutdown();
  });

  it('rejects a reservation held by another owner and ignores foreign releases', () => {
    const { service } = createHarness();
    const first = Symbol('first');
    service.reservePort('COM5', first);
    expect(() => service.reservePort('COM5', Symbol('second'))).toThrow(/已被其他流程预留/);
    expect(service.releasePort('COM5', Symbol('other'))).toBe(false);
    expect(service.releasePort('COM5', first)).toBe(true);
  });

  it('firmware update preempts an established serial session and blocks reconnects', async () => {
    FakeSerialPort.responseForPath.set(
      'COM5',
      '@DEBUG READY {"device_id":"aabbccddeeff","firmware_version":"v1.2.3"}\r\n',
    );
    const { service, deviceService } = createHarness();
    const connected = service.connect('COM5');
    await jest.runAllTimersAsync();
    await connected;

    const lease = await service.acquireFirmwarePort('COM5', { owner: 'test-flash' });

    expect(service.isFirmwarePortLocked('COM5')).toBe(true);
    expect(service.sessions.has('COM5')).toBe(false);
    expect(FakeSerialPort.instances[0].isOpen).toBe(false);
    expect(deviceService.disconnectTransportDevice)
      .toHaveBeenCalledWith('aabbccddeeff', 'serial');
    await expect(service.connect('COM5')).rejects.toMatchObject({
      code: 'SERIAL_PREEMPTED_BY_FIRMWARE', status: 409,
    });

    expect(lease.release()).toBe(true);
    expect(lease.release()).toBe(false);
    expect(service.isFirmwarePortLocked('COM5')).toBe(false);
  });

  it('firmware update cancels an in-flight probe before taking the port', async () => {
    const { service } = createHarness();
    const pending = service.connect('COM5');
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'SERIAL_PREEMPTED_BY_FIRMWARE', status: 409,
    });

    const lease = await service.acquireFirmwarePort('COM5');

    await rejected;
    expect(service.pendingConnections.has('COM5')).toBe(false);
    expect(FakeSerialPort.instances[0].isOpen).toBe(false);
    expect(service.portInfo.get('COM5')).toMatchObject({ failures: 0, nextRetryAt: 0 });
    lease.release();
  });

  it('firmware update overrides foreign reservations but preserves its caller reservation', async () => {
    const { service } = createHarness();
    await service.listPorts();
    const foreignToken = Symbol('foreign');
    service.reservePort('COM5', foreignToken);

    const firstLease = await service.acquireFirmwarePort('COM5');
    expect(service.reservations.has('COM5')).toBe(false);
    expect(service.serializePorts()).toEqual([
      expect.objectContaining({ path: 'COM5', status: 'firmware', firmwareLocked: true }),
    ]);
    expect(() => service.reservePort('COM5', foreignToken)).toThrow(/固件更新/);
    await expect(service.acquireFirmwarePort('COM5')).rejects.toMatchObject({
      code: 'FIRMWARE_UPDATE_IN_PROGRESS', status: 409,
    });
    firstLease.release();

    const callerToken = Symbol('caller');
    service.reservePort('COM5', callerToken);
    const secondLease = await service.acquireFirmwarePort('COM5', { reservationToken: callerToken });
    expect(service.reservations.get('COM5')).toBe(callerToken);
    secondLease.release();
  });
});
