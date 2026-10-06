const guard = require('../services/remoteOutputGuard');

const {
  sanitizeCapabilityInvoke,
  sanitizeProjectionMessage,
  isLatchedOutput,
  isLatchedProjectionMessage,
  createOutputWatchdog,
  DEFAULT_REMOTE_LIMITS,
  REMOTE_OUTPUT_REJECTED,
} = guard;

function rejected(result) {
  expect(result.ok).toBe(false);
  expect(result.code).toBe(REMOTE_OUTPUT_REJECTED);
}

describe('remoteOutputGuard defaults', () => {
  test('defaults cover the brand intensity scale', () => {
    expect(DEFAULT_REMOTE_LIMITS).toEqual({ voltage: 20, power: 128, intensity: 50 });
  });

  test('normalizeLimits fills missing fields and clamps to hard caps', () => {
    expect(guard.normalizeLimits()).toEqual(DEFAULT_REMOTE_LIMITS);
    expect(guard.normalizeLimits({ voltage: 999, power: -5, intensity: 999 }))
      .toEqual({ voltage: 100, power: 0, intensity: 100 });
  });
});

describe('sanitizeProjectionMessage', () => {
  // 审查报告附录 B-1 复现：DGLAB 品牌字段原来原样透传。
  test('clamps dglab setPattern intensity and folds ticks:-1 to a finite max', () => {
    const result = sanitizeProjectionMessage({
      device: { type: 'DGLAB' },
      message: { brand: 'dglab', cmd: 'setPattern', pattern: '经典', intensity: 100, ticks: -1 },
      limits: {},
    });
    expect(result.ok).toBe(true);
    expect(result.message.intensity).toBe(DEFAULT_REMOTE_LIMITS.intensity);
    expect(result.message.ticks).toBe(guard.MAX_DGLAB_TICKS);
    expect(result.message.pattern).toBe('经典');
  });

  test('clamps dglab setEstim intensity by the owner limit', () => {
    const result = sanitizeProjectionMessage({
      device: { type: 'DGLAB' },
      message: { brand: 'dglab', cmd: 'setEstim', channel: 'a', intensity: 255, wave: '呼吸' },
      limits: { intensity: 30 },
    });
    expect(result).toEqual({
      ok: true,
      message: { brand: 'dglab', cmd: 'setEstim', channel: 'A', intensity: 30, wave: '呼吸' },
    });
  });

  // 审查报告附录 B-2 复现：DIANJI voltage 999 原样出。
  test('clamps DIANJI voltage 999 to the owner voltage cap', () => {
    const result = sanitizeProjectionMessage({
      device: { type: 'DIANJI' },
      message: { method: 'update', voltage: 999, shock: 1 },
      limits: { voltage: 20 },
    });
    expect(result).toEqual({ ok: true, message: { method: 'update', voltage: 20, shock: 1 } });
  });

  // 审查报告附录 B-2 复现：SOSEXY setShock voltage 999 原样出。
  test('clamps SOSEXY setShock voltage 999', () => {
    const result = sanitizeProjectionMessage({
      device: { type: 'SOSEXY_PID0004' },
      message: { brand: 'sosexy', cmd: 'setShock', voltage: 999 },
      limits: {},
    });
    expect(result).toEqual({ ok: true, message: { brand: 'sosexy', cmd: 'setShock', voltage: 20 } });
  });

  test('clamps YCY value/intensity and TD01 power', () => {
    expect(sanitizeProjectionMessage({
      device: { type: 'YCY_EMS' },
      message: { brand: 'ycy', cmd: 'setStrength', channel: 'AB', value: 200 },
      limits: {},
    })).toEqual({ ok: true, message: { brand: 'ycy', cmd: 'setStrength', channel: 'AB', value: 50 } });
    expect(sanitizeProjectionMessage({
      device: { type: 'TD01' },
      message: { method: 'update', power: 999 },
      limits: {},
    })).toEqual({ ok: true, message: { method: 'update', power: 128 } });
    expect(sanitizeProjectionMessage({
      device: { type: 'PJ01' },
      message: { method: 'update', power: 999 },
      limits: { power: 255 },
    })).toEqual({ ok: true, message: { method: 'update', power: 255 } });
  });

  test('voltage and intensity caps both apply to electric outputs', () => {
    // voltage 100 / intensity 10 → 电刺激刻度取更小者。
    expect(sanitizeProjectionMessage({
      device: { type: 'DIANJI' },
      message: { method: 'update', voltage: 90 },
      limits: { voltage: 100, intensity: 10 },
    })).toEqual({ ok: true, message: { method: 'update', voltage: 10 } });
  });

  test('unknown device type, command and field are rejected', () => {
    rejected(sanitizeProjectionMessage({
      device: { type: 'NOPE' },
      message: { method: 'update', power: 1 },
    }));
    rejected(sanitizeProjectionMessage({
      device: { type: 'DGLAB' },
      message: { brand: 'dglab', cmd: 'setMaxIntensity', delta: 100 },
    }));
    rejected(sanitizeProjectionMessage({
      device: { type: 'DGLAB' },
      message: { brand: 'unknown', cmd: 'setPattern', intensity: 1 },
    }));
    rejected(sanitizeProjectionMessage({
      device: { type: 'QIYA' },
      message: { method: 'update', voltage: 10 },
    }));
    rejected(sanitizeProjectionMessage({
      device: { type: 'DIANJI' },
      message: { method: 'action', action: 'mag_cal_start' },
    }));
    rejected(sanitizeProjectionMessage({
      device: { type: 'TD01' },
      message: { method: 'update' },
    }));
  });

  test('prototype-chain key names are rejected, never treated as a field spec', () => {
    // 键名是操作方给的 JSON：'__proto__'/'constructor' 会出现在 Object.entries 里，
    // 旧实现会取到原型上的函数并调用 → TypeError 冒泡成未捕获异常。
    rejected(sanitizeProjectionMessage({
      device: { type: 'TD01' },
      message: { method: 'update', constructor: 1 },
    }));
    rejected(sanitizeProjectionMessage({
      device: { type: '__proto__' },
      message: { method: 'update', power: 1 },
    }));
    rejected(sanitizeCapabilityInvoke({
      device: { type: 'TD01' }, capability: 'strength', action: 'set',
      input: { toString: 1 },
    }));
    rejected(sanitizeCapabilityInvoke({
      device: { type: 'YCY_TOY' }, capability: 'motors', action: 'set',
      input: { channels: { constructor: { value: 9 } } },
    }));
    expect(sanitizeProjectionMessage({
      device: { type: 'TD01' },
      message: { method: 'update', power: 999 },
    })).toEqual({ ok: true, message: { method: 'update', power: 128 } });
  });

  test('does not let a non-electric device receive electric commands', () => {
    rejected(sanitizeProjectionMessage({
      device: { type: 'YCY_TOY' },
      message: { brand: 'ycy', cmd: 'setStrength', value: 100 },
    }));
    rejected(sanitizeProjectionMessage({
      device: { type: 'ZIDONGSUO' },
      message: { brand: 'dglab', cmd: 'setPattern', intensity: 100 },
    }));
  });

  test('stop commands always pass and drop extra fields', () => {
    expect(sanitizeProjectionMessage({
      device: { type: 'DGLAB' },
      message: { brand: 'dglab', cmd: 'stopPattern', intensity: 100 },
    })).toEqual({ ok: true, message: { brand: 'dglab', cmd: 'stopPattern' } });
    expect(sanitizeProjectionMessage({
      device: { type: 'DIANJI' },
      message: { method: 'update', shock: 0, voltage: 0 },
    })).toEqual({ ok: true, message: { method: 'update', shock: 0, voltage: 0 } });
    expect(sanitizeProjectionMessage({
      device: { type: 'ZIDONGSUO' },
      message: { method: 'update', open: 1 },
    })).toEqual({ ok: true, message: { method: 'update', open: 1 } });
    expect(sanitizeProjectionMessage({
      device: { type: 'YCY_ENEMA' },
      message: { brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'stop' },
    })).toEqual({ ok: true, message: { brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'stop' } });
  });

  test('clamps pump duration and multi-channel motors', () => {
    expect(sanitizeProjectionMessage({
      device: { type: 'YCY_ENEMA' },
      message: { brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'guan', ss: 9999, rate: 500 },
      limits: {},
    })).toEqual({
      ok: true,
      message: { brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'guan', ss: 60, rate: 255 },
    });
    expect(sanitizeProjectionMessage({
      device: { type: 'YCY_TOY' },
      message: { brand: 'ycy', cmd: 'setMotors', channels: { a: 255 } },
      limits: { power: 255 },
    })).toEqual({
      ok: true,
      message: { brand: 'ycy', cmd: 'setMotors', channels: { a: { value: 20 } } },
    });
    rejected(sanitizeProjectionMessage({
      device: { type: 'YCY_TOY' },
      message: { brand: 'ycy', cmd: 'setMotors', channels: { z: 10 } },
    }));
  });
});

