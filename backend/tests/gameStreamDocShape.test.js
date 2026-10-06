// 画面流（SSE）的帧格式与状态文档形状：两端的进流首帧都必须是「本地 rev + 实时状态」，
// 之后每条 patch 都能 apply 到上一帧的 state 上，且结果与 getStatus() 同形。
// 这里直接调服务的 subscribeState / getStateEvent（路由只是把它们转成 SSE 文本）。
const { EventEmitter } = require('events');
const { RemoteGameService } = require('../services/remoteGameService');
const { GameHostService } = require('../game-runtime/gameHostService');
const patch = require('../public/game-state-patch');
const outputGuard = require('../services/remoteOutputGuard');

const guard = {
  ...outputGuard,
  createOutputWatchdog: (options) => outputGuard.createOutputWatchdog({
    ...options, setTimer: () => 1, clearTimer: () => {}, setRepeating: () => 2, clearRepeating: () => {},
  }),
};

function topicMatches(pattern, topic) {
  const expected = pattern.split('/');
  const actual = topic.split('/');
  return expected.length === actual.length && expected.every((part, i) => part === '+' || part === actual[i]);
}

class FakeBroker {
  constructor() { this.clients = new Set(); this.publishes = []; }
  connect = (_url, options) => {
    const client = new EventEmitter();
    client.options = { ...options };
    client.subscriptions = [];
    client.subscribe = (topics, _opts, callback) => { client.subscriptions.push(...topics); callback?.(null); };
    client.publish = (topic, payload, _opts, callback) => {
      this.publishes.push({ topic, payload: JSON.parse(String(payload)) });
      for (const subscriber of this.clients) {
        if (subscriber.subscriptions.some((pattern) => topicMatches(pattern, topic))) {
          queueMicrotask(() => subscriber.emit('message', topic, Buffer.from(payload)));
        }
      }
      callback?.(null);
    };
    client.end = (_force, _opts, callback) => { this.clients.delete(client); client.emit('close'); callback?.(); };
    this.clients.add(client);
    queueMicrotask(() => client.emit('connect'));
    return client;
  };
}

function fakeApi() {
  const room = { id: 'room-1', joinCode: 'JOIN123', hostUserId: 'owner', hostEpoch: 0 };
  return {
    getBaseUrl: () => 'http://room.test',
    createRoom: async () => room,
    joinRoom: async () => room,
    activateRoom: async () => null,
    heartbeat: async () => null,
    getMqttCredential: async (token) => ({
      brokerUrl: 'mqtt://room.test', roomId: room.id, userId: token, clientId: `client-${token}`,
      username: token, password: 'jwt', expiresAt: new Date(Date.now() + 600000).toISOString(),
    }),
    leaveRoom: async () => null,
    closeRoom: async () => null,
    getRoom: async () => ({ ...room, members: [] }),
    kickMember: async () => null,
  };
}

function fakeHost() {
  const listeners = new Set();
  const api = {
    status: { active: false, running: false, runtimeMode: null, snapshot: null },
    start: (input) => {
      api.status = {
        active: true, running: true, runtimeMode: 'host', sessionId: 'gs1', gameId: input.gameId,
        deviceMap: {}, snapshot: { running: true, phase: 'INITIAL_CALM', gameId: input.gameId, currentPressure: 1 },
      };
      return api.status;
    },
    stop: () => { api.status = { active: false, running: false, runtimeMode: null, snapshot: null }; return api.status; },
    getStatus: () => api.status,
    setParams: () => api.status,
    pause: () => api.status,
    resume: () => api.status,
    action: () => api.status,
    emitStatus() { for (const listener of listeners) listener(api.status); },
    subscribe(listener) { listeners.add(listener); listener(api.status); return () => listeners.delete(listener); },
  };
  return api;
}

// 可控时钟：画面流的 50ms 合并窗口、心跳等都走注入的定时器，测试手动到点
function fakeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return { id, ms }; },
    clearTimer(handle) { if (handle?.id) timers.delete(handle.id); },
    setRepeating: () => ({ id: ++seq }),
    clearRepeating: () => {},
    // 触发所有指定延迟的定时器（只用于画面流的 50ms 合并窗口）
    fire(ms) {
      const hits = [...timers.entries()].filter(([, item]) => item.ms === ms);
      for (const [id, item] of hits) { timers.delete(id); item.fn(); }
      return hits.length;
    },
  };
}

