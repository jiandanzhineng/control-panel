const { EventEmitter } = require('events');
const { RemoteGameService } = require('../services/remoteGameService');
const outputGuard = require('../services/remoteOutputGuard');
const { DEFAULT_REMOTE_LIMITS } = outputGuard;

// 看门狗用测试自己的定时器，避免真实 60s 定时器让 Jest 无法退出
function guardWith(timerFns) {
  return {
    ...outputGuard,
    createOutputWatchdog: (options) => outputGuard.createOutputWatchdog({ ...options, ...timerFns }),
  };
}

function topicMatches(pattern, topic) {
  const expected = pattern.split('/');
  const actual = topic.split('/');
  return expected.length === actual.length
    && expected.every((part, index) => part === '+' || part === actual[index]);
}

class FakeBroker {
  constructor() {
    this.clients = new Set();
    this.publishes = [];
    // 模拟真实 broker 的 ACL：拒绝的发布直接断线，回调永不触发
    this.deniedTopics = [];
  }

  connect = (_url, options) => {
    const client = new EventEmitter();
    client.options = { ...options };
    client.subscriptions = [];
    client.subscribe = (topics, _opts, callback) => {
      client.subscriptions.push(...topics);
      callback?.(null);
    };
    client.publish = (topic, payload, _options, callback) => {
      if (this.deniedTopics.includes(topic)) {
        // broker 以 reason 135 踢线：不发回调
        queueMicrotask(() => client.emit('close'));
        return;
      }
      this.publishes.push({ client, topic, payload: JSON.parse(String(payload)) });
      for (const subscriber of this.clients) {
        if (subscriber.subscriptions.some((pattern) => topicMatches(pattern, topic))) {
          queueMicrotask(() => subscriber.emit('message', topic, Buffer.from(payload)));
        }
      }
      callback?.(null);
    };
    client.end = (_force, _opts, callback) => {
      this.clients.delete(client);
      client.emit('close');
      callback?.();
    };
    this.clients.add(client);
    // 真实 broker 会保留 LWT（retain）的离线 presence；测试里可预置
    client.retained = this.retained || [];
    queueMicrotask(() => {
      client.emit('connect');
      for (const item of client.retained) client.emit('message', item.topic, Buffer.from(item.payload));
    });
    return client;
  };
}

function createApi() {
  const room = { id: 'room-1', joinCode: 'JOIN123', hostUserId: 'owner', hostEpoch: 0 };
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
      clientId: `client-${token}`,
      username: token,
      password: 'jwt',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    })),
    leaveRoom: jest.fn(async () => null),
    closeRoom: jest.fn(async () => null),
    getRoom: jest.fn(async () => ({ ...room, members: [] })),
    kickMember: jest.fn(async () => null),
  };
}

function mockHost() {
  const listeners = new Set();
  const api = {
    status: { active: false, running: false, snapshot: null },
    start: jest.fn((input) => {
      api.status = {
        active: true,
        running: true,
        sessionId: 'game-session-1',
        gameId: input.gameId,
        deviceMap: input.deviceMap || {},
        snapshot: { running: true, phase: 'INITIAL_CALM', gameId: input.gameId, params: input.params || {} },
      };
      return api.status;
    }),
    pause: jest.fn(() => api.status),
    resume: jest.fn(() => api.status),
    stop: jest.fn(() => {
      api.status = { active: false, running: false, snapshot: { ended: true, phase: 'ENDED' } };
      return api.status;
    }),
    setParams: jest.fn((params) => {
      api.status.snapshot = { ...(api.status.snapshot || {}), params };
      return api.status;
    }),
    action: jest.fn(() => api.status),
    getStatus: jest.fn(() => api.status),
    emitStatus() {
      for (const listener of listeners) listener(api.status);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return api;
}

function timers() {
  return {
    setTimer: () => ({ id: 1 }),
    clearTimer: () => {},
    setRepeating: () => ({ id: 2 }),
    clearRepeating: () => {},
  };
}

// 可控定时器：让测试能手动推进「宽限期 / 刷新 / 重连」而不真的等
function fakeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return { id, ms, unref() {} };
    },
    clearTimer(handle) {
      if (handle?.id) timers.delete(handle.id);
    },
    setRepeating: () => ({ id: ++seq }),
    clearRepeating: () => {},
    pending() {
      return [...timers.values()].map((item) => item.ms);
    },
    fire(ms) {
      const hits = [...timers.entries()].filter(([, item]) => item.ms === ms);
      for (const [id, item] of hits) {
        timers.delete(id);
        item.fn();
      }
      return hits.length;
    },
  };
}