describe('sanitizeCapabilityInvoke', () => {
  test('clamps DIANJI shock voltage and TD01 strength', () => {
    expect(sanitizeCapabilityInvoke({
      device: { type: 'DIANJI' }, capability: 'shock', action: 'start', input: { voltage: 999 }, limits: {},
    })).toEqual({ ok: true, input: { voltage: 20 } });
    expect(sanitizeCapabilityInvoke({
      device: { type: 'TD01' }, capability: 'strength', action: 'set', input: { value: 255 }, limits: {},
    })).toEqual({ ok: true, input: { value: 128 } });
    expect(sanitizeCapabilityInvoke({
      device: { type: 'SOSEXY_PID0004' }, capability: 'shock', action: 'start', input: { voltage: 999 }, limits: {},
    })).toEqual({ ok: true, input: { voltage: 20 } });
  });

  test('rejects unknown capability, action and input fields', () => {
    rejected(sanitizeCapabilityInvoke({
      device: { type: 'DIANJI' }, capability: 'strength', action: 'set', input: { value: 1 },
    }));
    rejected(sanitizeCapabilityInvoke({
      device: { type: 'DIANJI' }, capability: 'shock', action: 'launch', input: {},
    }));
    rejected(sanitizeCapabilityInvoke({
      device: { type: 'DIANJI' }, capability: 'shock', action: 'start', input: { voltage: 10, tickle: 1 },
    }));
    rejected(sanitizeCapabilityInvoke({
      device: { type: 'NOPE' }, capability: 'shock', action: 'start', input: {},
    }));
  });

  test('stop actions always pass and drop unknown fields', () => {
    expect(sanitizeCapabilityInvoke({
      device: { type: 'DIANJI' }, capability: 'shock', action: 'stop', input: { weird: 1 },
    })).toEqual({ ok: true, input: {} });
    expect(sanitizeCapabilityInvoke({
      device: { type: 'TD01' }, capability: 'strength', action: 'stop', input: {},
    })).toEqual({ ok: true, input: {} });
  });

  test('allows locks and reporting controls', () => {
    expect(sanitizeCapabilityInvoke({
      device: { type: 'ZIDONGSUO' }, capability: 'lock', action: 'setOpen', input: { open: true },
    })).toEqual({ ok: true, input: { open: 1 } });
    expect(sanitizeCapabilityInvoke({
      device: { type: 'QIYA' }, capability: 'reporting', action: 'setReportDelay', input: { ms: 999999 },
    })).toEqual({ ok: true, input: { ms: guard.MAX_REPORT_DELAY_MS } });
  });
});

