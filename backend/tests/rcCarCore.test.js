// 遥控车分离式核心（backend/games/rc-car/game-core.js）单测。
// 覆盖：姿态解码/转角、校准、前进后退判定、停止与按住超时、点按/按住转向、
// 升降档与电压封顶、手动电击、IMU 断线、提肛/寸止附加规则、seed 事件、参数校验、resolver 加载。
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RcCarCore,
  PARAMS,
  decodeInt16Hex,
  decodeQuat,
  yawDeltaDeg,
} = require('../games/rc-car/game-core');
const { GameCoreResolver } = require('../game-runtime/gameCoreResolver');

const CORE_DIR = path.resolve(__dirname, '..', 'games', 'rc-car');
const CORE_PATH = path.join(CORE_DIR, 'game-core.js');
const ACCEL_SCALE = 0.00478515625;
const GYRO_SCALE = 0.0625;
const STEP_MS = 50;
const CALIB_END_MS = 3000;

// ---- 合成数据 ----

function int16Hex(values) {
  return values.map((raw) => {
    const rounded = Math.round(raw);
    const unsigned = ((rounded % 65536) + 65536) % 65536;
    const low = (unsigned & 0xff).toString(16).padStart(2, '0');
    const high = ((unsigned >> 8) & 0xff).toString(16).padStart(2, '0');
    return low + high;
  }).join('');
}

function vecHex(values, scale) {
  return int16Hex(values.map((value) => value / scale));
}

// 绕世界 Z 轴旋转 deg 度的四元数（w, x, y, z → 小端 int16 hex）
function quatHex(deg) {
  const half = (deg * Math.PI) / 360;
  return int16Hex([Math.cos(half) * 32767, 0, 0, Math.sin(half) * 32767]);
}

function prop(name, value, seed) {
  return {
    type: 'device-property',
    role: name === 'pressure' ? 'sensor' : 'imu',
    deviceId: 'dev-1',
    name,
    value,
    oldValue: null,
    ...(seed ? { seed: true } : {}),
  };
}

function imuEvents(sample) {
  const rows = [
    prop('quat', quatHex(sample.deg || 0)),
    prop('accel', vecHex(sample.accel || [0, 0, 9.8], ACCEL_SCALE)),
    prop('gyro', vecHex(sample.gyro || [0, 0, 0.2], GYRO_SCALE)),
  ];
  if (sample.pressure != null) rows.push(prop('pressure', sample.pressure));
  return rows;
}

function still(extra = {}) {
  return { deg: 0, accel: [0, 0, 9.8], gyro: [0, 0, 0.2], pressure: null, ...extra };
}

// 爬行：竖直方向起伏（|accel| 标准差约 1.8 m/s²）+ 明显角速度
function crawling(t, extra = {}) {
  const wave = Math.sin(t / 100);
  return {
    deg: 0,
    accel: [0, 0, 9.8 + 2.5 * wave],
    gyro: [0, 45 * wave, 0],
    pressure: null,
    ...extra,
  };
}

// ---- 驱动 ----

function stepLoop(core, fromMs, toMs, sampleAt, opts = {}) {
  const runs = [];
  for (let t = fromMs; t <= toMs; t += STEP_MS) {
    if (opts.refill && t >= opts.refill.nextAt) {
      core.action('press', { cmd: opts.refill.cmd, seq: 1 }, t);
      opts.refill.nextAt = t + 400;
    }
    const sample = sampleAt ? sampleAt(t) : null;
    const result = core.step({ nowMs: t, events: sample ? imuEvents(sample) : [] });
    runs.push({ ts: t, result });
  }
  return runs;
}

function effectsOf(runs, type) {
  const out = [];
  for (const run of runs) {
    for (const effect of run.result.effects || []) {
      if (effect.type === type) out.push({ ts: run.ts, ...effect });
    }
  }
  return out;
}

function promptsOf(runs, fromSeq = 0) {
  const out = [];
  let last = fromSeq;
  for (const run of runs) {
    const prompt = run.result.snapshot.prompt;
    if (prompt && prompt.seq > last) {
      out.push({ ts: run.ts, ...prompt });
      last = prompt.seq;
    }
  }
  return out;
}

function calibrated(params, options = {}) {
  const core = new RcCarCore({ params: params || {} });
  core.start(0);
  const pressure = options.pressure == null ? null : options.pressure;
  stepLoop(core, 50, CALIB_END_MS, () => still({ pressure }));
  return core;
}

// ---- 解码与转角 ----

describe('姿态解码与转角（纯函数）', () => {
  test('decodeInt16Hex 按小端 int16 × 比例解码，非法输入返回 null', () => {
    expect(decodeInt16Hex('0008', 1, ACCEL_SCALE)).toEqual([9.8]);
    expect(decodeInt16Hex('4006', 1, GYRO_SCALE)).toEqual([100]);
    expect(decodeInt16Hex('ffff', 1, 1)).toEqual([-1]);
    expect(decodeInt16Hex('zzzz', 1, 1)).toBeNull();
    expect(decodeInt16Hex('00', 1, 1)).toBeNull();
    expect(decodeInt16Hex('000800', 1, 1)).toBeNull();
  });

  test('decodeQuat 归一化四元数，零四元数返回 null', () => {
    const identity = decodeQuat('ff7f000000000000');
    expect(identity.w).toBeCloseTo(1, 4);
    expect(identity.x).toBeCloseTo(0, 6);
    const turned = decodeQuat(quatHex(90));
    expect(turned.w).toBeCloseTo(Math.SQRT1_2, 3);
    expect(turned.z).toBeCloseTo(Math.SQRT1_2, 3);
    expect(decodeQuat('0000000000000000')).toBeNull();
  });

  test('yawDeltaDeg：左转正、右转负、四元数取反按最短弧、大于 90° 忽略', () => {
    const axis = [0, 0, 1];
    const q0 = decodeQuat(quatHex(0));
    expect(yawDeltaDeg(q0, decodeQuat(quatHex(10)), axis)).toBeCloseTo(10, 2);
    expect(yawDeltaDeg(q0, decodeQuat(quatHex(-10)), axis)).toBeCloseTo(-10, 2);
    const flipped = { w: -q0.w, x: -q0.x, y: -q0.y, z: -q0.z };
    expect(yawDeltaDeg(flipped, decodeQuat(quatHex(10)), axis)).toBeCloseTo(10, 2);
    expect(yawDeltaDeg(q0, decodeQuat(quatHex(120)), axis)).toBeNull();
  });
});