const flush = async () => { for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const GAMES = [{ id: 'surge-edging', runtimeMode: 'host', devices: [] }];

function makePair() {
  const broker = new FakeBroker();
  const host = fakeHost();
  const clock = fakeClock();
  const make = () => new RemoteGameService({
    host, api: fakeApi(), mqttConnect: broker.connect, listGames: () => GAMES, listDevices: () => [],
    outputGuard: guard, ...clock,
  });
  return { broker, host, clock, owner: make(), operator: make() };
}

// 按前端同一套规则回放帧序列：snapshot 直接换文档，patch 必须 baseRev 命中
function replay(frames) {
  let doc = frames[0].state;
  let rev = frames[0].rev;
  for (const frame of frames.slice(1)) {
    if (frame.type === 'snapshot') { doc = frame.state; rev = frame.rev; continue; }
    expect(frame.baseRev).toBe(rev);
    doc = patch.apply(doc, frame.ops);
    expect(doc).not.toBeNull();
    rev = frame.rev;
  }
  return doc;
}

describe('画面流状态文档形状', () => {
  test('被控端（owner）SSE：帧字段是 state，回放结果与 getStatus() 同形', async () => {
    const { broker, host, clock, owner, operator } = makePair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();

    const frames = [{ type: 'snapshot', ...owner.getStateEvent() }];
    owner.subscribeState((event) => frames.push(event));

    await operator.command({ type: 'game.start', payload: { gameId: 'surge-edging', deviceMap: {} } });
    await flush();
    clock.fire(50); // 合并窗口到点
    host.status = { ...host.status, snapshot: { ...host.status.snapshot, currentPressure: 9 } };
    host.emitStatus();
    await flush();
    clock.fire(50);

    expect(frames[0]).not.toHaveProperty('snapshot');
    expect(frames[0].state).toBeTruthy();
    expect(frames.some((frame) => frame.type === 'patch')).toBe(true);
    const doc = replay(frames);
    const truth = owner.getStatus();
    // 文档形状必须一致：字段集合与关键值都对得上
    expect(Object.keys(doc).sort()).toEqual(Object.keys(truth).sort());
    expect(doc.snapshot.currentPressure).toBe(9);
    expect(doc.authorized).toBe(true);
    expect(doc.role).toBe('owner');
  });

  test('被控端（owner）SSE：授权等非游戏变化也会推增量', async () => {
    const { broker, clock, owner, operator } = makePair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();

    const frames = [{ type: 'snapshot', ...owner.getStateEvent() }];
    owner.subscribeState((event) => frames.push(event));

    await owner.authorize();
    await flush();
    clock.fire(50);

    const doc = replay(frames);
    expect(doc.authorized).toBe(true);
    // 被控端文档没有 operatorUserId，授权对象在 operators / members 里
    expect(doc.operators.some((row) => row.userId === 'operator' && row.authorized)).toBe(true);
    expect(doc).toEqual(owner.getStatus());
  });

  test('主控端（operator）SSE：进流后收到授权与游戏快照的变化', async () => {
    const { broker, clock, owner, operator } = makePair();
    await owner.create({ token: 'owner' });
    await operator.join({ token: 'operator', joinCode: 'JOIN123' });
    await owner.authorize();
    await flush();
    clock.fire(50);

    const frames = [{ type: 'snapshot', ...operator.getStateEvent() }];
    operator.subscribeState((event) => frames.push(event));

    await operator.command({ type: 'game.start', payload: { gameId: 'surge-edging', deviceMap: {} } });
    await flush();
    clock.fire(50);

    expect(frames.length).toBeGreaterThan(1);
    const doc = replay(frames);
    expect(doc.snapshot.running).toBe(true);
    expect(doc.gameSessionId).toBe('gs1');
  });

  test('本机 HostRuntime 流：首帧是 /status 形状，patch 的路径指向 snapshot.*', () => {
    const devices = {
      rows: new Map([['s1', { id: 's1', type: 'QIYA' }], ['m1', { id: 'm1', type: 'TD01' }]]),
      handlers: [],
      getDeviceById(id) { return this.rows.get(id) || null; },
      onDeviceDataChange(handler) { this.handlers.push(handler); },
      invokeDeviceCapability() {},
      emit(event) { for (const handler of this.handlers) handler(event); },
    };
    const time = {
      timers: [],
      setTimer(fn, delay) { const handle = { fn, delay, cleared: false }; this.timers.push(handle); return handle; },
      clearTimer(handle) { if (handle) handle.cleared = true; },
      setRepeating(fn, delay) { const handle = { fn, delay, cleared: false }; this.timers.push(handle); return handle; },
      clearRepeating(handle) { if (handle) handle.cleared = true; },
    };
    const host = new GameHostService({
      devices,
      registry: { hasCapability: (type, key) => ({ QIYA: ['sphincterPressure', 'reporting'], TD01: ['strength'] }[type] || []).includes(key) },
      virtualDevices: { isVirtualDevice: () => false, interceptCommand: () => {} },
      now: () => 0,
      random: () => 0.5,
      setTimer: time.setTimer.bind(time), clearTimer: time.clearTimer.bind(time),
      setRepeating: time.setRepeating.bind(time), clearRepeating: time.clearRepeating.bind(time),
    });
    const fire = () => { for (const timer of time.timers) if (!timer.cleared && timer.delay === 50) { timer.cleared = true; timer.fn(); } };

    const frames = [{ type: 'snapshot', ...host.getStateEvent() }];
    host.subscribeState((event) => frames.push(event));
    host.start({ gameId: 'surge-edging', deviceMap: { sensor: ['s1'], motor: ['m1'] }, params: { duration: 10 } });
    fire();
    devices.emit({ deviceId: 's1', changes: { pressure: { new: 12.4 } }, nextData: { pressure: 12.4 } });
    fire();

    expect(frames[0]).not.toHaveProperty('snapshot');
    expect(frames[0].state.runtimeMode).toBeNull();
    const doc = replay(frames);
    expect(doc.snapshot.running).toBe(true);
    expect(doc.snapshot.currentPressure).toBe(12.4);
    expect(doc).toEqual(host.getStatus());
  });
});
