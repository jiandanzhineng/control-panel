const { GameHostService } = require('../game-runtime/gameHostService');
const coreResolver = require('../game-runtime/gameCoreResolver');
const playCarrierBus = require('../services/playCarrierBus');

function fakeDevices(rows) {
  return {
    rows: new Map(rows.map((row) => [row.id, row])),
    calls: [],
    handlers: [],
    rawHandlers: [],
    getDeviceById(id) { return this.rows.get(id) || null; },
    onDeviceDataChange(handler) { this.handlers.push(handler); },
    onDeviceRawMessage(handler) { this.rawHandlers.push(handler); },
    invokeDeviceCapability(id, capability, action, input) {
      this.calls.push({ id, capability, action, input });
    },
    // 看门狗兜底停机（远程锁存输出到点）
    stopExecutionDeviceAndWait(id) {
      this.calls.push({ id, stopped: true });
      return Promise.resolve({ ok: true });
    },
    emit(event) { for (const handler of this.handlers) handler(event); },
    emitRaw(event) { for (const handler of this.rawHandlers) handler(event); },
  };
}

function fakeVirtual() {
  return {
    calls: [],
    isVirtualDevice: (id) => String(id).startsWith('vb_'),
    interceptCommand(id, cmd) { this.calls.push({ id, cmd }); },
  };
}

function registryFor(map) {
  return {
    hasCapability(type, key) { return (map[type] || []).includes(key); },
  };
}

function clock() {
  return {
    timers: [],
    intervals: [],
    setTimer(fn, delay) {
      const handle = { fn, delay, cleared: false };
      this.timers.push(handle);
      return handle;
    },
    clearTimer(handle) { if (handle) handle.cleared = true; },
    setRepeating(fn, delay) {
      const handle = { fn, delay, cleared: false };
      this.intervals.push(handle);
      return handle;
    },
    clearRepeating(handle) { if (handle) handle.cleared = true; },
  };
}

const CAPS = {
  QIYA: ['sphincterPressure', 'reporting'],
  TD01: ['strength'],
  DIANJI: ['shock'],
  LOCK: ['lock'],
  ZIDONGSUO: ['lock', 'buttonInput'],
};

function createHost(devices, extra = {}) {
  const time = clock();
  let now = 0;
  const host = new GameHostService({
    devices,
    registry: registryFor(CAPS),
    virtualDevices: extra.virtualDevices || fakeVirtual(),
    now: () => now,
    random: () => 0.5,
    setTimer: time.setTimer.bind(time),
    clearTimer: time.clearTimer.bind(time),
    setRepeating: time.setRepeating.bind(time),
    clearRepeating: time.clearRepeating.bind(time),
    ...(extra.outputLogHook ? { outputLogHook: extra.outputLogHook } : {}),
    ...(extra.outputLimitsProvider ? { outputLimitsProvider: extra.outputLimitsProvider } : {}),
  });
  return {
    host,
    time,
    setNow(value) { now = value; },
  };
}

const baseDevices = () => fakeDevices([
  { id: 's1', type: 'QIYA' },
  { id: 'm1', type: 'TD01' },
  { id: 'm2', type: 'TD01' },
  { id: 'p1', type: 'DIANJI' },
  { id: 'lock1', type: 'LOCK' },
]);

