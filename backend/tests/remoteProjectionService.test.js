const { EventEmitter } = require('events');
const { RemoteProjectionService } = require('../services/remoteProjectionService');

function topicMatches(pattern, topic) {
  const expected = pattern.split('/');
  const actual = topic.split('/');
  return expected.length === actual.length
    && expected.every((part, index) => part === '+' || part === actual[index]);
}

class FakeBroker {
  constructor() {
    this.clients = new Set();
    this.retained = new Map();
    this.published = [];
  }

  connect = (_url, options) => {
    const client = new EventEmitter();
    client.options = { ...options };
    client.subscriptions = [];
    client.subscribe = (topics, _opts, callback) => {
      client.subscriptions.push(...topics);
      callback?.(null);
      for (const [topic, payload] of this.retained) {
        if (topics.some((pattern) => topicMatches(pattern, topic))) {
          queueMicrotask(() => client.emit('message', topic, Buffer.from(payload)));
        }
      }
    };
    client.publish = (topic, payload, publishOptions, callback) => {
      this.published.push({ topic, payload });
      if (publishOptions?.retain) this.retained.set(topic, payload);
      for (const subscriber of this.clients) {
        if (subscriber.subscriptions.some((pattern) => topicMatches(pattern, topic))) {
          queueMicrotask(() => subscriber.emit('message', topic, Buffer.from(payload)));
        }
      }
      callback?.(null);
    };
    client.reconnect = () => queueMicrotask(() => client.emit('connect'));
    client.end = (_force, _opts, callback) => {
      this.clients.delete(client);
      client.emit('close');
      callback?.();
    };
    this.clients.add(client);
    queueMicrotask(() => client.emit('connect'));
    return client;
  };
}

class FakeDevices {
  constructor(localDevices = []) {
    this.rows = new Map(localDevices.map((device) => [device.id, structuredClone(device)]));
    this.adapters = new Map();
    this.sent = [];
    this.closed = [];
    this.dataHandlers = [];
    this.rawHandlers = [];
    this.listHandlers = [];
    this.sendError = null;
  }

  onDeviceDataChange(handler) { this.dataHandlers.push(handler); }
  onDeviceRawMessage(handler) { this.rawHandlers.push(handler); }
  onDeviceListChange(handler) { this.listHandlers.push(handler); }
  listDevicesForApi() { return [...this.rows.values()].map((row) => structuredClone(row)); }
  getDeviceForApi(id) { return this.rows.has(id) ? structuredClone(this.rows.get(id)) : null; }

  connectTransportDevice(input, adapter) {
    const row = {
      id: input.id,
      name: input.name,
      type: input.type,
      connected: true,
      connectionType: 'remote',
      controlConnection: 'remote',
      connections: [{ type: 'remote', connected: true, ...(input.transportMetadata || {}) }],
      data: { ...(input.data || {}) },
    };
    this.rows.set(input.id, row);
    this.adapters.set(input.id, adapter);
    return structuredClone(row);
  }

  disconnectTransportDevice(id, type) {
    const row = this.rows.get(id);
    if (!row || type !== 'remote') return false;
    row.connected = false;
    row.connectionType = null;
    row.controlConnection = null;
    row.connections = [];
    this.adapters.delete(id);
    return true;
  }

  publishDeviceMessage(id, message) { this.sent.push({ id, message }); }
  async sendDeviceMessageAndWait(id, message) {
    if (this.sendError) throw this.sendError;
    this.sent.push({ id, message });
  }
  invokeDeviceClose(id) { this.closed.push(id); }

  addLocal(device) {
    this.rows.set(device.id, structuredClone(device));
    for (const handler of this.listHandlers) handler({ reason: 'connected', deviceId: device.id });
  }

  removeLocal(id) {
    this.rows.delete(id);
    for (const handler of this.listHandlers) handler({ reason: 'disconnected', deviceId: id });
  }

  handleTransportMessage(id, payload, type) {
    const row = this.rows.get(id);
    if (!row || type !== 'remote') return false;
    if (payload.method === 'update' || payload.method === 'report') {
      const data = { ...payload };
      delete data.method;
      row.data = { ...row.data, ...data };
    }
    return true;
  }

  emitData(id, data) {
    const row = this.rows.get(id);
    row.data = { ...row.data, ...data };
    for (const handler of this.dataHandlers) {
      handler({ deviceId: id, device: row, nextData: row.data });
    }
  }
}