// ---- 开局与校准 ----

describe('开局与校准', () => {
  test('start 下发 imu 上报间隔与 shock-stop，校准结束进入 STOPPED', () => {
    const core = new RcCarCore();
    const started = core.start(0);
    expect(started.ok).toBe(true);
    expect(started.effects).toEqual([
      { type: 'device.set-report-delay', role: 'imu', ms: 50 },
      { type: 'device.shock-stop', role: 'punish' },
    ]);
    expect(started.snapshot.phase).toBe('CALIBRATING');
    expect(started.snapshot.prompt).toEqual({ key: 'calib_start', seq: 1 });
    const runs = stepLoop(core, 50, CALIB_END_MS, () => still());
    const snap = runs[runs.length - 1].result.snapshot;
    expect(snap.phase).toBe('STOPPED');
    expect(snap.prompt.key).toBe('calib_done');
    expect(snap.stats.violations).toBe(0);
    expect(snap.stats.shocks).toBe(0);
    expect(snap.motion.accelStd).toBeLessThan(0.1);
    expect(snap.sensorOnline).toBe(true);
  });

  test('校准期间有动作：不判违规，重新校准并再次提示保持不动', () => {
    const core = new RcCarCore();
    core.start(0);
    core.step({ nowMs: 1, events: [...imuEvents(crawling(1)), prop('pressure', 2, true)] });
    stepLoop(core, 50, CALIB_END_MS, (t) => crawling(t, { pressure: 2 }));
    let snap = core.snapshot();
    expect(snap.phase).toBe('CALIBRATING');
    expect(snap.calibRetries).toBeGreaterThan(0);
    expect(snap.prompt.key).toBe('calib_start');
    expect(snap.stats.violations).toBe(0);
    expect(snap.stats.shocks).toBe(0);
    // 静下来后满 calibSec（外加 1s 动作窗口清空）才完成，基线来自静止样本
    stepLoop(core, CALIB_END_MS + 50, CALIB_END_MS + 5000, () => still({ pressure: 2 }));
    snap = core.snapshot();
    expect(snap.phase).toBe('STOPPED');
    expect(snap.motion.moving).toBe(false);
  });

  test('校准后补发的 seed 压力不立刻判违规', () => {
    const core = calibrated({ addonMode: 1, pelvicDelta: 3, pelvicGraceSec: 0.5 }, { pressure: 10 });
    const result = core.step({ nowMs: 3100, events: [prop('pressure', 2, true)] });
    expect(result.snapshot.stats.violations).toBe(0);
    expect(effectsOf([{ ts: 3100, result }], 'device.shock')).toEqual([]);
    expect(result.snapshot.addon.pressure).toBe(2);
  });

  test('重复 start 被拒绝，非法时间返回 INVALID_TIME', () => {
    const core = calibrated();
    expect(core.start(10).code).toBe('ALREADY_RUNNING');
    expect(new RcCarCore().start(Number.NaN).code).toBe('INVALID_TIME');
    expect(core.step({ nowMs: undefined }).code).toBe('INVALID_TIME');
  });
});

// ---- 前进 / 后退 ----