describe('game host runtime', () => {
  test('only one session exists and a new game resets the previous devices', () => {
    const devices = baseDevices();
    const { host, time } = createHost(devices);
    const first = host.start({
      gameId: 'surge-edging',
      deviceMap: { sensor: ['s1'], motor: ['m1'] },
      params: { duration: 10 },
    });
    expect(first.runtimeMode).toBe('host');
    expect(time.intervals[0].delay).toBeGreaterThanOrEqual(50);
    expect(time.intervals[0].delay).toBeLessThanOrEqual(100);
    const second = host.start({
      gameId: 'surge-edging',
      deviceMap: { sensor: ['s1'], motor: ['m2'] },
      params: { duration: 10 },
    });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(host.getStatus().sessionId).toBe(second.sessionId);
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'm1', capability: 'strength', action: 'stop' }),
    ]));
  });

  test('params stay on the current session and a missing device is not invoked', () => {
    const devices = baseDevices();
    const { host } = createHost(devices);
    host.start({
      gameId: 'surge-edging',
      deviceMap: { motor: ['missing'], sensor: ['s1'] },
      params: { duration: 5 },
    });
    expect(devices.calls.some((call) => call.id === 'missing')).toBe(false);
    host.setParams({ duration: 8, surgeRiseKpa: 1.2 });
    expect(host.getStatus().snapshot.params.duration).toBe(8);
    expect(host.getStatus().snapshot.params.surgeRiseKpa).toBe(1.2);
    expect(host.getStatus().errors.length).toBeGreaterThan(0);
  });

  test('effects follow role mapping and skip unsupported capabilities', () => {
    const devices = baseDevices();
    const virtual = fakeVirtual();
    const { host, setNow } = createHost(devices, { virtualDevices: virtual });
    devices.rows.set('vb_m1', { id: 'vb_m1', type: 'TD01' });
    host.start({
      gameId: 'surge-edging',
      deviceMap: { sensor: ['s1'], motor: ['vb_m1', 'm1'], punish: ['m1'] },
      params: { duration: 10, minSurgeMs: 100, surgeWindowMs: 500, shockVoltage: 20, shockDuration: 3 },
    });
    for (let i = 0; i < 12; i += 1) {
      setNow(i * 100);
      host.pushSensor({ value: 10, nowMs: i * 100 });
    }
    host.pushSensor({ value: 13.5, nowMs: 1200 });
    setNow(1300);
    host.pushSensor({ value: 13.5, nowMs: 1300 });
    setNow(1400);
    host.pushSensor({ value: 13.6, nowMs: 1400 }); // 与原版一致：进入边缘期的下一次计算才归零
    expect(virtual.calls.some((call) => call.id === 'vb_m1' && call.cmd.capability === 'strength')).toBe(true);
    expect(devices.calls.some((call) => call.id === 'm1' && call.capability === 'strength' && call.action === 'stop')).toBe(true);
    expect(devices.calls.some((call) => call.id === 'm1' && call.capability === 'shock')).toBe(false);
    expect(host.getStatus().errors.some((error) => error.message.includes('shock'))).toBe(true);
  });

  test('shock stops itself and pause, stop and natural end reset outputs', () => {
    const devices = baseDevices();
    const { host, time, setNow } = createHost(devices);
    host.start({
      gameId: 'surge-edging',
      deviceMap: { sensor: ['s1'], motor: ['m1'], punish: ['p1'], lock: ['lock1'] },
      params: { duration: 1, endCalmLock: 0, minSurgeMs: 100, surgeWindowMs: 500, shockDuration: 3, lowPressureDelay: 2 },
    });
    for (let i = 0; i < 12; i += 1) host.pushSensor({ value: 10, nowMs: i * 100 });
    host.pushSensor({ value: 13.5, nowMs: 1200 });
    host.pushSensor({ value: 13.5, nowMs: 1300 });
    const shockTimer = time.timers.find((timer) => timer.delay === 3000 && !timer.cleared);
    expect(shockTimer).toBeTruthy();
    shockTimer.fn();
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'p1', capability: 'shock', action: 'stop' }),
    ]));

    devices.calls.length = 0;
    host.pause();
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'm1', capability: 'strength', action: 'stop' }),
    ]));

    devices.calls.length = 0;
    host.stop({ reason: 'user' });
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'm1', capability: 'strength', action: 'stop' }),
      expect.objectContaining({ id: 'p1', capability: 'shock', action: 'stop' }),
      expect.objectContaining({ id: 'lock1', capability: 'lock', action: 'setOpen', input: { open: true } }),
    ]));

    devices.calls.length = 0;
    setNow(0);
    host.start({
      gameId: 'surge-edging',
      deviceMap: { sensor: ['s1'], motor: ['m1'], punish: ['p1'] },
      params: { duration: 1 },
    });
    setNow(60000);
    const ended = host.tick(60000);
    expect(ended.snapshot.ended).toBe(true);
    expect(ended.running).toBe(false);
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'm1', capability: 'strength', action: 'stop' }),
      expect.objectContaining({ id: 'p1', capability: 'shock', action: 'stop' }),
    ]));
  });

  test('device data changes are accepted only from mapped sensors', () => {
    const devices = baseDevices();
    const { host } = createHost(devices);
    host.start({
      gameId: 'surge-edging',
      deviceMap: { sensor: ['s1'], motor: ['m1'] },
      params: { duration: 10 },
    });
    devices.emit({ deviceId: 'm1', changes: { pressure: { new: 30 } }, nextData: { pressure: 30 } });
    expect(host.getStatus().snapshot.currentPressure).toBe(0);
    devices.emit({ deviceId: 's1', changes: { pressure: { new: 12.4 } }, nextData: { pressure: 12.4 } });
    expect(host.getStatus().snapshot.currentPressure).toBe(12.4);
  });

  test('dropping a subscriber does not stop the runtime and a new subscriber gets the snapshot', () => {
    const devices = baseDevices();
    const { host, setNow } = createHost(devices);
    host.start({
      gameId: 'surge-edging',
      deviceMap: { sensor: ['s1'], motor: ['m1'] },
      params: { duration: 10 },
    });
    const unsubscribe = host.subscribe(() => {});
    unsubscribe();
    setNow(4000);
    host.tick(4000);
    expect(host.getStatus().running).toBe(true);
    expect(host.getStatus().snapshot.phase).toBe('INITIAL_CALM');
    let seen = null;
    host.subscribe((status) => { seen = status; });
    expect(seen.snapshot.gameId).toBe('surge-edging');
    expect(seen.snapshot.running).toBe(true);
    expect(seen.snapshot.params.duration).toBe(10);
  });

  test('start seeds the current sensor reading like the original page readValue', () => {
    const devices = fakeDevices([
      { id: 's1', type: 'QIYA', data: { pressure: 18.4 } },
      { id: 'm1', type: 'TD01' },
    ]);
    const { host } = createHost(devices);
    host.start({ gameId: 'pressure-edging-v2', deviceMap: { sensor: ['s1'], motor: ['m1'] }, params: { duration: 10 } });
    expect(host.getStatus().snapshot.currentPressure).toBe(18.4);
  });
});