function createRoomApi() {
  const room = {
    id: 'room-1', joinCode: 'JOIN123', hostUserId: 'owner', hostEpoch: 0,
    status: 'active', capacity: 8, members: [], expiresAt: '2099-01-01T00:00:00.000Z',
  };
  return {
    getBaseUrl: () => 'http://room.test',
    createRoom: jest.fn(async () => room),
    joinRoom: jest.fn(async () => room),
    activateRoom: jest.fn(async () => null),
    heartbeat: jest.fn(async () => null),
    getMqttCredential: jest.fn(async (token) => ({
      brokerUrl: 'mqtt://room.test',
      roomId: room.id,
      userId: token,
      role: token === 'owner' ? 'host' : 'player',
      clientId: `client-${token}`,
      username: token,
      password: 'jwt',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })),
    leaveRoom: jest.fn(async () => null),
    closeRoom: jest.fn(async () => null),
  };
}

function timers() {
  return {
    setTimer: (fn, delay) => ({ kind: 'timeout', fn, delay }),
    clearTimer: () => {},
    setRepeating: (fn, delay) => ({ kind: 'interval', fn, delay }),
    clearRepeating: () => {},
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('RemoteProjectionService', () => {
  test('projects a local device, clamps remote writes and forwards state', async () => {
    const broker = new FakeBroker();
    const api = createRoomApi();
    const ownerDevices = new FakeDevices([{
      id: 'dev-1', name: 'Owner device', type: 'CUNZHI01', connected: true,
      connectionType: 'ble', controlConnection: 'ble',
      connections: [{ type: 'ble', connected: true }], data: { pressure: 1 },
    }]);
    const operatorDevices = new FakeDevices();
    const owner = new RemoteProjectionService({
      devices: ownerDevices, api, mqttConnect: broker.connect, ...timers(),
    });
    const operator = new RemoteProjectionService({
      devices: operatorDevices, api, mqttConnect: broker.connect, ...timers(),
    });

    const ownerStatus = await owner.create({
      token: 'owner', controlTtlSec: 3600, limits: { voltage: 20, power: 128 },
    });
    expect(ownerStatus.joinCode).toBe('JOIN123');
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();

    expect(operator.getStatus()).toMatchObject({
      active: true,
      role: 'operator',
      devices: [expect.objectContaining({ id: 'dev-1', connectionType: 'remote' })],
    });

    ownerDevices.addLocal({
      id: 'dev-2', name: 'Later device', type: 'CUNZHI01', connected: true,
      connectionType: 'mqtt', controlConnection: 'mqtt',
      connections: [{ type: 'mqtt', connected: true }], data: {},
    });
    await flush();
    expect(operator.getStatus().devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'dev-1' }),
      expect.objectContaining({ id: 'dev-2' }),
    ]));

    operatorDevices.adapters.get('dev-1').send({
      method: 'update', voltage: 90, power: 240, shock: 1,
    });
    await flush();
    expect(ownerDevices.sent).toContainEqual({
      id: 'dev-1',
      message: { method: 'update', voltage: 20, power: 128, shock: 1 },
    });
    const write = [...broker.published].reverse().find(({ topic, payload }) => (
      topic === 'rooms/room-1/commands/operator'
        && JSON.parse(payload).type === 'projection.write'
    ));
    owner.session.client.emit('message', write.topic, Buffer.from(write.payload));
    await flush();
    expect(ownerDevices.sent.filter(({ id }) => id === 'dev-1')).toHaveLength(1);

    ownerDevices.emitData('dev-1', { pressure: 42 });
    await flush();
    expect(operatorDevices.getDeviceForApi('dev-1').data.pressure).toBe(42);

    ownerDevices.removeLocal('dev-2');
    await flush();
    expect(operator.getStatus().devices).toEqual([
      expect.objectContaining({ id: 'dev-1' }),
    ]);

    owner.session.timers.ttl.fn();
    await flush();
    expect(owner.getStatus().expired).toBe(true);
    expect(operator.getStatus().devices).toEqual([]);
    expect(ownerDevices.closed).toContain('dev-1');

    owner.session.timers.heartbeat.fn();
    await flush();
    expect(operator.getStatus().devices).toEqual([]);

    await operator.stop();
    await flush();
    await owner.stop();
    expect(api.closeRoom).toHaveBeenCalledWith('owner', 'room-1');
  });

  test('publishes offline before leaving so the owner safely stops devices', async () => {
    const broker = new FakeBroker();
    const api = createRoomApi();
    const ownerDevices = new FakeDevices([{
      id: 'dev-1', name: 'Owner device', type: 'CUNZHI01', connected: true,
      connectionType: 'ble', controlConnection: 'ble',
      connections: [{ type: 'ble', connected: true }], data: {},
    }]);
    const owner = new RemoteProjectionService({
      devices: ownerDevices, api, mqttConnect: broker.connect, ...timers(),
    });
    const operator = new RemoteProjectionService({
      devices: new FakeDevices(), api, mqttConnect: broker.connect, ...timers(),
    });

    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();
    ownerDevices.closed = [];

    await operator.stop();
    await flush();

    expect(ownerDevices.closed).toContain('dev-1');
    await owner.stop();
  });

  test('returns owner transport failures to the operator', async () => {
    const broker = new FakeBroker();
    const api = createRoomApi();
    const ownerDevices = new FakeDevices([{
      id: 'dev-1', name: 'Owner device', type: 'CUNZHI01', connected: true,
      connectionType: 'ble', controlConnection: 'ble',
      connections: [{ type: 'ble', connected: true }], data: {},
    }]);
    const operatorDevices = new FakeDevices();
    const owner = new RemoteProjectionService({
      devices: ownerDevices, api, mqttConnect: broker.connect, ...timers(),
    });
    const operator = new RemoteProjectionService({
      devices: operatorDevices, api, mqttConnect: broker.connect, ...timers(),
    });

    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();
    ownerDevices.sendError = Object.assign(new Error('BLE write failed'), {
      code: 'BLE_WRITE_FAILED',
    });

    await expect(operatorDevices.adapters.get('dev-1').send({
      method: 'update', power: 10,
    })).rejects.toMatchObject({ code: 'BLE_WRITE_FAILED' });

    await operator.stop();
    await owner.stop();
  });

  test('handles mqtt disconnects immediately and rejects stale adapters', async () => {
    const broker = new FakeBroker();
    const api = createRoomApi();
    const ownerDevices = new FakeDevices([{
      id: 'dev-1', name: 'Owner device', type: 'CUNZHI01', connected: true,
      connectionType: 'ble', controlConnection: 'ble',
      connections: [{ type: 'ble', connected: true }], data: {},
    }]);
    const operatorDevices = new FakeDevices();
    const owner = new RemoteProjectionService({
      devices: ownerDevices, api, mqttConnect: broker.connect, ...timers(),
    });
    const operator = new RemoteProjectionService({
      devices: operatorDevices, api, mqttConnect: broker.connect, ...timers(),
    });

    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();

    const disconnectedAdapter = operatorDevices.adapters.get('dev-1');
    operator.session.client.emit('close');
    expect(operator.getStatus().devices).toEqual([]);
    expect(() => disconnectedAdapter.send({ method: 'update', power: 1 }))
      .toThrow(expect.objectContaining({ code: 'ROOM_DISCONNECTED' }));

    operator.session.client.emit('connect');
    await flush();
    expect(operator.getStatus().devices).toEqual([
      expect.objectContaining({ id: 'dev-1', connectionType: 'remote' }),
    ]);

    ownerDevices.closed = [];
    owner.session.client.emit('close');
    expect(ownerDevices.closed).toEqual(['dev-1']);

    const staleAdapter = operatorDevices.adapters.get('dev-1');
    await operator.stop();
    expect(() => staleAdapter.send({ method: 'update', power: 1 }))
      .toThrow(expect.objectContaining({ code: 'ROOM_DISCONNECTED' }));

    ownerDevices.closed = [];
    await owner.stop();
    expect(ownerDevices.closed).toEqual(['dev-1']);
  });

  test('rejects expired writes and ignores expired device lists', async () => {
    const broker = new FakeBroker();
    const api = createRoomApi();
    const ownerDevices = new FakeDevices([{
      id: 'dev-1', name: 'Owner device', type: 'CUNZHI01', connected: true,
      connectionType: 'ble', controlConnection: 'ble',
      connections: [{ type: 'ble', connected: true }], data: {},
    }]);
    const operatorDevices = new FakeDevices();
    const owner = new RemoteProjectionService({
      devices: ownerDevices, api, mqttConnect: broker.connect, ...timers(),
    });
    const operator = new RemoteProjectionService({
      devices: operatorDevices, api, mqttConnect: broker.connect, ...timers(),
    });

    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();

    const adapter = operatorDevices.adapters.get('dev-1');
    operator.session.controlExpiresAt = Date.now() - 1;
    expect(() => adapter.send({ method: 'update', power: 1 }))
      .toThrow(expect.objectContaining({ code: 'CONTROL_EXPIRED' }));
    expect(operator.getStatus().devices).toEqual([]);

    operator._applyDeviceList(operator.session, {
      devices: [{ deviceId: 'dev-1', deviceType: 'CUNZHI01', data: {} }],
      limits: { voltage: 20, power: 128 },
      controlTtlSec: 3600,
      controlExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(operator.getStatus().devices).toEqual([]);

    await operator.stop();
    await owner.stop();
  });

  test('normalizes invalid limited values to zero', () => {
    const service = new RemoteProjectionService({
      devices: new FakeDevices(), api: createRoomApi(), ...timers(),
    });

    expect(service._clampMessage(
      { method: 'update', voltage: '12', power: 'invalid' },
      { voltage: 20, power: 128 },
    )).toEqual({ method: 'update', voltage: 12, power: 0 });
    expect(service._clampMessage(
      { method: 'update', voltage: NaN, power: Infinity },
      { voltage: 20, power: 128 },
    )).toEqual({ method: 'update', voltage: 0, power: 0 });
    expect(service._clampMessage(
      { method: 'update', shock: 1 },
      { voltage: 20, power: 128 },
    )).toEqual({ method: 'update', shock: 1, voltage: 0 });
  });

  test('safely stops when an active check discovers an expired owner session', async () => {
    const broker = new FakeBroker();
    const devices = new FakeDevices([{
      id: 'dev-1', name: 'Owner device', type: 'CUNZHI01', connected: true,
      connectionType: 'ble', controlConnection: 'ble',
      connections: [{ type: 'ble', connected: true }], data: {},
    }]);
    const owner = new RemoteProjectionService({
      devices, api: createRoomApi(), mqttConnect: broker.connect, ...timers(),
    });

    await owner.create({ token: 'owner' });
    devices.closed = [];
    owner.session.controlExpiresAt = Date.now() - 1;
    await owner._publishDeviceList(owner.session);

    expect(owner.getStatus().expired).toBe(true);
    expect(devices.closed).toEqual(['dev-1']);
    await owner.stop();
  });

  test('lets multiple operators control and stops only after all are offline', async () => {
    const broker = new FakeBroker();
    const api = createRoomApi();
    const ownerDevices = new FakeDevices([{
      id: 'dev-1', name: 'Owner device', type: 'CUNZHI01', connected: true,
      connectionType: 'ble', controlConnection: 'ble',
      connections: [{ type: 'ble', connected: true }], data: {},
    }]);
    const firstDevices = new FakeDevices();
    const secondDevices = new FakeDevices();
    const owner = new RemoteProjectionService({
      devices: ownerDevices, api, mqttConnect: broker.connect, ...timers(),
    });
    const first = new RemoteProjectionService({
      devices: firstDevices, api, mqttConnect: broker.connect, ...timers(),
    });
    const second = new RemoteProjectionService({
      devices: secondDevices, api, mqttConnect: broker.connect, ...timers(),
    });

    await owner.create({ token: 'owner' });
    await first.join({ token: 'operator-a', joinCode: 'JOIN123' });
    await second.join({ token: 'operator-b', joinCode: 'JOIN123' });
    await flush();
    expect(owner.getStatus().operatorCount).toBe(2);

    firstDevices.adapters.get('dev-1').send({ method: 'update', power: 10 });
    secondDevices.adapters.get('dev-1').send({ method: 'update', power: 20 });
    await flush();
    expect(ownerDevices.sent).toEqual(expect.arrayContaining([
      { id: 'dev-1', message: { method: 'update', power: 10 } },
      { id: 'dev-1', message: { method: 'update', power: 20 } },
    ]));

    ownerDevices.closed = [];
    await first.stop();
    await flush();
    expect(ownerDevices.closed).toEqual([]);

    await second.stop();
    await flush();
    expect(ownerDevices.closed).toContain('dev-1');
    await owner.stop();
  });

  test('ends the mqtt client when the initial connection fails', async () => {
    const api = createRoomApi();
    const client = new EventEmitter();
    client.options = {};
    client.end = jest.fn((_force, _opts, callback) => callback());
    const service = new RemoteProjectionService({
      devices: new FakeDevices(),
      api,
      mqttConnect: () => {
        queueMicrotask(() => client.emit('error', new Error('connect failed')));
        return client;
      },
      ...timers(),
    });

    await expect(service.join({ token: 'operator', joinCode: 'JOIN123' }))
      .rejects.toThrow('connect failed');

    expect(client.end).toHaveBeenCalledWith(true, {}, expect.any(Function));
    expect(api.leaveRoom).toHaveBeenCalledWith('operator', 'room-1');
  });

  test('closes a created room when activation or credential setup fails', async () => {
    const api = createRoomApi();
    api.getMqttCredential.mockRejectedValueOnce(new Error('credential failed'));
    const service = new RemoteProjectionService({
      devices: new FakeDevices(), api, ...timers(),
    });

    await expect(service.create({ token: 'owner' })).rejects.toThrow('credential failed');

    expect(api.closeRoom).toHaveBeenCalledWith('owner', 'room-1');
    expect(service.getStatus().active).toBe(false);
  });

  test('leaves a joined room when credential setup fails', async () => {
    const api = createRoomApi();
    api.getMqttCredential.mockRejectedValueOnce(new Error('credential failed'));
    const service = new RemoteProjectionService({
      devices: new FakeDevices(), api, ...timers(),
    });

    await expect(service.join({ token: 'operator', joinCode: 'JOIN123' }))
      .rejects.toThrow('credential failed');

    expect(api.leaveRoom).toHaveBeenCalledWith('operator', 'room-1');
    expect(service.getStatus().active).toBe(false);
  });
});