describe('前进 / 后退', () => {
  test('按住前进并持续爬行：不判违规，保持在 MOVING', () => {
    const core = calibrated();
    const pressed = core.action('press', { cmd: 'forward' }, 3500);
    const baseSeq = pressed.snapshot.prompt.seq;
    const runs = stepLoop(core, 3550, 7600, (t) => crawling(t), {
      refill: { cmd: 'forward', nextAt: 3900 },
    });
    const snap = core.snapshot();
    expect(snap.phase).toBe('MOVING');
    expect(snap.command).toMatchObject({ cmd: 'forward', held: true, status: 'ok' });
    expect(snap.stats.violations).toBe(0);
    expect(effectsOf(runs, 'device.shock')).toEqual([]);
    expect(promptsOf(runs, baseSeq).map((row) => row.key)).toEqual([]);
  });

  test('按下后过了反应时间仍不动：no-start 违规并按档位电击', () => {
    const core = calibrated();
    const pressed = core.action('press', { cmd: 'forward' }, 3500);
    const baseSeq = pressed.snapshot.prompt.seq;
    const runs = stepLoop(core, 3550, 6600, () => still(), {
      refill: { cmd: 'forward', nextAt: 3900 },
    });
    const shocks = effectsOf(runs, 'device.shock');
    expect(shocks).toHaveLength(1);
    expect(shocks[0]).toMatchObject({ role: 'punish', voltage: 10, durationMs: 1000 });
    const snap = core.snapshot();
    expect(snap.lastViolation.reason).toBe('no-start');
    expect(snap.level).toBe(2);
    expect(snap.stats.violations).toBe(1);
    expect(promptsOf(runs, baseSeq).map((row) => row.key)).toEqual(['violation']);
  });

  test('爬行但朝向偏离超过容差：off-heading 违规', () => {
    const core = calibrated();
    core.action('press', { cmd: 'forward' }, 3500);
    stepLoop(core, 3550, 6500, (t) => crawling(t), { refill: { cmd: 'forward', nextAt: 3900 } });
    expect(core.snapshot().stats.violations).toBe(0);
    // 6500 的第一次判定通过（deadline → 7500），随后边走边转向 60°
    const runs = stepLoop(core, 6550, 8600, (t) => crawling(t, { deg: (t - 6500) * 0.03 }), {
      refill: { cmd: 'forward', nextAt: 6900 },
    });
    expect(core.snapshot().lastViolation.reason).toBe('off-heading');
    expect(effectsOf(runs, 'device.shock')).toHaveLength(1);
  });

  test('后退与前进同判定，只是口令不同', () => {
    const core = calibrated();
    const pressed = core.action('press', { cmd: 'backward' }, 3500);
    expect(pressed.snapshot.prompt.key).toBe('cmd_backward');
    expect(pressed.snapshot.phase).toBe('MOVING');
    const runs = stepLoop(core, 3550, 4500, (t) => crawling(t), { refill: { cmd: 'backward', nextAt: 3900 } });
    expect(core.snapshot().stats.violations).toBe(0);
    expect(effectsOf(runs, 'device.shock')).toEqual([]);
  });

  test('新指令取代旧指令：旧指令不算完成也不算违规，发新口令', () => {
    const core = calibrated();
    core.action('press', { cmd: 'forward' }, 3500);
    stepLoop(core, 3550, 4500, (t) => crawling(t), { refill: { cmd: 'forward', nextAt: 3900 } });
    const switched = core.action('press', { cmd: 'left' }, 4550);
    expect(switched.snapshot.prompt.key).toBe('cmd_left');
    expect(switched.snapshot.phase).toBe('TURNING');
    expect(switched.snapshot.stats.commands).toBe(2);
    expect(switched.snapshot.stats.completed).toBe(0);
    expect(switched.snapshot.stats.violatedCommands).toBe(0);
  });
});

// ---- 转向 ----

describe('转向', () => {
  test('点按左转，反应时间内转过 25°：完成并回到 STOPPED', () => {
    const core = calibrated();
    core.action('press', { cmd: 'left' }, 3500);
    const released = core.action('release', { cmd: 'left' }, 3900);
    // 转向松手不算「停」，不发 cmd_stop
    expect(released.snapshot.prompt.key).toBe('cmd_left');
    const runs = stepLoop(core, 3950, 6600, (t) => still({ deg: t < 5500 ? (t - 3500) * 0.0125 : 25 }));
    const snap = core.snapshot();
    expect(snap.stats.commands).toBe(1);
    expect(snap.stats.completed).toBe(1);
    expect(snap.stats.violations).toBe(0);
    expect(snap.phase).toBe('STOPPED');
    expect(snap.command).toBeNull();
    expect(snap.heading).toBeCloseTo(25, 0);
    expect(effectsOf(runs, 'device.shock')).toEqual([]);
  });

  test('点按右转超时：turn-timeout 违规', () => {
    const core = calibrated();
    core.action('press', { cmd: 'right' }, 3500);
    core.action('release', { cmd: 'right' }, 3900);
    const runs = stepLoop(core, 3950, 6600, () => still());
    const snap = core.snapshot();
    expect(snap.lastViolation.reason).toBe('turn-timeout');
    expect(snap.stats.completed).toBe(0);
    expect(snap.level).toBe(2);
    expect(snap.phase).toBe('STOPPED');
    expect(effectsOf(runs, 'device.shock')).toHaveLength(1);
  });

  test('turnInvert 翻转左右：同一物理转向下左转失败、右转完成', () => {
    const leftCore = calibrated({ turnInvert: true });
    leftCore.action('press', { cmd: 'left' }, 3500);
    leftCore.action('release', { cmd: 'left' }, 3900);
    stepLoop(leftCore, 3950, 6600, (t) => still({ deg: t < 5500 ? (t - 3500) * 0.0125 : 25 }));
    expect(leftCore.snapshot().lastViolation.reason).toBe('turn-timeout');

    const rightCore = calibrated({ turnInvert: true });
    rightCore.action('press', { cmd: 'right' }, 3500);
    rightCore.action('release', { cmd: 'right' }, 3900);
    stepLoop(rightCore, 3950, 6600, (t) => still({ deg: t < 5500 ? (t - 3500) * 0.0125 : 25 }));
    expect(rightCore.snapshot().stats.completed).toBe(1);
    expect(rightCore.snapshot().stats.violations).toBe(0);
  });

  test('按住转向：每个窗口都要转够，第一个窗口成功、第二个窗口超时', () => {
    const core = calibrated();
    core.action('press', { cmd: 'left' }, 3500);
    stepLoop(core, 3550, 6500, (t) => still({ deg: Math.min(25, (t - 3500) * 0.0125) }), {
      refill: { cmd: 'left', nextAt: 3900 },
    });
    expect(core.snapshot().phase).toBe('TURNING');
    expect(core.snapshot().stats.violations).toBe(0);
    const runs = stepLoop(core, 6550, 9500, () => still({ deg: 25 }), {
      refill: { cmd: 'left', nextAt: 6900 },
    });
    const snap = core.snapshot();
    expect(snap.lastViolation.reason).toBe('turn-timeout');
    expect(snap.stats.commands).toBe(1);
    expect(snap.stats.violations).toBe(1);
    expect(snap.phase).toBe('TURNING');
    expect(snap.command.held).toBe(true);
    expect(effectsOf(runs, 'device.shock')).toHaveLength(1);
  });
});

