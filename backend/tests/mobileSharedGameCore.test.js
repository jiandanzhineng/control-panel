const vm = require('vm');
const { buildMobilePressureCore, buildMobileCore } = require('../../scripts/sync-mobile-games');
const { SurgeEdgingCore } = require('../game-runtime/cores/surge-edging-core');
const { MaidPunishmentCore } = require('../games/maid-punishment/game-core');
const { PressureEdgingV2Core } = require('../game-runtime/cores/pressure-edging-v2-core');

const plain = value => JSON.parse(JSON.stringify(value));
function mobile(params) {
  const ctx = vm.createContext({});
  vm.runInContext(buildMobilePressureCore(), ctx);
  ctx.GameCore.create({ params, randomSeed: 42 });
  return ctx.GameCore;
}

test('mobile starts at time zero, emits start effects once, and never restarts after ending', () => {
  const core = mobile({ duration: 1, endCalmLock: 0 });
  const first = core.dispatch({ nowMs: 0, events: [] });
  expect(first.snapshot.startedAtMs).toBe(0);
  expect(first.snapshot.endTimeMs).toBe(60000);
  expect(first.effects).toHaveLength(4);
  expect(core.dispatch({ nowMs: 1, events: [] }).effects).toEqual([]);
  const ended = core.dispatch({ nowMs: 60000, events: [{ type: 'tick' }] });
  expect(ended.snapshot.ended).toBe(true);
  expect(ended.effects).toEqual([{ type: 'device.stop-all' }]);
  const idle = core.dispatch({ nowMs: 60001, events: [] });
  expect(idle.effects).toEqual([]);
  expect(idle.logs).toEqual([]);
  expect(idle.snapshot.ended).toBe(true);
});

function sharedMobile(gameId, params) {
  const ctx = vm.createContext({});
  vm.runInContext(buildMobileCore(gameId), ctx);
  ctx.GameCore.create({ params, randomSeed: 42 });
  return ctx.GameCore;
}

function compareSequence(gameId, Ctor, params, sequence) {
  const phone = sharedMobile(gameId, params);
  const pc = new Ctor({ params });
  expect(plain(phone.dispatch({ nowMs: 1000, events: [] }))).toEqual(plain(pc.start(1000)));
  for (const [nowMs, event] of sequence) {
    const expected = event.type === 'tick' ? pc.step({ nowMs, events: [] })
      : event.type === 'action' && event.action ? pc.action(event.action, event.payload || {}, nowMs)
      : event.type === 'params' ? pc.setParams(event.params)
      : ['pause', 'resume', 'stop'].includes(event.type) ? pc[event.type](nowMs)
      : pc.step({ nowMs, events: [event] });
    expect(plain(phone.dispatch({ nowMs, events: [event] }))).toEqual(plain(expected));
  }
  return phone;
}

test.each([
  ['surge-edging', SurgeEdgingCore], ['maid-punishment', MaidPunishmentCore],
])('%s starts once at zero and never repeats effects, logs or restarts after ending', (id, Ctor) => {
  const phone = sharedMobile(id, { duration: 1, endCalmLock: 0 });
  const pc = new Ctor({ params: { duration: 1, endCalmLock: 0 } });
  expect(plain(phone.dispatch({ nowMs: 0, events: [] }))).toEqual(plain(pc.start(0)));
  const idle = phone.dispatch({ nowMs: 1, events: [] });
  expect(idle.effects).toEqual([]);
  expect(idle.logs).toEqual([]);
  expect(phone.dispatch({ nowMs: 60000, events: [{ type: 'tick' }] }).snapshot.ended).toBe(true);
  const ended = phone.dispatch({ nowMs: 61000, events: [] });
  expect(ended.snapshot.ended).toBe(true);
  expect(ended.effects).toEqual([]);
});

test('surge mobile bundle matches PC new detection, defaults, pause, actions and ending', () => {
  const sensor = value => ({ type: 'sensor', name: 'sphincterPressure', value });
  const phone = compareSequence('surge-edging', SurgeEdgingCore,
    { duration: 1, endCalmLock: 0, randomPercent: 0 }, [
      [1100, sensor(10)], [1200, sensor(12)], [1300, sensor(12)],
      [2000, { type: 'pause' }], [12000, { type: 'resume' }],
      [12000, { type: 'tick' }],
      [13000, { type: 'action', action: 'adjustMid', payload: { delta: 0.1 } }],
      [14000, { type: 'action', action: 'shockOnce' }],
      [15000, { type: 'params', params: { lowPressureDelay: 12, maxEdgeSec: 13 } }],
      [16000, sensor(10)], [28000, { type: 'tick' }], [61000, { type: 'tick' }],
    ]);
  expect(phone.dispatch({ nowMs: 62000, events: [] }).snapshot.endTimeMs).toBe(61000);
  const defaults = sharedMobile('surge-edging', {}).dispatch({ nowMs: 0, events: [] }).snapshot.params;
  expect(defaults.lowPressureDelay).toBe(10);
  expect(defaults.maxEdgeSec).toBe(10);
  const detection = sharedMobile('surge-edging', { endCalmLock: 0 });
  detection.dispatch({ nowMs: 1000, events: [] });
  for (const [time, value] of [[1100, 10], [1200, 12], [1300, 12]])
    detection.dispatch({ nowMs: time, events: [sensor(value)] });
  expect(detection.dispatch({ nowMs: 1300, events: [] }).snapshot.phase).toBe('EDGING');
});