describe('latch detection', () => {
  test('electric outputs latch for 10s', () => {
    expect(isLatchedOutput({
      device: { type: 'DIANJI' }, capability: 'shock', action: 'start', input: { voltage: 10 },
    })).toEqual({ latched: true, maxMs: 10000 });
    expect(isLatchedProjectionMessage({
      device: { type: 'DGLAB' },
      message: { brand: 'dglab', cmd: 'setPattern', intensity: 50, ticks: -1 },
    })).toEqual({ latched: true, maxMs: 10000 });
    expect(isLatchedProjectionMessage({
      device: { type: 'SOSEXY_PID0004' },
      message: { brand: 'sosexy', cmd: 'setShock', voltage: 10 },
    })).toEqual({ latched: true, maxMs: 10000 });
  });

  test('motors, vibration and pumps latch for 60s', () => {
    expect(isLatchedOutput({
      device: { type: 'TD01' }, capability: 'strength', action: 'set', input: { value: 100 },
    })).toEqual({ latched: true, maxMs: 60000 });
    expect(isLatchedProjectionMessage({
      device: { type: 'SOSEXY_PID0004' },
      message: { brand: 'sosexy', cmd: 'setVibration', value: 50 },
    })).toEqual({ latched: true, maxMs: 60000 });
    expect(isLatchedProjectionMessage({
      device: { type: 'YCY_ENEMA' },
      message: { brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'guan' },
    })).toEqual({ latched: true, maxMs: 60000 });
  });

  test('stops, zero writes and locks are not latched', () => {
    expect(isLatchedOutput({
      device: { type: 'DIANJI' }, capability: 'shock', action: 'stop', input: {},
    })).toEqual({ latched: false, maxMs: 0 });
    expect(isLatchedProjectionMessage({
      device: { type: 'DGLAB' }, message: { brand: 'dglab', cmd: 'stopPattern' },
    })).toEqual({ latched: false, maxMs: 0 });
    expect(isLatchedProjectionMessage({
      device: { type: 'DIANJI' }, message: { method: 'update', shock: 0, voltage: 0 },
    })).toEqual({ latched: false, maxMs: 0 });
    expect(isLatchedProjectionMessage({
      device: { type: 'TD01' }, message: { method: 'update', power: 0 },
    })).toEqual({ latched: false, maxMs: 0 });
    expect(isLatchedOutput({
      device: { type: 'ZIDONGSUO' }, capability: 'lock', action: 'setOpen', input: { open: true },
    })).toEqual({ latched: false, maxMs: 0 });
    expect(isLatchedProjectionMessage({
      device: { type: 'YCY_ENEMA' }, message: { brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'stop' },
    })).toEqual({ latched: false, maxMs: 0 });
  });
});