// ---- 停止 / 按住超时 ----

describe('停止与按住超时', () => {
  test('松开前进立刻发 cmd_stop，缓冲后保持静止不判违规', () => {
    const core = calibrated();
    core.action('press', { cmd: 'forward' }, 3500);
    stepLoop(core, 3550, 6000, (t) => crawling(t), { refill: { cmd: 'forward', nextAt: 3900 } });
    const released = core.action('release', { cmd: 'forward' }, 6050);
    expect(released.snapshot.prompt.key).toBe('cmd_stop');
    expect(released.snapshot.phase).toBe('STOPPED');
    expect(released.snapshot.command).toBeNull();
    const runs = stepLoop(core, 6100, 8300, () => still());
    expect(core.snapshot().stats.violations).toBe(0);
    expect(effectsOf(runs, 'device.shock')).toEqual([]);
  });

  test('松开后仍继续爬：缓冲结束判 not-stopped', () => {
    const core = calibrated();
    core.action('press', { cmd: 'forward' }, 3500);
    stepLoop(core, 3550, 6000, (t) => crawling(t), { refill: { cmd: 'forward', nextAt: 3900 } });
    core.action('release', { cmd: 'forward' }, 6050);
    const runs = stepLoop(core, 6100, 8300, (t) => crawling(t));
    expect(core.snapshot().lastViolation.reason).toBe('not-stopped');
    expect(effectsOf(runs, 'device.shock')).toHaveLength(1);
  });

  test('1200ms 没收到重发按松开处理', () => {
    const core = calibrated();
    const pressed = core.action('press', { cmd: 'forward' }, 3500);
    const runs = stepLoop(core, 3550, 6600, (t) => (t <= 4600 ? crawling(t) : still()));
    expect(promptsOf(runs, pressed.snapshot.prompt.seq).map((row) => row.key)).toContain('cmd_stop');
    const snap = core.snapshot();
    expect(snap.command).toBeNull();
    expect(snap.phase).toBe('STOPPED');
    expect(snap.stats.violations).toBe(0);
  });
});

// ---- 档位 / 电压 / 手动电击 / 结束 ----

describe('档位与惩罚', () => {
  test('违规升档，连续完成 deescalateAfter 条后降档', () => {
    const core = calibrated({ deescalateAfter: 2, reactionSec: 2 });
    // 两次转向超时 → 2 档、3 档
    core.action('press', { cmd: 'right' }, 3500);
    core.action('release', { cmd: 'right' }, 3600);
    stepLoop(core, 3650, 5600, () => still());
    expect(core.snapshot().level).toBe(2);
    core.action('press', { cmd: 'right' }, 5650);
    core.action('release', { cmd: 'right' }, 5750);
    stepLoop(core, 5800, 7700, () => still());
    expect(core.snapshot().level).toBe(3);

    // 两条左转点按完成 → 降到 2 档（同一秒内完成第 2 条时发 level_down）
    core.action('press', { cmd: 'left' }, 7800);
    core.action('release', { cmd: 'left' }, 7900);
    stepLoop(core, 7950, 9900, (t) => still({ deg: t < 8200 ? (t - 7800) * 0.025 : 25 }));
    expect(core.snapshot().level).toBe(3);
    expect(core.snapshot().compliantStreak).toBe(1);
    core.action('press', { cmd: 'left' }, 9950);
    core.action('release', { cmd: 'left' }, 10050);
    stepLoop(core, 10100, 12000, (t) => still({ deg: t < 10350 ? 25 + (t - 9950) * 0.025 : 50 }));
    const snap = core.snapshot();
    expect(snap.level).toBe(2);
    expect(snap.prompt.key).toBe('level_down');
    expect(snap.stats.commands).toBe(4);
    expect(snap.stats.completed).toBe(2);
    expect(snap.stats.violations).toBe(2);
    expect(snap.stats.compliance).toBe(50);
  });

  test('电压封顶 maxVoltage，档位不超过 maxLevel', () => {
    const core = calibrated({ shockVoltage: 10, voltageStep: 10, maxVoltage: 20, reactionSec: 1 });
    core.action('press', { cmd: 'forward' }, 3500);
    const runs = stepLoop(core, 3550, 9600, () => still(), {
      refill: { cmd: 'forward', nextAt: 3900 },
    });
    const shocks = effectsOf(runs, 'device.shock');
    expect(shocks).toHaveLength(6);
    expect(shocks.map((row) => row.voltage)).toEqual([10, 20, 20, 20, 20, 20]);
    const snap = core.snapshot();
    expect(snap.maxLevel).toBe(2);
    expect(snap.level).toBe(2);
    expect(snap.voltage).toBe(20);
  });

  test('手动电击：按当前档位、1 秒冷却；暂停中可用；未运行拒绝', () => {
    const core = calibrated();
    const first = core.action('shock', {}, 4000);
    expect(first.effects).toEqual([
      { type: 'device.shock', role: 'punish', voltage: 10, durationMs: 1000 },
    ]);
    const cooling = core.action('shock', {}, 4500);
    expect(cooling.effects).toEqual([]);
    const second = core.action('shock', {}, 5000);
    expect(second.effects).toHaveLength(1);
    core.pause(5100);
    const paused = core.action('shock', {}, 6200);
    expect(paused.effects).toHaveLength(1);
    core.stop(7000, 'manual');
    expect(core.action('shock', {}, 7100).code).toBe('NOT_RUNNING');
    expect(core.snapshot().stats.manualShocks).toBe(3);
  });

  test('到时结束：endReason=time、prompt game_end、shock-stop', () => {
    const core = new RcCarCore({ params: { durationMin: 0.1 } });
    core.start(0);
    const runs = stepLoop(core, 50, 6100, () => still());
    const snap = core.snapshot();
    expect(snap.running).toBe(false);
    expect(snap.ended).toBe(true);
    expect(snap.endReason).toBe('time');
    expect(snap.prompt.key).toBe('game_end');
    expect(snap.remainingMs).toBe(0);
    expect(effectsOf(runs, 'device.shock-stop').length).toBeGreaterThanOrEqual(1);
  });

  test('stop 使用给定 endReason，并停止所有判定', () => {
    const core = calibrated();
    const stopped = core.stop(5000, 'operator');
    expect(stopped.snapshot.ended).toBe(true);
    expect(stopped.snapshot.endReason).toBe('operator');
    expect(stopped.snapshot.prompt.key).toBe('game_end');
    const later = core.step({ nowMs: 9000, events: imuEvents(crawling(9000)) });
    expect(later.snapshot.stats.violations).toBe(0);
  });
});