// 通用设备事件（契约第 3 节）：manifest 声明 events:'v2' 的游戏收 device-property / device-event，
// 内置核心（未声明）保持 legacy 通道，行为与接线前逐字一致。
describe('host runtime device events (events:v2)', () => {
  // 事件开关只在游戏包声明；测试用一个假 core 观察 enqueue 到的事件
  const V2_PKG = { id: 'v2-game', manifest: { id: 'v2-game', runtime: 'host', events: 'v2' } };

  class FakeCore {
    constructor() {
      this.events = [];
      this.rt = { running: true };
    }
    start() { return { ok: true, snapshot: this.snapshot(), effects: [] }; }
    step({ events } = {}) {
      this.events = this.events.concat(events || []);
      return { ok: true, snapshot: this.snapshot(), effects: [] };
    }
    snapshot() { return { running: true, gameId: 'v2-game', seen: this.events.slice() }; }
    pause() {}
    resume() {}
    stop() {}
    setParams() {}
    action() {}
  }

  const v2Devices = () => fakeDevices([
    { id: 'qtz1', type: 'QTZ', data: { button0: 0 } },
    { id: 'c1', type: 'CUNZHI01', data: { pressure1: 12 } },
    { id: 'lock1', type: 'ZIDONGSUO' },
  ]);

  function withV2Package(run) {
    const original = coreResolver.resolveGamePackage;
    coreResolver.resolveGamePackage = (id) => (String(id) === 'v2-game' ? V2_PKG : original.call(coreResolver, id));
    try {
      return run();
    } finally {
      coreResolver.resolveGamePackage = original;
    }
  }

  // 假 core 的 snapshot 累积了它见过的所有事件；取「本次动作之后」的新事件用 slice(mark)
  const seenNow = (host) => host.getStatus().snapshot.seen;

  function startV2(devices, extra = {}) {
    const original = coreResolver.createCore;
    coreResolver.createCore = (id, opts) => (String(id) === 'v2-game' ? new FakeCore() : original.call(coreResolver, id, opts));
    const built = createHost(devices, extra);
    try {
      const started = built.host.start({
        gameId: 'v2-game',
        deviceMap: { qtz: ['qtz1'], tiptoeSensor: ['c1'], lock: ['lock1'] },
        params: {},
      });
      return { ...built, core: started.snapshot };
    } finally {
      coreResolver.createCore = original;
    }
  }

  test('mapped device properties are forwarded with role/deviceId/oldValue', () => {
    withV2Package(() => {
      const devices = v2Devices();
      const { host, setNow } = startV2(devices);
      const mark = seenNow(host).length;
      setNow(100);
      devices.emit({ deviceId: 'qtz1', changes: { button0: { old: 0, new: 1 } }, nextData: { button0: 1 } });
      expect(seenNow(host).slice(mark)).toEqual([
        { type: 'device-property', role: 'qtz', deviceId: 'qtz1', name: 'button0', value: 1, oldValue: 0 },
      ]);
    });
  });

  test('an unmapped device never reaches the core', () => {
    withV2Package(() => {
      const devices = v2Devices();
      const { host, setNow } = startV2(devices);
      const mark = seenNow(host).length;
      setNow(100);
      devices.emit({ deviceId: 'other1', changes: { button0: { old: 0, new: 1 } }, nextData: { button0: 1 } });
      devices.emitRaw({ deviceId: 'other1', payload: { method: 'action', action: 'key_clicked' } });
      expect(seenNow(host).slice(mark)).toEqual([]);
    });
  });

  test('an unchanged value produces no event, so a repeating device cannot flood the core', () => {
    withV2Package(() => {
      const devices = v2Devices();
      const { host, setNow } = startV2(devices);
      const mark = seenNow(host).length;
      setNow(100);
      devices.emit({ deviceId: 'qtz1', changes: {}, nextData: { button0: 0 } });
      expect(seenNow(host).slice(mark)).toEqual([]);
      // 一批里的多个属性只触发一次 step，各自带 oldValue
      devices.emit({ deviceId: 'qtz1', changes: { button0: { old: 0, new: 1 }, button1: { old: 0, new: 1 } }, nextData: { button0: 1, button1: 1 } });
      expect(seenNow(host).slice(mark).map((event) => event.name)).toEqual(['button0', 'button1']);
      // 同样的值再报一次（设备周期重报）：不再产生事件
      devices.emit({ deviceId: 'qtz1', changes: { button0: { old: 1, new: 1 }, button1: { old: 1, new: 1 } }, nextData: { button0: 1, button1: 1 } });
      expect(seenNow(host).slice(mark).length).toBe(2);
    });
  });

  test('start seeds every mapped device property once (page readValue equivalent)', () => {
    withV2Package(() => {
      const devices = v2Devices();
      const { host } = startV2(devices);
      const seen = seenNow(host);
      // 补发事件带 seed:true：核心据此把「按住」当基线而不是变化（契约第 3 节）
      expect(seen).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'device-property', role: 'qtz', name: 'button0', value: 0, oldValue: null, seed: true }),
        expect.objectContaining({ type: 'device-property', role: 'tiptoeSensor', name: 'pressure1', value: 12, oldValue: null, seed: true }),
      ]));
      expect(seen.every((event) => event.seed === true)).toBe(true);
    });
  });

  test('key_clicked becomes the lock-key action; other messages become device-event', () => {
    withV2Package(() => {
      const devices = v2Devices();
      const { host, setNow } = startV2(devices);
      const mark = seenNow(host).length;
      setNow(200);
      devices.emitRaw({ deviceId: 'lock1', payload: { method: 'action', action: 'key_clicked' } });
      devices.emitRaw({ deviceId: 'c1', payload: { method: 'low', distance: 20 } });
      expect(seenNow(host).slice(mark)).toEqual([
        { type: 'action', name: 'lock-key', role: 'lock', deviceId: 'lock1' },
        { type: 'device-event', role: 'tiptoeSensor', deviceId: 'c1', name: 'low', payload: { method: 'low', distance: 20 } },
      ]);
    });
  });

  test('builtin cores keep the legacy sensor channel and get no property events', () => {
    const devices = fakeDevices([
      { id: 's1', type: 'QIYA' },
      { id: 'm1', type: 'TD01' },
      { id: 'p1', type: 'DIANJI' },
    ]);
    const { host, setNow } = createHost(devices);
    host.start({
      gameId: 'surge-edging',
      deviceMap: { sensor: ['s1'], motor: ['m1'], punish: ['p1'] },
      params: { duration: 10 },
    });
    setNow(100);
    // sensor 角色的气压照旧；punish 角色的 shock 属性与锁消息一律不进核心
    devices.emit({ deviceId: 's1', changes: { pressure: { old: 0, new: 12.4 } }, nextData: { pressure: 12.4 } });
    expect(host.getStatus().snapshot.currentPressure).toBe(12.4);
    devices.emit({ deviceId: 'p1', changes: { shock: { old: 0, new: 1 } }, nextData: { shock: 1 } });
    devices.emitRaw({ deviceId: 'p1', payload: { method: 'action', action: 'key_clicked' } });
    expect(host.getStatus().snapshot.shockCount).toBe(0);
  });

  test('builtin cores still accept a device mapped to sensor and another role at once', () => {
    // 改动前判据是「deviceMap.sensor 里有没有这台设备」；roleIndex 只保留先声明的角色，
    // 若用它判断，同一台设备同时映射到 sensor 与其他角色时会漏转发（行为回归）。
    const devices = fakeDevices([
      { id: 's1', type: 'QIYA' },
      { id: 'm1', type: 'TD01' },
    ]);
    const { host, setNow } = createHost(devices);
    host.start({
      gameId: 'surge-edging',
      deviceMap: { motor: ['s1'], sensor: ['s1'], punish: ['m1'] },
      params: { duration: 10 },
    });
    setNow(100);
    devices.emit({ deviceId: 's1', changes: { pressure: { old: 0, new: 9.1 } }, nextData: { pressure: 9.1 } });
    expect(host.getStatus().snapshot.currentPressure).toBe(9.1);
  });
});