describe('createOutputWatchdog', () => {
  function fakeTimers() {
    const timers = new Map();
    let nextId = 0;
    return {
      setTimer: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
      clearTimer: (id) => { timers.delete(id); },
      fire(delay) {
        for (const [id, timer] of [...timers]) {
          if (timer.delay !== delay) continue;
          timers.delete(id);
          timer.fn();
        }
      },
      pending: () => timers.size,
    };
  }

  test('arms, re-arms and fires stopDevice', async () => {
    const timers = fakeTimers();
    const stopped = [];
    const watchdog = createOutputWatchdog({
      stopDevice: async (deviceId) => { stopped.push(deviceId); },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    watchdog.arm('dev-1', 10000);
    expect([...watchdog.touched()]).toEqual(['dev-1']);
    watchdog.arm('dev-1', 60000);
    expect(timers.pending()).toBe(1);
    timers.fire(60000);
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toEqual(['dev-1']);
    expect([...watchdog.touched()]).toEqual([]);
  });

  test('clear cancels and stopAll stops every touched device', async () => {
    const timers = fakeTimers();
    const stopped = [];
    const watchdog = createOutputWatchdog({
      stopDevice: async (deviceId) => { stopped.push(deviceId); },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    watchdog.arm('dev-1', 10000);
    watchdog.arm('dev-2', 60000);
    watchdog.clear('dev-1');
    expect([...watchdog.touched()]).toEqual(['dev-2']);

    const result = await watchdog.stopAll();
    expect(result.stopped).toEqual(['dev-2']);
    expect(stopped).toEqual(['dev-2']);
    expect([...watchdog.touched()]).toEqual([]);
  });

  test('stopDevice failures do not reject stopAll', async () => {
    const watchdog = createOutputWatchdog({
      stopDevice: async () => { throw new Error('offline'); },
    });
    watchdog.arm('dev-1', 10);
    await expect(watchdog.stopAll()).resolves.toMatchObject({ failed: 1 });
  });
});

describe('isStopProjectionMessage (host local play window)', () => {
  const stop = (device, message) => guard.isStopProjectionMessage({ device, message });

  test('accepts stop / zero writes as stop commands', () => {
    expect(stop({ type: 'DIANJI' }, { method: 'update', shock: 0, voltage: 0 })).toBe(true);
    expect(stop({ type: 'TD01' }, { method: 'update', power: 0 })).toBe(true);
    expect(stop({ type: 'DGLAB' }, { brand: 'dglab', cmd: 'stopPattern' })).toBe(true);
    expect(stop({ type: 'DGLAB' }, { brand: 'dglab', cmd: 'stop' })).toBe(true);
    // 脏字段的停止帧仍然算停止：投影安全层会丢弃多余字段再下发
    expect(stop({ type: 'ZIDONGSUO' }, { method: 'update', open: 0, bogus: 1 })).toBe(true);
    // 泵的 scene:'stop' 是停止路径
    expect(stop({ type: 'YCY_ENEMA' }, { brand: 'ycy', cmd: 'pump', scene: 'stop' })).toBe(true);
  });

  test('rejects outputs, unknown devices and non-update frames', () => {
    expect(stop({ type: 'DIANJI' }, { method: 'update', shock: 1 })).toBe(false);
    expect(stop({ type: 'TD01' }, { method: 'update', power: 30 })).toBe(false);
    expect(stop({ type: 'DGLAB' }, { brand: 'dglab', cmd: 'setPattern', intensity: 5 })).toBe(false);
    expect(stop({ type: 'YCY_ENEMA' }, { brand: 'ycy', cmd: 'pump', scene: 'guan' })).toBe(false);
    expect(stop({ type: 'UNKNOWN' }, { method: 'update', power: 0 })).toBe(false);
    expect(stop({ type: 'TD01' }, { method: 'report', power: 0 })).toBe(false);
    expect(stop({ type: 'TD01' }, null)).toBe(false);
  });
});