// ---- 断线与唤醒 ----

describe('IMU 断线与唤醒', () => {
  test('IMU 超过 2 秒无数据：sensor_lost，暂停判定不电击', () => {
    const core = calibrated();
    core.action('press', { cmd: 'forward' }, 3500);
    stepLoop(core, 3550, 4200, (t) => crawling(t), { refill: { cmd: 'forward', nextAt: 3900 } });
    const runs = stepLoop(core, 4250, 7000, () => null);
    const snap = core.snapshot();
    expect(snap.sensorOnline).toBe(false);
    expect(snap.prompt.key).toBe('sensor_lost');
    expect(snap.stats.violations).toBe(0);
    expect(effectsOf(runs, 'device.shock')).toEqual([]);
  });

  test('nextWakeAtMs 指向最近的截止时间，暂停时为 null', () => {
    const core = new RcCarCore();
    const started = core.start(0);
    expect(started.nextWakeAtMs).toBe(CALIB_END_MS);
    stepLoop(core, 50, CALIB_END_MS, () => still());
    const pressed = core.action('press', { cmd: 'forward' }, 3500);
    // 按住重发超时 3500+1200 比反应截止 6500 更早
    expect(pressed.nextWakeAtMs).toBe(4700);
    core.pause(3600);
    expect(core.step({ nowMs: 3700, events: [] }).nextWakeAtMs).toBeNull();
  });
});

// ---- 附加规则：提肛 ----

describe('附加规则：提肛', () => {
  test('压力高于基线+增量：ok，不判违规', () => {
    const core = calibrated({ addonMode: 1, pelvicDelta: 3, pelvicGraceSec: 1 }, { pressure: 10 });
    core.action('press', { cmd: 'forward' }, 3500);
    const runs = stepLoop(core, 3550, 5000, (t) => crawling(t, { pressure: 20 }), {
      refill: { cmd: 'forward', nextAt: 3900 },
    });
    const snap = core.snapshot();
    expect(snap.addon).toMatchObject({ mode: 1, baseline: 10, target: 13, ok: true });
    expect(snap.stats.violations).toBe(0);
    expect(effectsOf(runs, 'device.shock')).toEqual([]);
  });

  test('压力掉下去先 pelvic_remind，宽限后判 pelvic 并电击', () => {
    const core = calibrated({ addonMode: 1, pelvicDelta: 3, pelvicGraceSec: 1 }, { pressure: 10 });
    core.action('press', { cmd: 'forward' }, 3500);
    stepLoop(core, 3550, 4500, (t) => crawling(t, { pressure: 20 }), {
      refill: { cmd: 'forward', nextAt: 3900 },
    });
    const baseSeq = core.snapshot().prompt.seq;
    const runs = stepLoop(core, 4550, 7000, (t) => crawling(t, { pressure: 8 }), {
      refill: { cmd: 'forward', nextAt: 4900 },
    });
    const keys = promptsOf(runs, baseSeq).map((row) => row.key);
    // 本段内先提醒、后违规（prompt 可能被 violation 覆盖，seq 仍递增）
    const snap = core.snapshot();
    expect(snap.lastViolation.reason).toBe('pelvic');
    expect(snap.addon.ok).toBe(false);
    // 第一次违规后再给一个宽限，持续不达标会再判一次
    expect(snap.stats.violations).toBeGreaterThanOrEqual(2);
    expect(effectsOf(runs, 'device.shock').length).toBeGreaterThanOrEqual(2);
    expect(snap.logs.some((row) => row.message.includes('提肛压力低于目标'))).toBe(true);
    expect(keys).toContain('pelvic_remind');
    expect(keys).toContain('violation');
  });

  test('pelvicOnlyMoving：静止低压力不判，开始移动后才提醒并判违规', () => {
    const core = calibrated(
      { addonMode: 1, pelvicDelta: 3, pelvicGraceSec: 0.5, pelvicOnlyMoving: true },
      { pressure: 10 },
    );
    const idleBaseSeq = core.snapshot().prompt.seq;
    const idleRuns = stepLoop(core, 3100, 6000, () => still({ pressure: 5 }));
    expect(core.snapshot().stats.violations).toBe(0);
    expect(promptsOf(idleRuns, idleBaseSeq).map((row) => row.key)).not.toContain('pelvic_remind');
    core.action('press', { cmd: 'forward' }, 6100);
    const baseSeq = core.snapshot().prompt.seq;
    const runs = stepLoop(core, 6150, 7200, (t) => crawling(t, { pressure: 5 }), {
      refill: { cmd: 'forward', nextAt: 6500 },
    });
    const snap = core.snapshot();
    expect(snap.lastViolation.reason).toBe('pelvic');
    const keys = promptsOf(runs, baseSeq).map((row) => row.key);
    expect(keys).toContain('pelvic_remind');
    expect(keys).toContain('violation');
    expect(snap.logs.some((row) => row.message.includes('提肛压力低于目标'))).toBe(true);
  });

  test('附加规则没有 sensor 数据：校准后等 2 秒记警告，addon.ok=null 不电', () => {
    const core = calibrated({ addonMode: 1, pelvicDelta: 3 });
    expect(core.snapshot().addon.ok).toBeNull();
    const runs = stepLoop(core, 3100, 5600, () => still());
    const snap = core.snapshot();
    expect(snap.addon.ok).toBeNull();
    expect(snap.stats.violations).toBe(0);
    expect(snap.logs.some((row) => row.level === 'warn' && row.message.includes('缺少括约肌压力'))).toBe(true);
    expect(effectsOf(runs, 'device.shock')).toEqual([]);
  });
});