describe('host runtime remote output guard', () => {
  // 远程会话（source:'remote'）下核心发出的设备意图必须与远程手动输出同一套限幅。
  // DIANJI 的 shock 上限是 min(voltage, intensity)=20（默认电压 20 / 强度 50）。
  const remoteDevices = () => fakeDevices([
    { id: 'p1', type: 'DIANJI' },
    { id: 'm1', type: 'TD01' },
    { id: 's1', type: 'QIYA' },
    { id: 'lock1', type: 'ZIDONGSUO' },
  ]);

  // 不跑真实核心：直接喂一批设备意图，观察宿主怎么执行
  class EffectCore {
    constructor() { this.rt = { running: true }; this.pending = []; }
    start() { return { ok: true, snapshot: this.snapshot(), effects: [] }; }
    step() {
      const effects = this.pending;
      this.pending = [];
      return { ok: true, snapshot: this.snapshot(), effects };
    }
    snapshot() { return { running: true, gameId: 'effect-game' }; }
    pause() {} resume() {} setParams() {} action() {}
    stop() { return { ok: true, snapshot: { ...this.snapshot(), running: false, ended: true }, effects: [] }; }
  }

  function startRemote(devices, effects, extra = {}) {
    const original = coreResolver.createCore;
    const core = new EffectCore();
    core.pending = effects;
    coreResolver.createCore = (id, opts) => (String(id) === 'effect-game' ? core : original.call(coreResolver, id, opts));
    try {
      const built = createHost(devices, extra);
      built.host.start({
        gameId: 'effect-game',
        deviceMap: { sensor: ['s1'], motor: ['m1'], punish: ['p1'], lock: ['lock1'] },
        params: {},
        source: 'remote',
      });
      return { ...built, core };
    } finally {
      coreResolver.createCore = original;
    }
  }

  // 一次远程/本机运行：直接喂一批设备意图给宿主，观察执行结果
  const REMOTE_MAP = { sensor: ['s1'], motor: ['m1'], punish: ['p1'], lock: ['lock1'] };
  function runEffects({ devices, effects = [], source = 'remote', params = {}, extra = {} }) {
    const original = coreResolver.createCore;
    const originalPkg = coreResolver.resolveGamePackage;
    const core = new EffectCore();
    coreResolver.createCore = (id, opts) => (String(id) === 'effect-game' ? core : original.call(coreResolver, id, opts));
    coreResolver.resolveGamePackage = (id) => (
      String(id) === 'effect-game'
        ? { id: 'effect-game', manifest: { id: 'effect-game', runtime: 'host' } }
        : originalPkg.call(coreResolver, id)
    );
    try {
      const built = createHost(devices, extra);
      built.host.start({ gameId: 'effect-game', deviceMap: REMOTE_MAP, params, source });
      core.pending = effects;
      built.host.tick(100);
      return { ...built, core };
    } finally {
      coreResolver.createCore = original;
      coreResolver.resolveGamePackage = originalPkg;
    }
  }

  function startRemote(devices, effects, extra = {}) {
    return runEffects({ devices, effects, extra });
  }

  test('a remote session clamps the core shock to the remote voltage limit; local play is unchanged', () => {
    const devices = remoteDevices();
    const { host, core } = startRemote(devices, []);
    core.pending = [{ type: 'device.shock', role: 'punish', voltage: 30, durationMs: 3000 }];
    host.tick(200);
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'p1', capability: 'shock', action: 'start', input: { voltage: 20 } }),
    ]));
    // 本机玩法（source 缺省）：30V 原样下发，行为不变
    const local = remoteDevices();
    const localRun = runEffects({
      devices: local,
      effects: [{ type: 'device.shock', role: 'punish', voltage: 30, durationMs: 3000 }],
      source: 'local',
    });
    expect(localRun.host.getStatus().source).toBe('local');
    expect(local.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'p1', capability: 'shock', action: 'start', input: { voltage: 30 } }),
    ]));
  });

  test('the owner-set voltage cap applies live: 60 passes, 120 clamps to 100, mid-game change takes effect', () => {
    const devices = remoteDevices();
    let limits = { voltage: 60, power: 128, intensity: 60 };
    const { host, core } = runEffects({
      devices, effects: [], extra: { outputLimitsProvider: () => limits },
    });
    // 持有方把上限调到 60：游戏档位 60V 原样通过（不再被默认 20 压住）
    core.pending = [{ type: 'device.shock', role: 'punish', voltage: 60, durationMs: 1000 }];
    host.tick(200);
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'p1', capability: 'shock', action: 'start', input: { voltage: 60 } }),
    ]));
    // 上限改成 100：120V 仍被硬上限夹到 100，且下一条意图立即用新值
    limits = { voltage: 100, power: 128, intensity: 100 };
    core.pending = [{ type: 'device.shock', role: 'punish', voltage: 120, durationMs: 1000 }];
    host.tick(300);
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'p1', capability: 'shock', action: 'start', input: { voltage: 100 } }),
    ]));
    // 游戏运行中把上限降回 20：下一条意图立刻被收紧
    limits = { voltage: 20, power: 128, intensity: 50 };
    core.pending = [{ type: 'device.shock', role: 'punish', voltage: 35, durationMs: 1000 }];
    host.tick(400);
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'p1', capability: 'shock', action: 'start', input: { voltage: 20 } }),
    ]));
  });

  test('a remote session rejects unknown intents and unsupported capabilities but keeps stop paths', () => {
    const devices = remoteDevices();
    const logs = [];
    const { host, core } = startRemote(devices, [], { outputLogHook: (entry) => logs.push(entry) });
    core.pending = [
      { type: 'device.detonate', role: 'punish' },                        // 未知意图类型
      { type: 'device.shock', role: 'motor', voltage: 20 },               // TD01 不支持 shock
      { type: 'device.shock', role: 'punish', voltage: 20, pattern: 'x' }, // 未知意图字段
      { type: 'device.set-strength', role: 'motor', value: 200 },         // 电机限幅 128
      { type: 'device.lock', role: 'lock', open: false },                 // 锁：只有布尔→0/1 归一化，不算限幅
      { type: 'device.shock-stop', role: 'punish' },                      // 停止永远放行
    ];
    host.tick(100);
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'm1', capability: 'strength', action: 'set', input: { value: 128 } }),
      expect.objectContaining({ id: 'lock1', capability: 'lock', action: 'setOpen', input: { open: 0 } }),
      expect.objectContaining({ id: 'p1', capability: 'shock', action: 'stop' }),
    ]));
    expect(devices.calls.some((call) => call.id === 'm1' && call.capability === 'shock')).toBe(false);
    expect(devices.calls.some((call) => call.id === 'p1' && call.action === 'start')).toBe(false);
    expect(logs.map((entry) => entry.effectType)).toEqual(expect.arrayContaining([
      'device.detonate', 'device.shock', 'device.set-strength',
    ]));
    // 布尔归一化（open:false → 0）不是限幅，不写操作记录，免得刷屏
    expect(logs.some((entry) => entry.effectType === 'device.lock')).toBe(false);
    expect(logs.every((entry) => entry.gameId === 'effect-game')).toBe(true);
  });

  test('a latched remote intent arms the watchdog; a refresh re-arms it and stop clears it', async () => {
    const devices = remoteDevices();
    const { host, core, time } = startRemote(devices, []);
    core.pending = [{ type: 'device.shock', role: 'punish', voltage: 20, durationMs: 3000 }];
    host.tick(200);
    const armed = time.timers.filter((timer) => timer.delay === 10000 && !timer.cleared);
    expect(armed).toHaveLength(1);
    // 同一设备的新意图刷新锁存：按新的 60s 重新计时
    core.pending = [{ type: 'device.set-strength', role: 'motor', value: 10 }];
    host.tick(300);
    const motorTimer = time.timers.filter((timer) => timer.delay === 60000 && !timer.cleared);
    expect(motorTimer).toHaveLength(1);
    // 到点兜底停机（watchdog 的停机回调在微任务里执行）
    motorTimer[0].fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'm1', stopped: true }),
    ]));
    // 停止意图清掉该设备的看门狗（另一台设备的锁存不受影响）
    core.pending = [{ type: 'device.shock-stop', role: 'punish' }];
    host.tick(400);
    expect(time.timers.filter((timer) => timer.delay === 10000 && !timer.cleared)).toEqual([]);
  });

  test('ending a remote game clears its watchdog registrations', () => {
    const devices = remoteDevices();
    const { host, core, time } = startRemote(devices, []);
    core.pending = [{ type: 'device.set-strength', role: 'motor', value: 10 }];
    host.tick(200);
    expect(time.timers.some((timer) => timer.delay === 60000 && !timer.cleared)).toBe(true);
    host.stop({ reason: 'user' });
    expect(time.timers.filter((timer) => timer.delay === 60000 && !timer.cleared)).toEqual([]);
  });

  test('builtin cores under a remote session keep their outputs within limits', () => {
    const devices = fakeDevices([
      { id: 's1', type: 'QIYA' },
      { id: 'm1', type: 'TD01' },
      { id: 'p1', type: 'DIANJI' },
      { id: 'lock1', type: 'ZIDONGSUO' },
    ]);
    const { host, setNow } = createHost(devices);
    host.start({
      gameId: 'surge-edging',
      deviceMap: { sensor: ['s1'], motor: ['m1'], punish: ['p1'], lock: ['lock1'] },
      params: { duration: 10, minSurgeMs: 100, surgeWindowMs: 500, shockVoltage: 20, shockDuration: 3, endCalmLock: 0, lowPressureDelay: 2 },
      source: 'remote',
    });
    for (let i = 0; i < 12; i += 1) host.pushSensor({ value: 10, nowMs: i * 100 });
    setNow(1200);
    host.pushSensor({ value: 13.5, nowMs: 1200 });
    setNow(1300);
    host.pushSensor({ value: 13.5, nowMs: 1300 });
    const shock = devices.calls.find((call) => call.id === 'p1' && call.capability === 'shock' && call.action === 'start');
    expect(shock.input.voltage).toBe(20);
    expect(host.getStatus().errors.some((error) => error.message.includes('被拒绝'))).toBe(false);
    // 电机强度同样过安全层（本机是 0–255，远程封顶 128）
    const strength = devices.calls.filter((call) => call.id === 'm1' && call.capability === 'strength' && call.action === 'set');
    expect(strength.every((call) => call.input.value <= 128)).toBe(true);
  });

  test('pressure-edging-v2 under a remote session passes its outputs through unchanged', () => {
    const devices = fakeDevices([
      { id: 's1', type: 'QIYA' },
      { id: 'm1', type: 'TD01' },
      { id: 'p1', type: 'DIANJI' },
      { id: 'lock1', type: 'ZIDONGSUO' },
    ]);
    const { host, setNow } = createHost(devices);
    host.start({
      gameId: 'pressure-edging-v2',
      deviceMap: { sensor: ['s1'], motor: ['m1'], punish: ['p1'], lock: ['lock1'] },
      params: { duration: 10, shockVoltage: 20, shockDuration: 3, criticalPressure: 20, endCalmLock: 0 },
      source: 'remote',
    });
    for (let i = 0; i < 20; i += 1) {
      setNow(i * 200);
      host.pushSensor({ value: 25, nowMs: i * 200 });
    }
    const shock = devices.calls.find((call) => call.id === 'p1' && call.capability === 'shock' && call.action === 'start');
    expect(shock).toBeTruthy();
    expect(shock.input.voltage).toBe(20);
    expect(host.getStatus().errors.filter((error) => error.message.includes('被拒绝'))).toEqual([]);
  });
});

