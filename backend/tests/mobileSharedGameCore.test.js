const vm = require('vm');
const { buildMobilePressureCore } = require('../../scripts/sync-mobile-games');
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
