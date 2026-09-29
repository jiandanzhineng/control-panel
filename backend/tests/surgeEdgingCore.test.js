const fs = require('fs');
const path = require('path');
const { SurgeEdgingCore } = require('../game-runtime/cores/surge-edging-core');

function createCore(params, random = () => 0.5) {
  return new SurgeEdgingCore({ params, random });
}

function feed(core, nowMs, pressure) {
  return core.step({
    nowMs,
    events: [{ type: 'sensor', name: 'sphincterPressure', value: pressure }],
  });
}

function fillWindow(core, startMs, pressure, count = 12, gap = 100) {
  let result = null;
  for (let i = 0; i < count; i += 1) {
    result = feed(core, startMs + i * gap, pressure);
  }
  return result;
}

describe('surge-edging core', () => {
  test('normalizes defaults and min/max without writing runtime fields', () => {
    const core = createCore();
    const snap = core.snapshot();
    expect(snap.params.duration).toBe(20);
    expect(snap.params.surgeRiseKpa).toBe(1);
    expect(snap.params.voiceEnabled).toBe(true);
    expect(snap.running).toBe(false);
    expect(snap.endCalmLocked).toBe(false);
    expect(snap.edgeTriggerTs).toBe(0);

    const low = core.setParams({ duration: 0, surgeRiseKpa: 9, hack: true, running: true });
    expect(low.ok).toBe(true);
    expect(low.snapshot.params.duration).toBe(1);
    expect(low.snapshot.params.surgeRiseKpa).toBe(5);
    expect(low.snapshot.params.hack).toBeUndefined();
    expect(low.snapshot.running).toBe(false);

    const bad = core.setParams({ duration: 'fast' });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('INVALID_PARAMS');
    expect(bad.snapshot.params.duration).toBe(1);
    expect(core.setParams(null).code).toBe('INVALID_PARAMS');
  });

  test('start pause resume stop lifecycle', () => {
    const core = createCore({ duration: 1, sendIntervalMs: 200 });
    const started = core.start(0);
    expect(started.ok).toBe(true);
    expect(started.snapshot.running).toBe(true);
    expect(started.snapshot.phase).toBe('INITIAL_CALM');

    feed(core, 1000, 10);
    const paused = core.pause(1500);
    expect(paused.snapshot.paused).toBe(true);
    expect(paused.effects).toEqual(expect.arrayContaining([
      { type: 'device.stop-strength', role: 'motor' },
      { type: 'device.shock-stop', role: 'punish' },
    ]));
    const resumed = core.resume(4000);
    expect(resumed.ok).toBe(true);
    expect(resumed.snapshot.paused).toBe(false);
    expect(resumed.snapshot.endTimeMs).toBe(60 * 1000 + 2500);

    const stopped = core.stop(5000, 'user');
    expect(stopped.snapshot.ended).toBe(true);
    expect(stopped.snapshot.phase).toBe('ENDED');
    expect(stopped.effects).toEqual(expect.arrayContaining([{ type: 'device.stop-all' }]));
  });

  test('advancing time while paused does not change phase, timers or intensity', () => {
    const core = createCore({ duration: 10, gradualIncrease: 2, sendIntervalMs: 200 });
    core.start(0);
    feed(core, 1000, 10);
    core.pause(1200);
    const frozen = core.snapshot();
    feed(core, 20000, 18);
    const later = core.snapshot();
    expect(later.phase).toBe(frozen.phase);
    expect(later.currentIntensity).toBe(frozen.currentIntensity);
    expect(later.edgeTriggerTs).toBe(frozen.edgeTriggerTs);
    expect(later.edgingCount).toBe(frozen.edgingCount);
    expect(later.endTimeMs).toBe(frozen.endTimeMs);
    expect(later.paused).toBe(true);
  });

  test('窗口最小值突变进入边缘期并下发停止与电击', () => {
    const core = createCore({
      duration: 20,
      surgeRiseKpa: 1,
      minSurgeMs: 100,
      shockVoltage: 20,
      shockDuration: 3,
    });
    core.start(0);
    fillWindow(core, 0, 10, 12, 100);
    feed(core, 1200, 13.5);
    const edged = feed(core, 1300, 13.5);
    expect(edged.snapshot.phase).toBe('EDGING');
    expect(edged.snapshot.edgingCount).toBe(1);
    expect(edged.effects).toEqual(expect.arrayContaining([
      { type: 'device.stop-strength', role: 'motor' },
      { type: 'device.shock', role: 'punish', voltage: 20, durationMs: 3000 },
    ]));
  });

  test('中期回落需连续低于中间压 midDelay 秒才转平静期', () => {
    const core = createCore({ surgeRiseKpa: 1, minSurgeMs: 100, midDelay: 2 });
    core.start(0);
    fillWindow(core, 0, 55, 12, 100); // 初始中间压 50，55 ≥ 50 → 中期
    const mid = feed(core, 1200, 55);
    expect(mid.snapshot.phase).toBe('MIDDLE');
    feed(core, 1300, 40); // 开始回落，计时起点
    const dip = feed(core, 2200, 40); // 连续回落 0.9s < midDelay 2s
    expect(dip.snapshot.phase).toBe('MIDDLE');
    expect(dip.snapshot.targetIntensity).toBe(20); // 公式越界被封顶到 dmax
    const calm = feed(core, 3400, 40); // 连续回落 2.1s > midDelay
    expect(calm.snapshot.phase).toBe('SUB_CALM');
    expect(calm.logs.some((entry) => entry.message.includes('压力连续回落'))).toBe(true);
  });

  test('edging release enters cooldown and cooldown returns to calm', () => {
    const core = createCore({
      surgeRiseKpa: 1,
      minSurgeMs: 100,
      lowPressureDelay: 2,
      maxEdgeSec: 30,
    });
    core.start(0);
    fillWindow(core, 0, 10, 12, 100);
    feed(core, 1200, 13.5);
    feed(core, 1300, 13.5);
    const cooling = feed(core, 1600, 8.5);
    expect(cooling.snapshot.phase).toBe('DELAY');
    const calm = feed(core, 1600 + 2001, 8.5);
    expect(calm.snapshot.phase).toBe('SUB_CALM');
    expect(calm.snapshot.phaseText).toBe('平静期');
  });

  test('edging timeout forces cooldown', () => {
    const core = createCore({ maxEdgeSec: 5, lowPressureDelay: 2, minSurgeMs: 100 });
    core.start(0);
    fillWindow(core, 0, 10, 12, 100);
    feed(core, 1200, 13.5);
    const edged = feed(core, 1300, 13.5);
    expect(edged.snapshot.phase).toBe('EDGING');
    const held = feed(core, 1300 + 5001, 13.5);
    expect(held.snapshot.phase).toBe('DELAY');
    expect(held.logs.some((entry) => entry.message.includes('强制进入冷却'))).toBe(true);
  });

  test('duration expiry ends the game and emits stop-all', () => {
    const core = createCore({ duration: 1 });
    core.start(1000);
    const ended = core.step({ nowMs: 1000 + 60 * 1000, events: [] });
    expect(ended.snapshot.ended).toBe(true);
    expect(ended.snapshot.running).toBe(false);
    expect(ended.snapshot.endReason).toBe('duration');
    expect(ended.effects).toEqual(expect.arrayContaining([{ type: 'device.stop-all' }]));
  });

  test('repeated start, unknown action and illegal params return stable errors', () => {
    const core = createCore();
    core.start(0);
    const again = core.start(10);
    expect(again.ok).toBe(false);
    expect(again.code).toBe('ALREADY_RUNNING');
    expect(again.snapshot.running).toBe(true);
    const unknown = core.action('explode', {}, 20);
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBe('UNKNOWN_ACTION');
    expect(core.setParams(['duration']).code).toBe('INVALID_PARAMS');
  });

  test('fixed nowMs and random make the result deterministic', () => {
    const run = () => {
      const core = createCore({ randomPercent: 20, gradualIncrease: 2, sendIntervalMs: 200 }, () => 0.25);
      core.start(0);
      return [
        feed(core, 200, 10).snapshot,
        feed(core, 500, 10.2).snapshot,
        core.action('addIntensity', { delta: 10 }, 600).snapshot,
      ];
    };
    expect(run()).toEqual(run());
  });

  test('core source does not own timers, DOM or network', () => {
    const source = fs.readFileSync(path.join(__dirname, '../game-runtime/cores/surge-edging-core.js'), 'utf8');
    expect(source).not.toMatch(/Date\.now|setTimeout|setInterval|document\.|window\.|WebSocket|MQTT|Math\.random/);
  });
});