describe('host runtime state stream', () => {
  // 画面流的合并窗口定时器（50ms）由注入的 setTimer 驱动，测试里手动到点
  const flushStream = (time) => {
    for (const timer of time.timers) {
      if (!timer.cleared && timer.delay === 50) timer.fn();
    }
  };

  test('a start publishes a full state event and later ticks ship only the diff', () => {
    const devices = baseDevices();
    const { host, time, setNow } = createHost(devices);
    const events = [];
    host.subscribeState((event) => events.push(event));
    expect(events[0]).toMatchObject({ type: 'snapshot', state: null });

    host.start({ gameId: 'surge-edging', deviceMap: { sensor: ['s1'], motor: ['m1'] }, params: { duration: 10 } });
    flushStream(time); // 合并窗口到点：发一次
    expect(events[events.length - 1].type).toBe('snapshot');
    // 全量帧的字段名必须是 state（SSE / MQTT / 前端都读它）
    expect(events[events.length - 1].state.running).toBe(true);
    expect(events[events.length - 1]).not.toHaveProperty('snapshot');
    const rev = events[events.length - 1].rev;

    // 传感器变化 → 只发变化的路径（baseRev 指向上一帧的 rev）
    devices.emit({ deviceId: 's1', changes: { pressure: { new: 12.4 } }, nextData: { pressure: 12.4 } });
    flushStream(time);
    const patch = events[events.length - 1];
    expect(patch.type).toBe('patch');
    expect(patch.baseRev).toBe(rev);
    expect(patch.rev).toBeGreaterThan(rev);
    expect(patch.ops.some((op) => op.path === 'snapshot.currentPressure')).toBe(true);
    expect(JSON.stringify(patch.ops)).not.toContain('INITIAL_CALM');
  });

  test('stopping publishes a full frame so subscribers never miss the ended state', () => {
    const devices = baseDevices();
    const { host } = createHost(devices);
    const events = [];
    host.subscribeState((event) => events.push(event));
    host.start({ gameId: 'surge-edging', deviceMap: { sensor: ['s1'], motor: ['m1'] }, params: { duration: 10 } });
    host.stop({ reason: 'user_stop' });
    const last = events[events.length - 1];
    expect(last.type).toBe('snapshot');
    expect(last.state.running).toBe(false);
    expect(last.state.snapshot.ended).toBe(true);
  });

  test('a subscriber arriving with a pending change gets a first frame that later patches extend', () => {
    const devices = baseDevices();
    const { host, time } = createHost(devices);
    host.start({ gameId: 'surge-edging', deviceMap: { sensor: ['s1'], motor: ['m1'] }, params: { duration: 10 } });
    flushStream(time); // rev=1 发布
    host.pause(); // 进窗口，未到点（pending）
    // SSE 进流首帧：getStateEvent 必须先 flush，否则首帧比 diff 基准新
    const first = { type: 'snapshot', ...host.getStateEvent() };
    const frames = [first];
    host.subscribeState((event) => frames.push(event));
    flushStream(time);
    const applied = frames.slice(1).reduce((doc, event) => (
      event.type === 'patch' ? require('../public/game-state-patch').apply(doc, event.ops) : event.state
    ), first.state);
    expect(applied.snapshot.paused).toBe(true);
    expect(applied.snapshot.logs.length).toBe(host.getStatus().snapshot.logs.length);
  });

  test('getStateEvent always returns a usable full frame for reconnects', () => {
    const devices = baseDevices();
    const { host } = createHost(devices);
    expect(host.getStateEvent()).toMatchObject({ rev: 0, state: { active: false, running: false } });
    host.start({ gameId: 'surge-edging', deviceMap: { sensor: ['s1'], motor: ['m1'] }, params: { duration: 10 } });
    host.flushState();
    const event = host.getStateEvent();
    expect(event.rev).toBeGreaterThan(0);
    expect(event.state.snapshot.running).toBe(true);
  });
});


