const { GameHostService } = require('../game-runtime/gameHostService');

function fakeDevices(rows) {
  return {
    rows: new Map(rows.map((row) => [row.id, row])),
    calls: [],
    handlers: [],
    getDeviceById(id) { return this.rows.get(id) || null; },
    onDeviceDataChange(handler) { this.handlers.push(handler); },
    invokeDeviceCapability(id, capability, action, input) {
      this.calls.push({ id, capability, action, input });
    },
    emit(event) { for (const handler of this.handlers) handler(event); },
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
});
