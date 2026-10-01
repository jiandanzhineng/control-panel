const { PressureEdgingV2Core } = require('../game-runtime/cores/pressure-edging-v2-core');

function create(params = {}) {
  return new PressureEdgingV2Core({ params, random: () => 0.5 });
}

function sample(core, nowMs, value) {
  return core.step({ nowMs, events: [{ type: 'sensor', name: 'sphincterPressure', value }] });
}

describe('pressure edging v2 core', () => {
  test('defaults and numeric normalization follow the config form (min/max only)', () => {
    const core = create({ duration: 999, midPressure: 18.26, criticalPressure: 20.04 });
    expect(core.snapshot().params).toMatchObject({ duration: 180, midPressure: 18.26, criticalPressure: 20.04 });
    expect(core.snapshot().params.voiceEnabled).toBe(true);
    expect(() => create({ midPressure: 20, criticalPressure: 20 })).not.toThrow();
    expect(() => core.setParams({ voiceEnabled: 'false' })).toThrow('布尔值');
    expect(() => core.setParams({ duration: Number.NaN })).toThrow('数字');
    expect(() => core.setParams(null)).toThrow('对象');
    expect(core.snapshot().params.duration).toBe(180);
  });

  test('pressure drives calm, middle, edge and delayed recovery with device effects', () => {
    const core = create({ duration: 1, endCalmLock: 0, gradualIncrease: 10, rampRate: 50, lowPressureDelay: 1 });
    const started = core.start(1000);
    expect(started.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'device.set-report-delay', role: 'sensor', ms: 100 }),
      expect.objectContaining({ type: 'device.lock', open: false }),
    ]));
    sample(core, 2000, 0);
    expect(core.snapshot().currentIntensity).toBeGreaterThan(0);
    sample(core, 2100, 19.5);
    expect(core.snapshot().phase).toBe('MIDDLE');
    const edged = sample(core, 2200, 20);
    expect(edged.snapshot).toMatchObject({ phase: 'EDGING', edgingCount: 1, shockCount: 1, currentIntensity: 0 });
    expect(edged.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'device.stop-strength', role: 'motor' }),
      expect.objectContaining({ type: 'device.shock', role: 'punish' }),
    ]));
    sample(core, 2300, 18);
    expect(core.snapshot().phase).toBe('DELAY');
    sample(core, 3401, 18);
    expect(core.snapshot().phase).toBe('SUB_CALM');
    expect(core.snapshot().averagePressure).toBe(15.1);
  });

  test('takeoff stays calm, pause freezes the state machine without extending the end', () => {
    const core = create({ duration: 1, endCalmLock: 10, gradualIncrease: 10, rampRate: 50 });
    core.start(0);
    sample(core, 51000, 19.5);
    expect(core.snapshot().phase).toBe('SUB_CALM');
    const paused = core.pause(52000);
    expect(paused.effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'device.stop-strength' })]));
    const before = core.snapshot();
    sample(core, 62000, 25);
    expect(core.snapshot()).toMatchObject({ paused: true, phase: before.phase, endTimeMs: before.endTimeMs, currentIntensity: 0 });
    core.resume(65000);
    expect(core.snapshot().endTimeMs).toBe(60000);
    core.setParams({ duration: 2, midPressure: 18.5 });
    expect(core.snapshot()).toMatchObject({ endTimeMs: 120000, params: expect.objectContaining({ duration: 2, midPressure: 18.5 }) });
    sample(core, 115000, 25);
    expect(core.snapshot().phase).toBe('SUB_CALM');
  });

  test('in-game threshold tuning matches the original page: no upper cap on critical', () => {
    const core = create({ duration: 10, midPressure: 19.2, criticalPressure: 100 });
    core.start(0);
    for (let i = 0; i < 20; i += 1) core.action('adjustThreshold', { which: 'crit', delta: 0.1 }, 100 + i);
    expect(core.snapshot().params.criticalPressure).toBe(102);
    core.action('setThresholds', { midPressure: 30, criticalPressure: 150 }, 200);
    expect(core.snapshot().params).toMatchObject({ midPressure: 30, criticalPressure: 150 });
    core.action('adjustThreshold', { which: 'crit', delta: -200 }, 300);
    expect(core.snapshot().params.criticalPressure).toBe(30.1);
    core.action('adjustThreshold', { which: 'mid', delta: 5 }, 400);
    expect(core.snapshot().params.midPressure).toBe(30);
    core.action('setThresholds', { midPressure: 25, criticalPressure: 20 }, 500);
    expect(core.snapshot().params).toMatchObject({ midPressure: 19.9, criticalPressure: 20 });
  });

  test('manual +10 only bumps the current target; recovery intensity is not capped', () => {
    const core = create({ duration: 10, endCalmLock: 0, gradualIncrease: 0, rampRate: 1000, lowPressureDelay: 0, maxMotorIntensity: 100, sensitivity: 15 });
    core.start(0);
    sample(core, 100, 10);
    core.action('addIntensity', { delta: 10 }, 150);
    expect(core.snapshot().targetIntensity).toBe(10);
    sample(core, 200, 10);
    expect(core.snapshot().targetIntensity).toBe(0);
    sample(core, 300, 19.5);
    sample(core, 400, 20);
    sample(core, 500, 10);
    sample(core, 600, 10);
    expect(core.snapshot().phase).toBe('SUB_CALM');
    expect(core.rt.unRandomIntensity).toBeCloseTo(100 * 10 / 5);
  });

  test('manual actions, shock expiry, natural end and explicit stop are deterministic', () => {
    const core = create({ duration: 1, endCalmLock: 0, shockDuration: 1 });
    core.start(0);
    core.action('addIntensity', { delta: 10 }, 100);
    expect(core.snapshot().targetIntensity).toBe(10);
    const shocked = core.action('shockOnce', {}, 200);
    expect(shocked.effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'device.shock', durationMs: 1000 })]));
    expect(core.snapshot().isShocking).toBe(true);
    core.step({ nowMs: 1200 });
    expect(core.snapshot().isShocking).toBe(false);
    expect(() => core.action('adjustThreshold', { which: 'unknown', delta: 0.1 }, 1300)).toThrow('未知阈值');
    expect(() => core.action('unknown', {}, 1300)).toThrow('未知操作');
    const ended = core.step({ nowMs: 60000 });
    expect(ended.snapshot).toMatchObject({ running: false, ended: true, phase: 'ENDED', endReason: 'duration' });
    expect(ended.effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'device.stop-all' })]));
    core.start(70000);
    expect(core.snapshot()).toMatchObject({ running: true, shockCount: 0, edgingCount: 0 });
    expect(core.stop(71000).effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'device.stop-all' })]));
  });
});