describe('play carrier events', () => {
  const devices = () => fakeDevices([{ id: 'd1', type: 'TD01', nickname: 'd1' }]);

  test('start / stop / natural end emit exactly one carrier event each', () => {
    const seen = [];
    const unsubscribe = playCarrierBus.onPlayCarrierChange((event) => seen.push(event));
    try {
      const { host } = createHost(devices());
      host.start({ gameId: 'surge-edging', deviceMap: { estim: ['d1'] }, params: {}, source: 'remote' });
      host.stop({ reason: 'explicit-exit' });
      expect(seen).toEqual([
        { action: 'start', kind: 'host', gameId: 'surge-edging', gameName: null, source: 'remote' },
        { action: 'exit', kind: 'host', reason: 'explicit-exit', source: 'remote' },
      ]);
    } finally {
      unsubscribe();
    }
  });

  test('replacing a running game emits exit then start so the occupancy follows the new game', () => {
    const seen = [];
    const unsubscribe = playCarrierBus.onPlayCarrierChange((event) => seen.push(event));
    try {
      const { host } = createHost(devices());
      host.start({ gameId: 'surge-edging', deviceMap: { estim: ['d1'] }, params: {}, source: 'local' });
      host.start({ gameId: 'pressure-edging-v2', deviceMap: { estim: ['d1'] }, params: {}, source: 'remote' });
      expect(seen.map((event) => `${event.action}:${event.source}`)).toEqual([
        'start:local', 'exit:local', 'start:remote',
      ]);
    } finally {
      unsubscribe();
    }
  });
});
