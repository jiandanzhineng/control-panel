const { EventEmitter } = require('events');
const { RemoteGameService } = require('../services/remoteGameService');

function topicMatches(pattern, topic) {
  const expected = pattern.split('/');
  const actual = topic.split('/');
  return expected.length === actual.length
    && expected.every((part, index) => part === '+' || part === actual[index]);
}

class FakeBroker {
  constructor() {
    this.clients = new Set();
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
    queueMicrotask(() => client.emit('connect'));
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
    })),
    leaveRoom: jest.fn(async () => null),
    closeRoom: jest.fn(async () => null),
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
        gameId: input.gameId,
        snapshot: { running: true, phase: 'INITIAL_CALM', gameId: input.gameId, params: input.params || {} },
      };
      return api.status;
    }),
    pause: jest.fn(() => api.status),
    resume: jest.fn(() => api.status),
    stop: jest.fn(() => ({ active: false, running: false, snapshot: { ended: true, phase: 'ENDED' } })),
    setParams: jest.fn((params) => {
      api.status.snapshot = { ...(api.status.snapshot || {}), params };
      return api.status;
    }),
    action: jest.fn(() => api.status),
    getStatus: jest.fn(() => api.status),
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

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function pair() {
  const broker = new FakeBroker();
  const api = createApi();
  const host = mockHost();
  const games = [{ id: 'surge-edging', title: '气压突变寸止', runtimeMode: 'host', params: [], devices: [] }];
  const devices = [{ id: 'dev-1', name: '气压', type: 'QIYA', capabilities: ['sphincterPressure'] }];
  const owner = new RemoteGameService({
    host, api, mqttConnect: broker.connect, listGames: () => games, listDevices: () => devices, ...timers(),
  });
  const operator = new RemoteGameService({
    host, api, mqttConnect: broker.connect, listGames: () => games, listDevices: () => devices, ...timers(),
  });
  return { broker, api, host, owner, operator };
}

function publish(broker, topic, envelope) {
  const sender = [...broker.clients][0];
  sender.publish(topic, JSON.stringify(envelope), {}, () => {});
}

describe('remote game service', () => {
  test('owner creates a remote-game room and operator receives a snapshot', async () => {
    const { api, owner, operator } = pair();
    const created = await owner.create({ token: 'owner' });
    expect(api.createRoom).toHaveBeenCalledWith('owner', 2, expect.objectContaining({ gameId: 'remote-game' }));
    expect(created.joinCode).toBe('JOIN123');
    expect(created.authorized).toBe(false);
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();
    expect(operator.getStatus().games).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'surge-edging' }),
    ]));
    expect(operator.getStatus().devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'dev-1' }),
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
    expect((await operator.command({ type: 'game.setParams', payload: { params: { duration: 6 } } })).ok).toBe(true);
    expect((await operator.command({ type: 'game.pause' })).ok).toBe(true);
    expect((await operator.command({ type: 'game.resume' })).ok).toBe(true);
    expect((await operator.command({ type: 'game.action', payload: { action: 'forceEdge', payload: {} } })).ok).toBe(true);
    expect((await operator.command({ type: 'game.stop' })).ok).toBe(true);
    expect(host.stop).toHaveBeenCalled();
  });

  test('duplicate message ids and stale sessions are ignored', async () => {
    const { broker, host, owner, operator } = pair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    const topic = 'rooms/room-1/commands/owner';
    const envelope = {
      protocolVersion: 1,
      roomSessionId: 'room-1:0',
      messageId: 'same-id',
      type: 'game.pause',
      senderConnectionEpoch: 'test',
      sequence: 1,
      timestamp: '2026-09-23T00:00:00.000Z',
      payload: {},
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
    const topic = 'rooms/room-1/commands/owner';
    const base = {
      protocolVersion: 1,
      roomSessionId: 'room-1:0',
      senderConnectionEpoch: 'operator-epoch',
      timestamp: '2026-09-23T00:00:00.000Z',
      payload: {},
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
    await flush();
    expect(operator.getStatus().devices).toHaveLength(1);
    await owner.stop({ reason: 'room-closed' });
    await flush();
    expect(operator.getStatus().active).toBe(false);
    expect(operator.getStatus().devices).toEqual([]);
    expect(operator.getStatus().authorized).toBe(false);
    expect([...broker.clients].some((client) => client.options.clientId === 'client-operator')).toBe(false);
  });
});