test('maid mobile bundle matches PC seeded buttons, shock timeout, TD01, pressure and controls', () => {
  const button = (value, seed = false) => ({ type: 'device-property', role: 'qtz', deviceId: 'q', name: 'button0', value, ...(seed ? { seed: true } : {}) });
  const phone = compareSequence('maid-punishment', MaidPunishmentCore,
    { duration: 2, shockDurationSeconds: 1, td01DelaySeconds: 1 }, [
      [1000, button(1, true)], [1100, button(0)], [1200, button(1)],
      [2300, { type: 'tick' }], [5000, { type: 'tick' }],
      [6000, button(0)], [7200, { type: 'tick' }], [12500, { type: 'tick' }],
      [12600, { type: 'device-property', role: 'tiptoeSensor', deviceId: 'p', name: 'pressure1', value: 90 }],
      [13000, { type: 'tick' }], [13100, { type: 'pause' }], [13500, { type: 'resume' }],
      [13600, { type: 'action', action: 'shockOnce' }],
      [13700, { type: 'params', params: { shockDurationSeconds: 2 } }],
      [14000, { type: 'action', action: 'unlock' }], [121000, { type: 'tick' }],
    ]);
  expect(phone.dispatch({ nowMs: 122000, events: [] }).snapshot.ended).toBe(true);
  const manual = compareSequence('maid-punishment', MaidPunishmentCore, { manualStart: true }, [
    [2000, { type: 'action', name: 'lock-key', role: 'lock', deviceId: 'l' }],
    [3000, { type: 'action', action: 'forceStart' }], [4000, { type: 'stop' }],
  ]);
  expect(manual.dispatch({ nowMs: 5000, events: [] }).snapshot.ended).toBe(true);
});

test('real mobile bundle matches PC snapshots and effects through original controls and phases', () => {
  const params = { duration: 1, endCalmLock: 5, randomPercent: 0, midPressure: 19.23 };
  const pc = new PressureEdgingV2Core({ params });
  const phone = mobile(params);
  expect(plain(phone.dispatch({ nowMs: 1000, events: [] }))).toEqual(plain(pc.start(1000)));
  const sequence = [
    [2000, { type: 'tick' }],
    [2000, { type: 'action', action: 'addIntensity', payload: { delta: 10 } }],
    [2100, { type: 'tick' }],
    [6000, { type: 'tick' }],
    [6000, { type: 'pause' }],
    [6500, { type: 'action', action: 'shockOnce' }],
    [7000, { type: 'sensor', name: 'sphincterPressure', value: 19.5 }],
    [8000, { type: 'resume' }],
    [8000, { type: 'tick' }],
    [8100, { type: 'action', action: 'setThresholds', payload: { midPressure: 18, criticalPressure: 20 } }],
    [8200, { type: 'sensor', name: 'sphincterPressure', value: 19 }],
    [9000, { type: 'sensor', name: 'sphincterPressure', value: 21 }],
    [13000, { type: 'sensor', name: 'sphincterPressure', value: 17 }],
    [20000, { type: 'tick' }],
    [21000, { type: 'params', params: { criticalPressure: 100, midPressure: 25 } }],
    [22000, { type: 'action', action: 'adjustThreshold', payload: { which: 'crit', delta: 0.1 } }],
    [57000, { type: 'tick' }],
    [61000, { type: 'tick' }],
  ];
  for (const [nowMs, event] of sequence) {
    const expected = event.type === 'tick' ? pc.step({ nowMs, events: [] })
      : event.type === 'sensor' ? pc.step({ nowMs, events: [event] })
      : event.type === 'action' ? pc.action(event.action, event.payload || {}, nowMs)
      : event.type === 'params' ? pc.setParams(event.params) : pc[event.type](nowMs);
    expect(plain(phone.dispatch({ nowMs, events: [event] }))).toEqual(plain(expected));
  }
});

test('a first dispatch containing events preserves startup effects and all event effects', () => {
  const params = { endCalmLock: 0 };
  const pc = new PressureEdgingV2Core({ params });
  const expectedStart = pc.start(1000);
  const expectedShock = pc.action('shockOnce', {}, 1000);
  const phone = mobile(params);
  const result = phone.dispatch({ nowMs: 1000, events: [{ type: 'action', action: 'shockOnce' }] });
  expect(plain(result.effects)).toEqual([...expectedStart.effects, ...expectedShock.effects]);
  expect(plain(result.snapshot)).toEqual(plain(expectedShock.snapshot));
});