async function flush() {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function pair({ games = [{ id: 'surge-edging', title: '气压突变寸止', runtimeMode: 'host', params: [], devices: [] }], devices = [{ id: 'dev-1', name: '气压', type: 'QIYA', capabilities: ['sphincterPressure'] }] } = {}) {
  const broker = new FakeBroker();
  const api = createApi();
  const host = mockHost();
  const timerFns = timers();
  const owner = new RemoteGameService({
    host, api, mqttConnect: broker.connect, listGames: () => games, listDevices: () => devices,
    outputGuard: guardWith(timerFns), ...timerFns,
  });
  const operator = new RemoteGameService({
    host, api, mqttConnect: broker.connect, listGames: () => games, listDevices: () => devices,
    outputGuard: guardWith(timerFns), ...timerFns,
  });
  return { broker, api, host, owner, operator };
}

// 带可控时钟的实例对：用于凭据刷新 / 重连 / 宽限期测试
function clockPair({ games = [{ id: 'surge-edging', runtimeMode: 'host', params: [], devices: [] }], devices = [], credentialTtlMs = 600000 } = {}) {
  const broker = new FakeBroker();
  const api = createApi();
  api.getMqttCredential = jest.fn(async (token) => ({
    brokerUrl: 'mqtt://room.test',
    roomId: 'room-1',
    userId: token,
    clientId: `client-${token}`,
    username: token,
    password: `jwt-${Math.random()}`,
    expiresAt: new Date(Date.now() + credentialTtlMs).toISOString(),
  }));
  const host = mockHost();
  const clock = fakeClock();
  const make = () => new RemoteGameService({
    host, api, mqttConnect: broker.connect, listGames: () => games, listDevices: () => devices,
    outputGuard: guardWith(clock), ...clock,
  });
  return { broker, api, host, clock, owner: make(), operator: make() };
}

function publish(broker, topic, envelope) {
  const sender = [...broker.clients][0];
  sender.publish(topic, JSON.stringify(envelope), {}, () => {});
}

describe('remote game service', () => {
  test('remote start rejects unsupported games and invalid required device mappings', async () => {
    const { host, owner, operator } = pair({
      games: [{ id: 'pressure-edging-v2', runtimeMode: 'host', devices: [
        { id: 'sensor', label: '气压传感器', required: true, capabilities: ['sphincterPressure', 'reporting'] },
        { id: 'motor', label: '刺激器', required: true, capabilities: ['strength'] },
      ] }],
      devices: [
        { id: 'sensor-1', connected: true, capabilities: ['sphincterPressure', 'reporting'] },
        { id: 'motor-1', connected: true, capabilities: ['strength'] },
        { id: 'offline', connected: false, capabilities: ['strength'] },
      ],
    });
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    const command = (gameId, deviceMap) => operator.command({ type: 'game.start', payload: { gameId, deviceMap, params: {} } });
    expect(await command('unknown', {})).toMatchObject({ ok: false, code: 'GAME_NOT_HOSTED' });
    expect(await command('pressure-edging-v2', { sensor: ['sensor-1'] })).toMatchObject({ ok: false, code: 'DEVICE_MAPPING_REQUIRED' });
    expect(await command('pressure-edging-v2', { sensor: ['sensor-1'], motor: ['offline'] })).toMatchObject({ ok: false, code: 'DEVICE_OFFLINE' });
    expect(await command('pressure-edging-v2', { sensor: ['motor-1'], motor: ['motor-1'] })).toMatchObject({ ok: false, code: 'DEVICE_CAPABILITY_MISMATCH' });
    expect(host.start).not.toHaveBeenCalled();
    expect(await command('pressure-edging-v2', { sensor: ['sensor-1'], motor: ['motor-1'] })).toMatchObject({ ok: true });
    expect(host.start).toHaveBeenCalledWith(expect.objectContaining({ gameId: 'pressure-edging-v2' }));
  });

  test('owner creates a remote-game room and operator receives a snapshot', async () => {
    const { api, owner, operator } = pair();
    const created = await owner.create({ token: 'owner' });
    expect(api.createRoom).toHaveBeenCalledWith('owner', 2, expect.objectContaining({ gameId: 'remote-game' }));
    expect(created.joinCode).toBe('JOIN123');
    expect(created.authorized).toBe(false);
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();
    // 未授权：目录可见，设备清单必须为空（最小状态）
    expect(operator.getStatus().games).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'surge-edging' }),
    ]));
    expect(operator.getStatus().devices).toEqual([]);
    await owner.authorize();
    await flush();
    expect(operator.getStatus().devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'dev-1' }),
    ]));
  });

  test('operator publishes under its own credential topic and owner subscribes wildcard', async () => {
    const { broker, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    await operator.command({ type: 'game.pause' });
    const ownerClient = [...broker.clients].find((client) => client.options.clientId === 'client-owner');
    expect(ownerClient.subscriptions).toContain('rooms/room-1/commands/+');
    expect(broker.publishes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        topic: 'rooms/room-1/commands/operator',
        payload: expect.objectContaining({ type: 'game.pause' }),
      }),
    ]));
  });

  test('unauthorized game commands return CONTROL_NOT_AUTHORIZED', async () => {
    const { host, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();
    const denied = await operator.command({ type: 'game.start', payload: { gameId: 'surge-edging' } });
    expect(denied).toMatchObject({ ok: false, code: 'CONTROL_NOT_AUTHORIZED' });
    expect(host.start).not.toHaveBeenCalled();
    const allowed = await operator.command({ type: 'client.snapshot.request' });
    expect(allowed.ok).toBe(true);
  });

  test('authorized operator can start, edit, pause, resume, stop and act', async () => {
    const { host, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    expect(operator.getStatus().authorized).toBe(true);
    expect((await operator.command({
      type: 'game.start',
      payload: { gameId: 'surge-edging', deviceMap: { sensor: ['dev-1'] }, params: { duration: 5 } },
    })).ok).toBe(true);
    expect(host.start).toHaveBeenCalledWith(expect.objectContaining({ gameId: 'surge-edging', source: 'remote' }));
    const session = { gameSessionId: 'game-session-1' };
    expect((await operator.command({ type: 'game.setParams', payload: { params: { duration: 6 }, ...session } })).ok).toBe(true);
    expect((await operator.command({ type: 'game.pause', payload: { ...session } })).ok).toBe(true);
    expect((await operator.command({ type: 'game.resume', payload: { ...session } })).ok).toBe(true);
    expect((await operator.command({ type: 'game.action', payload: { action: 'forceEdge', payload: {}, ...session } })).ok).toBe(true);
    expect((await operator.command({ type: 'game.stop', payload: { ...session } })).ok).toBe(true);
    expect(host.stop).toHaveBeenCalled();
  });

  test('remote device commands use device service and protect mapped running devices', async () => {
    const { host, owner, operator } = pair();
    const device = {
      id: 'dev-1', name: '刺激器', type: 'TD01', connected: true,
      controlConnection: 'mqtt', connections: [{ type: 'mqtt' }], capabilities: ['strength'],
    };
    host.devices = {
      listDevicesForApi: jest.fn(() => [device]),
      getDeviceForApi: jest.fn((id) => (id === device.id ? device : null)),
      updateDeviceMeta: jest.fn((_id, patch) => ({ ...device, ...patch })),
      invokeDeviceCapabilityAndWait: jest.fn(async () => ({ ok: true })),
      stopExecutionDeviceAndWait: jest.fn(async () => ({ ok: true })),
      disconnectDeviceConnections: jest.fn(async () => true),
    };
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    expect((await operator.command({
      type: 'devices.rename', payload: { deviceId: 'dev-1', name: '新名称' },
    })).ok).toBe(true);
    expect(host.devices.updateDeviceMeta).toHaveBeenCalledWith('dev-1', { name: '新名称' });
    await operator.command({
      type: 'game.start',
      payload: { gameId: 'surge-edging', deviceMap: { sensor: ['dev-1'] } },
    });
    expect(await operator.command({
      type: 'devices.invoke',
      payload: { deviceId: 'dev-1', capability: 'strength', action: 'set', input: { value: 30 } },
    })).toMatchObject({ ok: false, code: 'DEVICE_BUSY' });
    expect((await operator.command({ type: 'devices.stop', payload: { deviceId: 'dev-1' } })).ok).toBe(true);
    expect(host.stop).toHaveBeenCalledWith({ reason: 'remote-device-stop' });
    expect(host.devices.stopExecutionDeviceAndWait).toHaveBeenCalledWith('dev-1');
    expect((await operator.command({
      type: 'devices.invoke',
      payload: { deviceId: 'dev-1', capability: 'strength', action: 'set', input: { value: 30 } },
    })).ok).toBe(true);
    // 远程调用必须经安全层：数值被钳制，未知字段被拒绝
    expect(host.devices.invokeDeviceCapabilityAndWait).toHaveBeenCalledWith(
      'dev-1', 'strength', 'set', { value: 30 },
    );
    // 超上限的数值必须被安全层钳制
    expect((await operator.command({
      type: 'devices.invoke',
      payload: { deviceId: 'dev-1', capability: 'strength', action: 'set', input: { value: 999 } },
    })).ok).toBe(true);
    expect(host.devices.invokeDeviceCapabilityAndWait).toHaveBeenLastCalledWith(
      'dev-1', 'strength', 'set', { value: DEFAULT_REMOTE_LIMITS.power },
    );
    // mqtt 连接无法保持断开，如实返回不支持，不谎报成功
    expect(await operator.command({ type: 'devices.disconnect', payload: { deviceId: 'dev-1' } }))
      .toMatchObject({ ok: false, code: 'DEVICE_ACTION_UNSUPPORTED' });
    expect(host.devices.disconnectDeviceConnections).not.toHaveBeenCalled();
  });

  test('remote invoke rejects unsupported capabilities and remote-projected devices', async () => {
    const { host, owner, operator } = pair();
    const local = {
      id: 'dev-1', name: '刺激器', type: 'TD01', connected: true,
      controlConnection: 'mqtt', connections: [{ type: 'mqtt' }], capabilities: ['strength'],
    };
    const projected = {
      id: 'dev-2', name: '别人的设备', type: 'TD01', connected: true,
      controlConnection: 'remote', connections: [{ type: 'remote' }], capabilities: ['strength'],
    };
    host.devices = {
      listDevicesForApi: jest.fn(() => [local, projected]),
      getDeviceForApi: jest.fn((id) => [local, projected].find((item) => item.id === id) || null),
      invokeDeviceCapabilityAndWait: jest.fn(async () => ({ ok: true })),
      stopExecutionDeviceAndWait: jest.fn(async () => ({ ok: true })),
      disconnectDeviceConnections: jest.fn(async () => true),
    };
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    // 投影来的设备不出现在远程游戏设备清单里
    expect(owner.getStatus().devices.map((item) => item.id)).toEqual(['dev-1']);
    expect(await operator.command({
      type: 'devices.invoke',
      payload: { deviceId: 'dev-2', capability: 'strength', action: 'set', input: { value: 10 } },
    })).toMatchObject({ ok: false, code: 'DEVICE_ACTION_UNSUPPORTED' });
    expect(await operator.command({
      type: 'devices.invoke',
      payload: { deviceId: 'dev-1', capability: 'shock', action: 'start', input: { voltage: 10 } },
    })).toMatchObject({ ok: false, code: 'REMOTE_OUTPUT_REJECTED' });
    expect(host.devices.invokeDeviceCapabilityAndWait).not.toHaveBeenCalled();
  });

  test('revoking or kicking an operator stops its latched manual output but keeps the game', async () => {
    const { host, owner, operator } = pair();
    const device = {
      id: 'dev-1', name: '刺激器', type: 'TD01', connected: true,
      controlConnection: 'mqtt', connections: [{ type: 'mqtt' }], capabilities: ['strength'],
    };
    host.devices = {
      listDevicesForApi: jest.fn(() => [device]),
      getDeviceForApi: jest.fn((id) => (id === device.id ? device : null)),
      invokeDeviceCapabilityAndWait: jest.fn(async () => ({ ok: true })),
      stopExecutionDeviceAndWait: jest.fn(async () => ({ ok: true })),
      disconnectDeviceConnections: jest.fn(async () => true),
    };
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    await operator.command({ type: 'game.start', payload: { gameId: 'surge-edging', deviceMap: {} } });
    // 操作方手动开一个电机（锁存 60s）：watchdog 登记该设备
    expect((await operator.command({
      type: 'devices.invoke',
      payload: { deviceId: 'dev-1', capability: 'strength', action: 'set', input: { value: 30 } },
    })).ok).toBe(true);
    await owner.revoke();
    await flush();
    // 撤权必须真的对每台被写过的设备下发停止（含品牌/普通设备各自的 close 帧）
    expect(host.devices.stopExecutionDeviceAndWait).toHaveBeenCalledWith('dev-1');
    // 运行中的游戏不受撤权影响
    expect(host.stop).not.toHaveBeenCalled();
  });

  test('stale gameSessionId is rejected; missing one is accepted for legacy clients', async () => {
    const { host, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    await operator.command({
      type: 'game.start',
      payload: { gameId: 'surge-edging', deviceMap: { sensor: ['dev-1'] } },
    });
    expect(await operator.command({ type: 'game.pause', payload: { gameSessionId: 'old-session' } }))
      .toMatchObject({ ok: false, code: 'STALE_GAME_SESSION' });
    expect(await operator.command({ type: 'game.stop', payload: { gameSessionId: 'old-session' } }))
      .toMatchObject({ ok: false, code: 'STALE_GAME_SESSION' });
    expect(host.pause).not.toHaveBeenCalled();
    expect((await operator.command({ type: 'game.pause', payload: {} })).ok).toBe(true);
    expect(host.pause).toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
    expect(operator.getStatus().gameSessionId).toBe('game-session-1');
    expect((await operator.command({
      type: 'game.stop', payload: { gameSessionId: 'game-session-1' },
    })).ok).toBe(true);
    expect(host.stop).toHaveBeenCalledWith({ reason: 'remote-stop' });
  });

  test('owner executes a local command and publishes the refreshed snapshots', async () => {
    const { broker, owner } = pair();
    await owner.create({ token: 'owner' });
    const result = await owner.command({ type: 'devices.list' });
    expect(result).toMatchObject({ ok: true, result: { devices: [expect.objectContaining({ id: 'dev-1' })] } });
    expect(broker.publishes.filter((item) => item.payload.type === 'client.snapshot').length).toBeGreaterThan(1);
  });

  test('duplicate message ids and stale sessions are ignored', async () => {
    const { broker, host, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    await operator.command({
      type: 'game.start',
      payload: { gameId: 'surge-edging', deviceMap: { sensor: ['dev-1'] } },
    });
    const topic = 'rooms/room-1/commands/operator';
    const envelope = {
      protocolVersion: 1,
      roomSessionId: 'room-1:0',
      messageId: 'same-id',
      type: 'game.pause',
      senderConnectionEpoch: 'test',
      sequence: 1,
      timestamp: '2026-09-23T00:00:00.000Z',
      payload: { gameSessionId: 'game-session-1' },
    };
    publish(broker, topic, envelope);
    publish(broker, topic, envelope);
    publish(broker, topic, { ...envelope, messageId: 'stale', roomSessionId: 'room-1:9' });
    await flush();
    expect(host.pause).toHaveBeenCalledTimes(1);
  });

  test('older sequence envelopes are ignored even with a new message id', async () => {
    const { broker, host, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    await operator.command({
      type: 'game.start',
      payload: { gameId: 'surge-edging', deviceMap: { sensor: ['dev-1'] } },
    });
    const topic = 'rooms/room-1/commands/operator';
    const base = {
      protocolVersion: 1,
      roomSessionId: 'room-1:0',
      senderConnectionEpoch: 'operator-epoch',
      timestamp: '2026-09-23T00:00:00.000Z',
      payload: { gameSessionId: 'game-session-1' },
      type: 'game.pause',
    };
    publish(broker, topic, { ...base, messageId: 'seq-2', sequence: 2 });
    publish(broker, topic, { ...base, messageId: 'seq-1', sequence: 1 });
    await flush();
    expect(host.pause).toHaveBeenCalledTimes(1);
  });

  test('operator mqtt close does not stop the host runtime', async () => {
    const { broker, host, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await operator.command({ type: 'game.start', payload: { gameId: 'surge-edging' } });
    const calls = host.stop.mock.calls.length;
    const operatorClient = [...broker.clients].find((client) => client.options.clientId === 'client-operator');
    operatorClient.emit('close');
    await flush();
    expect(host.stop).toHaveBeenCalledTimes(calls);
    expect(owner.getStatus().active).toBe(true);
  });

  test('revoke blocks further control and tells the operator', async () => {
    const { host, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    await owner.revoke();
    await flush();
    expect(operator.getStatus().authorized).toBe(false);
    const denied = await operator.command({ type: 'game.pause' });
    expect(denied.code).toBe('CONTROL_NOT_AUTHORIZED');
    expect(host.pause).not.toHaveBeenCalled();
  });

  test('closing the room revokes the operator and clears remote device state', async () => {
    const { broker, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    expect(operator.getStatus().devices).toHaveLength(1);
    await owner.stop({ reason: 'room-closed' });
    await flush();
    expect(operator.getStatus().active).toBe(false);
    expect(operator.getStatus().devices).toEqual([]);
    expect(operator.getStatus().authorized).toBe(false);
    expect([...broker.clients].some((client) => client.options.clientId === 'client-operator')).toBe(false);
  });

  test('operator stop() never publishes session.revoked to events (ACL denied) and always settles', async () => {
    const { broker, api, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();
    // 模拟真实 ACL：操作方发 events 会被 broker 踢线且回调永不触发
    broker.deniedTopics.push('rooms/room-1/events');
    const stopped = await operator.stop({ reason: 'user-leave' });
    expect(stopped.active).toBe(false);
    expect(api.leaveRoom).toHaveBeenCalledWith('operator', 'room-1');
    // stop 之后必须还能再次 join（不会被上一次 stop 挂住）
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    expect(operator.getStatus().active).toBe(true);
  });

  test('operator tolerates host presence offline for a grace period and recovers', async () => {
    const { broker, api, host, clock, owner, operator } = clockPair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();
    const presenceTopic = 'rooms/room-1/presence/owner';
    const offline = JSON.stringify({
      protocolVersion: 1, roomSessionId: 'room-1:0', messageId: 'p-off', type: 'client.presence',
      senderConnectionEpoch: 'e1', sequence: 1, timestamp: '2026-10-06T00:00:00.000Z',
      payload: { status: 'offline' },
    });
    const sender = [...broker.clients][0];
    sender.publish(presenceTopic, offline, {}, () => {});
    await flush();
    // 宽限期内：会话仍然存在（等待房主），不拆除
    expect(operator.getStatus().active).toBe(true);
    expect(operator.getStatus().waitingForHost).toBe(true);
    expect(clock.pending()).toContain(60000);
    // 房主回来：恢复
    const online = JSON.stringify({
      protocolVersion: 1, roomSessionId: 'room-1:0', messageId: 'p-on', type: 'client.presence',
      senderConnectionEpoch: 'e1', sequence: 2, timestamp: '2026-10-06T00:00:01.000Z',
      payload: { status: 'online' },
    });
    sender.publish(presenceTopic, online, {}, () => {});
    await flush();
    expect(operator.getStatus().waitingForHost).toBe(false);
    expect(operator.getStatus().active).toBe(true);
  });

  test('operator tears down only after the host-offline grace period expires', async () => {
    const { broker, clock, owner, operator } = clockPair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();
    const sender = [...broker.clients][0];
    sender.publish('rooms/room-1/presence/owner', JSON.stringify({
      protocolVersion: 1, roomSessionId: 'room-1:0', messageId: 'p-off', type: 'client.presence',
      senderConnectionEpoch: 'e1', sequence: 1, timestamp: '2026-10-06T00:00:00.000Z',
      payload: { status: 'offline' },
    }), {}, () => {});
    await flush();
    expect(operator.getStatus().active).toBe(true);
    clock.fire(60000);
    await flush();
    expect(operator.getStatus().active).toBe(false);
  });

  test('join settles when the host presence is a retained offline', async () => {
    const { broker, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    // 预置 retained 的房主离线 presence（上次会话遗留）
    broker.retained = [{
      topic: 'rooms/room-1/presence/owner',
      payload: JSON.stringify({
        protocolVersion: 1, roomSessionId: 'room-1:0', messageId: 'retained-off',
        type: 'client.presence', senderConnectionEpoch: 'old', sequence: 1,
        timestamp: '2026-10-06T00:00:00.000Z', payload: { status: 'offline' },
      }),
    }];
    const status = await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    expect(status.active).toBe(true);
    expect(status.waitingForHost).toBe(true);
    expect(operator.getStatus().active).toBe(true);
  });

  test('credential refresh reconnects with fresh credentials without ending the session', async () => {
    const { api, host, clock, owner, operator } = clockPair({ credentialTtlMs: 600000 });
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    await operator.command({ type: 'game.start', payload: { gameId: 'surge-edging', deviceMap: {} } });
    const before = api.getMqttCredential.mock.calls.length;
    // 提前 2 分钟触发刷新
    const refreshDelay = clock.pending().find((ms) => ms > 400000 && ms <= 480000);
    expect(refreshDelay).toBeGreaterThan(0);
    clock.fire(refreshDelay);
    await flush();
    expect(api.getMqttCredential.mock.calls.length).toBeGreaterThan(before);
    expect(operator.getStatus().active).toBe(true);
    expect(operator.getStatus().connected).toBe(true);
    expect(host.stop).not.toHaveBeenCalled();
  });

  test('unexpected close reconnects with a fresh credential and keeps the session', async () => {
    const { broker, api, host, clock, owner, operator } = clockPair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    await operator.command({ type: 'game.start', payload: { gameId: 'surge-edging', deviceMap: {} } });
    const before = api.getMqttCredential.mock.calls.length;
    const operatorClient = [...broker.clients].find((client) => client.options.clientId === 'client-operator');
    operatorClient.emit('close');
    await flush();
    expect(clock.pending()).toContain(1000);
    clock.fire(1000);
    await flush();
    expect(api.getMqttCredential.mock.calls.length).toBeGreaterThan(before);
    expect(operator.getStatus().active).toBe(true);
    expect(operator.getStatus().connected).toBe(true);
    expect(host.stop).not.toHaveBeenCalled();
  });

  test('owner never drops the ended snapshot to the 5Hz throttle', async () => {
    const { broker, host, owner } = pair();
    await owner.create({ token: 'owner' });
    const before = broker.publishes.filter((item) => item.payload.type === 'game.snapshot').length;
    host.status = {
      active: false, running: false, ended: true,
      snapshot: { running: false, ended: true, phase: 'ENDED', endReason: 'remote-stop' },
    };
    host.emitStatus?.();
    await flush();
    const after = broker.publishes.filter((item) => item.payload.type === 'game.snapshot');
    expect(after.length).toBeGreaterThan(before);
    expect(after[after.length - 1].payload.payload.ended).toBe(true);
  });

  test('kick revokes the member locally and rejects its commands', async () => {
    const { api, broker, host, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    expect((await owner.kick({ userId: 'operator' })).active).toBe(true);
    expect(api.kickMember).toHaveBeenCalledWith('owner', 'room-1', 'operator');
    const denied = await operator.command({ type: 'game.pause' });
    expect(denied.code).toBe('CONTROL_NOT_AUTHORIZED');
    expect(host.pause).not.toHaveBeenCalled();
    expect(owner.getStatus().operators).toEqual([]);
  });

  test('re-authorizing after a kick never binds to the kicked member', async () => {
    const { owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    await owner.kick({ userId: 'operator' });
    // 被踢者仍连着 MQTT，重发 presence 也不能被重新选中
    await operator._publishPresence(operator.session, 'online');
    await flush();
    await expect(owner.authorize()).rejects.toMatchObject({ code: 'NO_OPERATOR' });
    expect(owner.getStatus()).toMatchObject({ authorized: false });
    expect(owner.session.authorizedUserId).toBeNull();
  });

  test('a different member does not inherit the authorization', async () => {
    const { broker, host, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    await operator.command({ type: 'game.pause', payload: { gameSessionId: 'x' } });
    // 另一个 userId 用同房间发命令：授权不继承
    const envelope = {
      protocolVersion: 1, roomSessionId: 'room-1:0', messageId: 'other-1', type: 'game.pause',
      senderConnectionEpoch: 'other', sequence: 1, timestamp: '2026-10-06T00:00:00.000Z', payload: {},
    };
    const sender = [...broker.clients][0];
    sender.publish('rooms/room-1/commands/intruder', JSON.stringify(envelope), {}, () => {});
    await flush();
    expect(host.pause).not.toHaveBeenCalled();
  });

  test('owner list never includes devices projected from another client', async () => {
    const devices = [
      { id: 'local-1', name: '本地', type: 'TD01', connected: true, controlConnection: 'mqtt', connections: [{ type: 'mqtt' }] },
      { id: 'remote-1', name: '投影', type: 'TD01', connected: true, controlConnection: 'remote', connections: [{ type: 'remote' }] },
    ];
    const { owner } = pair({ devices });
    await owner.create({ token: 'owner' });
    expect(owner.getStatus().devices.map((item) => item.id)).toEqual(['local-1']);
  });

  test('operator sends nothing to events and only publishes on its own commands topic', async () => {
    const { broker, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    await operator.command({ type: 'game.pause', payload: {} });
    const operatorTopics = broker.publishes
      .filter((item) => item.client?.options?.clientId === 'client-operator')
      .map((item) => item.topic);
    expect(operatorTopics.length).toBeGreaterThan(0);
    for (const topic of operatorTopics) {
      // 操作方只允许发自己的 commands topic 与自己的 presence（retain）
      expect(['rooms/room-1/commands/operator', 'rooms/room-1/presence/operator']).toContain(topic);
    }
    expect(operatorTopics).not.toContain('rooms/room-1/events');
  });

  test('senderConnectionEpoch never leaks the MQTT clientId', async () => {
    const { broker, owner } = pair();
    await owner.create({ token: 'owner' });
    const envelopes = broker.publishes.map((item) => item.payload);
    expect(envelopes.length).toBeGreaterThan(0);
    for (const envelope of envelopes) {
      expect(envelope.senderConnectionEpoch).toBeTruthy();
      expect(envelope.senderConnectionEpoch).not.toContain('client-owner');
    }
  });
});