// ---- 附加规则：寸止 ----

describe('附加规则：寸止', () => {
  test('到临界电一次并锁存，回落到中间值以下才重新武装', () => {
    const core = calibrated({ addonMode: 2, edgingMid: 8, edgingCritical: 15 }, { pressure: 5 });
    const midRuns = stepLoop(core, 3100, 3500, () => still({ pressure: 10 }));
    expect(core.snapshot().addon).toMatchObject({ mode: 2, edgingPhase: 'MIDDLE', ok: true });
    expect(effectsOf(midRuns, 'device.shock')).toEqual([]);

    const baseSeq = core.snapshot().prompt.seq;
    const edgeRuns = stepLoop(core, 3550, 3900, () => still({ pressure: 16 }));
    expect(core.snapshot().addon.edgingPhase).toBe('EDGING');
    expect(core.snapshot().addon.ok).toBe(false);
    expect(effectsOf(edgeRuns, 'device.shock')).toHaveLength(1);
    expect(core.snapshot().level).toBe(1); // 寸止是附加规则，不升档
    expect(promptsOf(edgeRuns, baseSeq).map((row) => row.key)).toContain('edging_peak');

    const highRuns = stepLoop(core, 3950, 4400, () => still({ pressure: 18 }));
    expect(effectsOf(highRuns, 'device.shock')).toEqual([]); // 锁存中，不重复电

    const calmRuns = stepLoop(core, 4450, 4700, () => still({ pressure: 7 }));
    expect(core.snapshot().addon.edgingPhase).toBe('CALM');
    expect(effectsOf(calmRuns, 'device.shock')).toEqual([]);

    const againRuns = stepLoop(core, 4750, 5100, () => still({ pressure: 16 }));
    expect(effectsOf(againRuns, 'device.shock')).toHaveLength(1);
    expect(core.snapshot().stats.violations).toBe(2);
    expect(core.snapshot().lastViolation.reason).toBe('edging');
  });
});

// ---- 参数 ----

describe('参数', () => {
  test('PARAMS 的键与默认值符合接口约定', () => {
    const defaults = {};
    for (const spec of PARAMS) defaults[spec.key] = spec.default;
    expect(defaults).toEqual({
      durationMin: 15,
      reactionSec: 3,
      turnDeg: 20,
      calibSec: 3,
      voiceEnabled: true,
      motionAccelStd: 0.8,
      motionGyroDps: 20,
      headingTolerance: 35,
      stopGraceSec: 1.5,
      shockVoltage: 10,
      voltageStep: 5,
      maxVoltage: 40,
      shockDurationMs: 1000,
      escalation: true,
      deescalateAfter: 5,
      addonMode: 0,
      pelvicDelta: 3,
      pelvicGraceSec: 2,
      pelvicOnlyMoving: false,
      edgingMid: 8,
      edgingCritical: 15,
      turnInvert: false,
    });
    for (const spec of PARAMS) {
      expect(spec.label).toBeTruthy();
      expect(spec.group).toBeTruthy();
      expect(['number', 'boolean']).toContain(spec.type);
      if (spec.type === 'number') {
        expect(spec.min).toBeLessThanOrEqual(spec.default);
        expect(spec.max).toBeGreaterThanOrEqual(spec.default);
      }
    }
  });

  test('setParams 严格校验（INVALID_PARAMS），边界只钳制不取整', () => {
    const core = new RcCarCore();
    expect(core.setParams(null).code).toBe('INVALID_PARAMS');
    expect(core.setParams({ reactionSec: 'abc' }).code).toBe('INVALID_PARAMS');
    expect(core.setParams({ turnInvert: 'yes' }).code).toBe('INVALID_PARAMS');
    expect(core.setParams({}).ok).toBe(true);
    expect(core.setParams({ reactionSec: 2, turnInvert: true, reactionSec2: 1 }).ok).toBe(true);
    expect(core.cfg.reactionSec).toBe(2);
    expect(core.cfg.turnInvert).toBe(true);
    const clamped = core.setParams({ reactionSec: 99, turnDeg: 1, addonMode: 9, durationMin: -5 });
    expect(clamped.ok).toBe(true);
    expect(core.cfg.reactionSec).toBe(10);
    expect(core.cfg.turnDeg).toBe(5);
    expect(core.cfg.addonMode).toBe(2);
    expect(core.cfg.durationMin).toBe(0);
  });

  test('构造参数不严格：非法值回落默认，越界值钳制', () => {
    const core = new RcCarCore({ params: { reactionSec: 'x', turnInvert: 'yes', shockDurationMs: 99999 } });
    expect(core.cfg.reactionSec).toBe(3);
    expect(core.cfg.turnInvert).toBe(false);
    expect(core.cfg.shockDurationMs).toBe(5000);
  });
});

// ---- resolver 加载 ----

describe('gameCoreResolver 加载', () => {
  const tempDirs = [];

  afterAll(() => {
    for (const dir of tempDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  test('导出形式满足 resolver（唯一 *Core 命名导出 + 必备方法）', () => {
    const mod = require('../games/rc-car/game-core');
    const coreKeys = Object.keys(mod).filter((key) => /Core$/.test(key));
    expect(coreKeys).toEqual(['RcCarCore']);
    for (const method of ['start', 'step', 'snapshot', 'pause', 'resume', 'stop', 'setParams', 'action']) {
      expect(typeof RcCarCore.prototype[method]).toBe('function');
    }
  });

  test('宿主按包内 manifest 加载 rc-car 核心并实例化', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-car-core-'));
    tempDirs.push(root);
    const dir = path.join(root, 'rc-car');
    fs.mkdirSync(dir, { recursive: true });
    const manifest = {
      id: 'rc-car',
      title: '遥控车',
      version: '1.0.0',
      runtime: 'host',
      events: 'v2',
      core: 'game-core.js',
      devices: [
        { id: 'imu', label: '姿态', capabilities: ['attitude'], required: true },
        { id: 'punish', label: '电击', capabilities: ['shock'], required: true },
        { id: 'sensor', label: '压力', capabilities: ['sphincterPressure'], required: false },
      ],
      params: PARAMS,
    };
    const html = `<!doctype html><html><body><script type="application/json" id="game-manifest">${JSON.stringify(manifest)}</script></body></html>`;
    fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
    fs.copyFileSync(CORE_PATH, path.join(dir, 'game-core.js'));
    const row = {
      id: 'rc-car',
      title: '遥控车',
      version: '1.0.0',
      folder: 'rc-car',
      gamePath: '/games/rc-car/index.html',
    };
    const resolver = new GameCoreResolver({
      getGameById: (id) => (id === 'rc-car' ? row : null),
      listGames: () => [row],
      getGameRoot: () => root,
      getCacheRoot: () => path.join(root, 'cache'),
      now: () => 0,
    });
    expect(resolver.isHostGame('rc-car')).toBe(true);
    const core = resolver.createCore('rc-car');
    expect(core.snapshot().gameId).toBe('rc-car');
    const started = core.start(0);
    expect(started.ok).toBe(true);
    expect(started.snapshot.phase).toBe('CALIBRATING');
  });

  // 真实游戏包由页面子任务并行编写：文件可能还没写完（manifest 不完整/JSON 非法），
  // 这种情况下跳过并给出明确说明，而不是把别人的中间状态算成核心回归。
  const realIndex = path.join(CORE_DIR, 'index.html');
  let realManifest = null;
  try {
    const html = fs.readFileSync(realIndex, 'utf8');
    const match = html.match(/<script[^>]*\bid\s*=\s*["\']game-manifest["\'][^>]*>([\s\S]*?)<\/script>/i);
    if (match) realManifest = JSON.parse(match[1]);
  } catch (_) {
    realManifest = null;
  }
  const realCase = realManifest ? test : test.skip;
  realCase(
    realManifest
      ? '真实游戏包 backend/games/rc-car 可被 resolver 加载，参数键与核心一致'
      : '真实游戏包 index.html 尚未完成（manifest 缺失或不是合法 JSON），跳过 resolver 真实包加载测试',
    () => {
      expect(realManifest.id).toBe('rc-car');
      expect(realManifest.runtime).toBe('host');
      expect(realManifest.events).toBe('v2');
      const manifestKeys = (realManifest.params || []).map((spec) => spec.key).sort();
      const coreKeys = PARAMS.map((spec) => spec.key).sort();
      expect(manifestKeys).toEqual(coreKeys);
      const resolver = require('../game-runtime/gameCoreResolver');
      resolver.clearCache();
      const core = resolver.createCore('rc-car');
      expect(core.snapshot().gameId).toBe('rc-car');
      expect(typeof core.start).toBe('function');
    },
  );
});

// ---- 暂停 ----

describe('暂停', () => {
  test('暂停期间不判定，继续后窗口重新起算，不按过期截止时间立刻电击', () => {
    const core = calibrated();
    core.action('press', { cmd: 'forward' }, 3500);
    core.pause(3600);
    // 暂停跨过原来的反应截止时间（6500），期间即使无动作也不判
    const pausedRuns = stepLoop(core, 3650, 7000, () => still());
    expect(core.snapshot().stats.violations).toBe(0);
    expect(effectsOf(pausedRuns, 'device.shock')).toEqual([]);
    // 继续后重新给 reactionSec，静止到 10000 才判 no-start
    core.resume(7050);
    expect(core.snapshot().paused).toBe(false);
    const runs = stepLoop(core, 7100, 10100, () => still(), {
      refill: { cmd: 'forward', nextAt: 7500 },
    });
    expect(core.snapshot().lastViolation.reason).toBe('no-start');
    expect(effectsOf(runs, 'device.shock')).toHaveLength(1);
  });
});

// ---- 评审修复（2026-10-27） ----

describe('评审修复', () => {
  test('按下前进 2 秒就松开且没动：中性，不算完成、不算违规、不降档', () => {
    const core = calibrated({ deescalateAfter: 1 });
    core.rt.level = 3;
    core.action('press', { cmd: 'forward' }, 3500);
    stepLoop(core, 3550, 5400, () => still(), { refill: { cmd: 'forward', nextAt: 3900 } });
    core.action('release', { cmd: 'forward' }, 5450);
    stepLoop(core, 5500, 8000, () => still());
    const snap = core.snapshot();
    expect(snap.stats.completed).toBe(0);
    expect(snap.stats.violations).toBe(0);
    expect(snap.stats.violatedCommands).toBe(0);
    expect(snap.level).toBe(3);
  });

  test('爬过判定后松开但还在爬：not-stopped 违规，不算完成', () => {
    const core = calibrated();
    core.action('press', { cmd: 'forward' }, 3500);
    stepLoop(core, 3550, 8000, (t) => crawling(t), { refill: { cmd: 'forward', nextAt: 3900 } });
    core.action('release', { cmd: 'forward' }, 8050);
    stepLoop(core, 8100, 10500, (t) => crawling(t));
    const snap = core.snapshot();
    expect(snap.lastViolation.reason).toBe('not-stopped');
    expect(snap.stats.completed).toBe(0);
    expect(snap.stats.violatedCommands).toBe(1);
    expect(snap.stats.compliance).toBe(0);
  });

  test('爬过判定后松开并停下：完成', () => {
    const core = calibrated();
    core.action('press', { cmd: 'forward' }, 3500);
    stepLoop(core, 3550, 8000, (t) => crawling(t), { refill: { cmd: 'forward', nextAt: 3900 } });
    core.action('release', { cmd: 'forward' }, 8050);
    stepLoop(core, 8100, 11000, () => still());
    const snap = core.snapshot();
    expect(snap.stats.completed).toBe(1);
    expect(snap.stats.violations).toBe(0);
    expect(snap.stats.compliance).toBe(100);
  });

  test('校准期间按方向键被忽略，校准照常完成', () => {
    const core = new RcCarCore();
    core.start(0);
    stepLoop(core, 50, 1000, () => still());
    const res = core.action('press', { cmd: 'left' }, 1050);
    expect(res.ok).toBe(true);
    expect(res.snapshot.phase).toBe('CALIBRATING');
    expect(res.snapshot.command).toBeNull();
    stepLoop(core, 1100, CALIB_END_MS + 100, () => still());
    expect(core.snapshot().phase).toBe('STOPPED');
  });

  test('校准期间 IMU 断线：顺延到恢复后再采满 calibSec', () => {
    const core = new RcCarCore();
    core.start(0);
    stepLoop(core, 50, 300, () => still());
    stepLoop(core, 350, 3000, () => null); // 断线
    expect(core.snapshot().sensorOnline).toBe(false);
    expect(core.snapshot().phase).toBe('CALIBRATING');
    stepLoop(core, 3050, 5000, () => still());
    expect(core.snapshot().phase).toBe('CALIBRATING');
    stepLoop(core, 5050, 6200, () => still());
    expect(core.snapshot().phase).toBe('STOPPED');
  });

  test('附加规则开启时开局把 sensor 上报间隔调到 100ms', () => {
    const core = new RcCarCore({ params: { addonMode: 1 } });
    const res = core.start(0);
    expect(res.effects).toContainEqual({ type: 'device.set-report-delay', role: 'sensor', ms: 100 });
    const off = new RcCarCore().start(0);
    expect(off.effects.filter((e) => e.role === 'sensor')).toHaveLength(0);
  });

  test('校准后才来的压力：收约 1 秒样本后定基线，提肛规则生效', () => {
    const core = calibrated({ addonMode: 1, pelvicDelta: 3, pelvicGraceSec: 1 });
    expect(core.snapshot().addon.state).toBe('waiting');
    stepLoop(core, 3050, 4500, () => still({ pressure: 5 }));
    let snap = core.snapshot();
    expect(snap.addon.state).toBe('active');
    expect(snap.addon.baseline).toBeCloseTo(5, 1);
    stepLoop(core, 4550, 7000, () => still({ pressure: 5 }));
    snap = core.snapshot();
    expect(snap.stats.violations).toBeGreaterThan(0);
    expect(snap.lastViolation.reason).toBe('pelvic');
  });

  test('一直没有压力数据：addon.state = no-sensor，不电击', () => {
    const core = calibrated({ addonMode: 1 });
    stepLoop(core, 3050, 7000, () => still());
    const snap = core.snapshot();
    expect(snap.addon.state).toBe('no-sensor');
    expect(snap.stats.shocks).toBe(0);
  });

  test('暂停中按方向键返回 PAUSED，手动电击仍可用', () => {
    const core = calibrated();
    core.pause(3100);
    const res = core.action('press', { cmd: 'forward' }, 3200);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('PAUSED');
    const shock = core.action('shock', {}, 3300);
    expect(shock.ok).toBe(true);
    expect(shock.effects.some((e) => e.type === 'device.shock')).toBe(true);
  });

  test('附加规则违规后，动作判定通过也不把指令状态改回 ok', () => {
    const core = calibrated();
    core.action('press', { cmd: 'forward' }, 3500);
    core.rt.command.violated = true;
    core.rt.command.status = 'violating';
    stepLoop(core, 3550, 7000, (t) => crawling(t), { refill: { cmd: 'forward', nextAt: 3900 } });
    expect(core.snapshot().command.status).toBe('violating');
  });

  test('参数组合：起始电压高于最高电压按最高算；每档增量 0 只有 1 档', () => {
    const a = new RcCarCore({ params: { shockVoltage: 50, maxVoltage: 20 } });
    a.start(0);
    expect(a.snapshot().maxLevel).toBe(1);
    expect(a.snapshot().voltage).toBe(20);
    const b = new RcCarCore({ params: { voltageStep: 0 } });
    b.start(0);
    expect(b.snapshot().maxLevel).toBe(1);
  });
});
