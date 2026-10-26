// 遥控车 — 分离式游戏核心（纯逻辑，宿主后端加载）
// 契约：docs/architecture/split-game-contract.md；设计：docs/plans/2026-10-26-rc-car-game.md；
// 规则：docs/adr/2026-10-26-rc-car-game-rules.md。
// 本文件不碰 DOM / 计时器 / 网络 / 文件；时间只来自 nowMs，随机只用注入的 random()（本玩法暂不用随机）。
//
// 事件（宿主 → 核心，manifest 声明 "events":"v2"）：
//   { type:'device-property', role:'imu', name:'quat'|'accel'|'gyro', value:'<hex>', seed? }
//   { type:'device-property', role:'sensor', name:'pressure'|'sphincterPressure', value:number, seed? }
// 宿主按属性名转发，同一设备映射到多个角色时 role 只带一个，所以这里按 name 判断（契约第 3 节）。
// 开局补发的事件带 seed:true：只作为基线/状态，不触发违规判定。
// 姿态解码移植 frontend/src/utils/dan01Attitude.ts：quat int16×1/32768 归一化，
// accel int16×0.00478515625 m/s²，gyro int16×0.0625 °/s，小端十六进制。

const GAME_ID = 'rc-car';
const VERSION = '1.0.0';
const TITLE = '遥控车';

const LOG_LIMIT = 20;
const MOTION_WINDOW_MS = 1000;      // 动作能量统计窗口
const HOLD_KEEPALIVE_MS = 1200;     // 按住指令重发超时（契约 1200ms）
const IMU_OFFLINE_MS = 2000;        // IMU 无数据多久视为离线
const SENSOR_WAIT_MS = 2000;        // 附加规则开启后等 sensor 数据的额外时长（calibSec 之后）
const MAX_YAW_JUMP_DEG = 90;        // 单帧转角超过这个值视为跳变，忽略
const GRAVITY_LP_ALPHA = 0.2;       // 传感器系加速度低通系数
const MAX_MOTION_SAMPLES = 240;     // 约 12 秒 @50ms
const MAX_CALIB_SAMPLES = 400;
const MANUAL_SHOCK_COOLDOWN_MS = 1000;
const QUAT_SCALE = 1 / 32768;
const ACCEL_SCALE = 0.00478515625;
const GYRO_SCALE = 0.0625;

const PHASE = {
  CALIBRATING: 'CALIBRATING',
  STOPPED: 'STOPPED',
  MOVING: 'MOVING',
  TURNING: 'TURNING',
};

const CMD_TEXT = {
  forward: '前进',
  backward: '后退',
  left: '左转',
  right: '右转',
};

const TURN_CMDS = new Set(['left', 'right']);
const CMD_SET = new Set(['forward', 'backward', 'left', 'right']);

// 与 index.html 内联 manifest 的 params 一致（键 / 默认值 / 边界）
const PARAMS = [
  { key: 'durationMin', type: 'number', default: 15, min: 0, max: 180, label: '游戏时长', unit: '分钟', group: 'core', description: '0 表示不限时' },
  { key: 'reactionSec', type: 'number', default: 3, min: 1, max: 10, label: '反应时间', unit: '秒', group: 'core', description: '按下后给多久起步；转向窗口长度' },
  { key: 'turnDeg', type: 'number', default: 20, min: 5, max: 90, label: '转向角度', unit: '°', group: 'core', description: '一个窗口内须累计转过的角度' },
  { key: 'calibSec', type: 'number', default: 3, min: 2, max: 10, label: '校准时长', unit: '秒', group: 'core', description: '开局保持静止采集基线的时长' },
  { key: 'voiceEnabled', type: 'boolean', default: true, label: '语音播报', group: 'core', description: '执行端是否播放口令语音' },
  { key: 'motionAccelStd', type: 'number', default: 0.8, min: 0.1, max: 5, label: '动作加速度阈值', unit: 'm/s²', group: 'difficulty', description: '加速度模长标准差超过基线多少算在动' },
  { key: 'motionGyroDps', type: 'number', default: 20, min: 2, max: 200, label: '动作角速度阈值', unit: '°/s', group: 'difficulty', description: '角速度均值超过基线多少算在动' },
  { key: 'headingTolerance', type: 'number', default: 35, min: 10, max: 90, label: '朝向容差', unit: '°', group: 'difficulty', description: '前进/后退时允许偏离起始朝向的角度' },
  { key: 'stopGraceSec', type: 'number', default: 1.5, min: 0.5, max: 5, label: '停止缓冲', unit: '秒', group: 'difficulty', description: '喊停后仍允许动的缓冲时间' },
  { key: 'shockVoltage', type: 'number', default: 10, min: 0, max: 100, label: '起始电压', unit: 'V', group: 'punish', description: '1 档电击电压' },
  { key: 'voltageStep', type: 'number', default: 5, min: 0, max: 50, label: '每档增量', unit: 'V', group: 'punish', description: '每升一档增加的电压' },
  { key: 'maxVoltage', type: 'number', default: 40, min: 0, max: 100, label: '最高电压', unit: 'V', group: 'punish', description: '电压上限，同时决定档位数量' },
  { key: 'shockDurationMs', type: 'number', default: 1000, min: 100, max: 5000, label: '电击时长', unit: 'ms', group: 'punish', description: '每次电击持续时间' },
  { key: 'escalation', type: 'boolean', default: true, label: '逐级加强', group: 'punish', description: '违规升档、连续完成降档' },
  { key: 'deescalateAfter', type: 'number', default: 5, min: 1, max: 50, label: '降档完成数', unit: '条', group: 'punish', description: '连续完成多少条指令降一档' },
  { key: 'addonMode', type: 'number', default: 0, min: 0, max: 2, label: '附加规则', group: 'addon', description: '0 无 / 1 提肛 / 2 寸止' },
  { key: 'pelvicDelta', type: 'number', default: 3, min: 0.5, max: 30, label: '提肛压力增量', unit: 'kPa', group: 'addon', description: '压力须高于基线多少' },
  { key: 'pelvicGraceSec', type: 'number', default: 2, min: 0.5, max: 10, label: '提肛宽限', unit: '秒', group: 'addon', description: '压力不达标多久判违规' },
  { key: 'pelvicOnlyMoving', type: 'boolean', default: false, label: '仅移动时要求', group: 'addon', description: '只在移动/转向时检查提肛压力' },
  { key: 'edgingMid', type: 'number', default: 8, min: 0, max: 100, label: '寸止中间压力', unit: 'kPa', group: 'addon', description: '达到即进入中段' },
  { key: 'edgingCritical', type: 'number', default: 15, min: 0, max: 150, label: '寸止临界压力', unit: 'kPa', group: 'addon', description: '达到即电击' },
  { key: 'turnInvert', type: 'boolean', default: false, label: '转向反向', group: 'advanced', description: '左右转向反了时打开' },
];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round1(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

function mean(rows) {
  if (!rows.length) return 0;
  return rows.reduce((sum, value) => sum + value, 0) / rows.length;
}

function stdDev(rows) {
  if (!rows.length) return 0;
  const avg = mean(rows);
  return Math.sqrt(mean(rows.map((value) => (value - avg) * (value - avg))));
}

function defaultParams() {
  const out = {};
  for (const spec of PARAMS) out[spec.key] = spec.default;
  return out;
}

function normalizeNumber(raw, spec) {
  const n = toFinite(raw);
  if (n == null) return null;
  // 与配置页一致只限制 min/max，不按步长取整
  return clamp(n, spec.min, spec.max);
}

// 移植 dan01Attitude.decodeInt16Hex：小端 int16 × 比例
function decodeInt16Hex(value, count, scale) {
  if (typeof value !== 'string' || value.length !== count * 4 || !/^[0-9a-f]+$/i.test(value)) {
    return null;
  }
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    const low = Number.parseInt(value.slice(offset, offset + 2), 16);
    const high = Number.parseInt(value.slice(offset + 2, offset + 4), 16);
    const unsigned = low | (high << 8);
    const signed = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
    result.push(signed * scale);
  }
  return result;
}

function decodeQuat(value) {
  const raw = decodeInt16Hex(value, 4, QUAT_SCALE);
  if (!raw) return null;
  const norm = Math.hypot(raw[0], raw[1], raw[2], raw[3]);
  if (!(norm > 0.0001)) return null;
  return { w: raw[0] / norm, x: raw[1] / norm, y: raw[2] / norm, z: raw[3] / norm };
}

// 兼容测试/调试直接给数组（已经是换算后的物理量）
function decodeVector(value, count, scale) {
  if (Array.isArray(value)) {
    if (value.length < count) return null;
    const nums = value.slice(0, count).map(Number);
    return nums.every(Number.isFinite) ? nums : null;
  }
  return decodeInt16Hex(value, count, scale);
}

function quatConj(q) {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

function quatMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function rotateVec(q, v) {
  const pure = { w: 0, x: v[0], y: v[1], z: v[2] };
  const out = quatMul(quatMul(q, pure), quatConj(q));
  return [out.x, out.y, out.z];
}

function normalize3(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (!(n > 1e-9)) return null;
  return [v[0] / n, v[1] / n, v[2] / n];
}

// 相邻两帧的世界系相对旋转（qNew * qPrev^-1）→ 旋转矢量在竖直轴上的投影，单位度。
// 四元数 w<0 时整体取反（最短弧），单帧跳变 > MAX_YAW_JUMP_DEG 返回 null（忽略）。
// 轴朝上（world +Z）时，正角度 = 从上往下看的逆时针 = 左转。
function yawDeltaDeg(qPrev, qNew, axis) {
  if (!qPrev || !qNew) return null;
  let dq = quatMul(qNew, quatConj(qPrev));
  if (dq.w < 0) dq = { w: -dq.w, x: -dq.x, y: -dq.y, z: -dq.z };
  const len = Math.hypot(dq.x, dq.y, dq.z);
  if (!(len > 1e-9)) return 0;
  const angle = 2 * Math.atan2(len, dq.w);
  const unit = normalize3(Array.isArray(axis) ? axis : [0, 0, 1]) || [0, 0, 1];
  const dot = (dq.x * unit[0] + dq.y * unit[1] + dq.z * unit[2]) / len;
  const delta = (angle * dot * 180) / Math.PI;
  if (Math.abs(delta) > MAX_YAW_JUMP_DEG) return null;
  return delta;
}

// 一句话：同一 tick 里只保留最重要的一条 prompt（violation > cmd_* > 其它），
// 但每次发 prompt 都会递增 seq，页面按 seq 变化决定是否播报。
function promptPriority(key) {
  if (key === 'violation') return 3;
  if (key.indexOf('cmd_') === 0) return 2;
  return 1;
}

class RcCarCore {
  constructor({ params, random } = {}) {
    this.random = typeof random === 'function' ? random : () => 0.5;
    this.cfg = defaultParams();
    // 开局参数不严格：单个非法值只回落默认值，不整体报错（契约：setParams 不崩）
    const initial = this._applyParams(params || {}, false);
    if (!initial.error) this.cfg = initial.values;
    this._effects = [];
    this._turnLogs = [];
    this._resetRuntime(0);
  }

  // ---- 生命周期 ----

  start(nowMs) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (this.rt.running) return this._fail('ALREADY_RUNNING', '游戏已在运行');
    this._resetRuntime(nowMs);
    const rt = this.rt;
    rt.running = true;
    rt.paused = false;
    rt.ended = false;
    rt.startedAtMs = nowMs;
    rt.endTimeMs = this.cfg.durationMin > 0 ? nowMs + this.cfg.durationMin * 60000 : 0;
    rt.phase = PHASE.CALIBRATING;
    rt.calibEndMs = nowMs + Math.max(1, this.cfg.calibSec) * 1000;
    rt.level = 1;
    rt.manualShockReadyAtMs = nowMs;
    this._effects.push({ type: 'device.set-report-delay', role: 'imu', ms: 50 });
    this._effects.push({ type: 'device.shock-stop', role: 'punish' });
    this._emitPrompt('calib_start', nowMs);
    this._log('info', '遥控车启动，校准请保持不动', nowMs);
    return this._ok(nowMs);
  }

  pause(nowMs) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._fail('NOT_RUNNING', '游戏未运行');
    if (this.rt.paused) return this._ok(nowMs);
    this.rt.paused = true;
    this._log('info', '已暂停', nowMs);
    return this._ok(nowMs);
  }

  resume(nowMs) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._fail('NOT_RUNNING', '游戏未运行');
    if (!this.rt.paused) return this._fail('NOT_PAUSED', '游戏未暂停');
    const rt = this.rt;
    rt.paused = false;
    // 暂停期间不计时：恢复后按当前状态重新起算窗口，避免一恢复就按过期的截止时间判违规。
    // 总时长（endTimeMs）与其他宿主核心一致，不顺延。
    rt.motionSamples = [];
    rt.addonBelowSinceMs = 0;
    if (rt.phase === PHASE.CALIBRATING) {
      rt.calibEndMs = nowMs + Math.max(1, this.cfg.calibSec) * 1000;
      rt.calibAccel = [];
      rt.calibGyro = [];
      rt.calibPressure = [];
    } else if (rt.command) {
      rt.command.windowRef = this._heading();
      rt.command.deadlineMs = nowMs + Math.max(0, this.cfg.reactionSec) * 1000;
      rt.command.status = 'pending';
      if (rt.command.held) rt.command.lastPressMs = nowMs;
    } else if (rt.phase === PHASE.STOPPED) {
      rt.stopCheckAtMs = nowMs + Math.max(0, this.cfg.stopGraceSec) * 1000;
    }
    this._log('info', '已继续', nowMs);
    return this._ok(nowMs);
  }

  stop(nowMs, reason = 'stop') {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._ok(nowMs);
    this._finish(nowMs, reason || 'stop');
    return this._ok(nowMs);
  }

  setParams(params) {
    this._beginTurn();
    if (!isPlainObject(params)) return this._fail('INVALID_PARAMS', '参数必须是对象');
    const previousDuration = this.cfg.durationMin;
    const previousMode = this.cfg.addonMode;
    const next = this._applyParams(params, true);
    if (next.error) return this._fail('INVALID_PARAMS', next.error);
    Object.assign(this.cfg, next.values);
    const rt = this.rt;
    if (rt.running && rt.endTimeMs && this.cfg.durationMin !== previousDuration) {
      // 与其它宿主 core 一致：运行中改时长顺延结束时间（0 表示不限时）
      if (this.cfg.durationMin > 0) rt.endTimeMs += (this.cfg.durationMin - previousDuration) * 60000;
      else rt.endTimeMs = 0;
    }
    rt.level = clamp(rt.level, 1, this._maxLevel());
    if (previousMode !== this.cfg.addonMode) this._resetAddon(rt.lastUpdateTs);
    this._log('info', '参数已更新', rt.lastUpdateTs);
    return this._ok(rt.lastUpdateTs);
  }

  action(name, payload, nowMs) {
    if (name === 'start') return this.start(nowMs);
    if (name === 'pause') return this.pause(nowMs);
    if (name === 'resume') return this.resume(nowMs);
    if (name === 'stop') return this.stop(nowMs, 'action');
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._fail('NOT_RUNNING', '游戏未运行');
    const data = isPlainObject(payload) ? payload : {};
    if (name === 'press') {
      const cmd = String(data.cmd || '');
      if (!CMD_SET.has(cmd)) return this._fail('INVALID_ACTION', '未知指令');
      this._onPress(nowMs, cmd);
    } else if (name === 'release') {
      const cmd = String(data.cmd || '');
      if (!CMD_SET.has(cmd)) return this._fail('INVALID_ACTION', '未知指令');
      this._onRelease(nowMs, cmd);
    } else if (name === 'shock') {
      this._manualShock(nowMs);
    } else if (name === 'recalibrate') {
      this._recalibrate(nowMs);
    } else {
      return this._fail('UNKNOWN_ACTION', '未知操作');
    }
    return this._ok(nowMs);
  }

  // 宿主每 80ms 调一次；设备事件会触发一次即时 step（同一步内出电击意图）
  step({ nowMs, events } = {}) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    const rows = Array.isArray(events) ? events : [];
    const hasEvents = rows.some((event) => !!event && typeof event === 'object');
    if (!this.rt.running) {
      if (hasEvents) this._log('debug', '游戏未运行，忽略设备事件', nowMs);
      return this._ok(nowMs);
    }
    if (hasEvents) this._applyEvents(nowMs, rows);
    this.rt.lastUpdateTs = nowMs;
    // 暂停：只记状态，不推进时间、不判定、不出电击
    if (!this.rt.paused) this._advance(nowMs);
    return this._ok(nowMs);
  }

  // 页面只渲染这份快照（键名按「接口约定 → snapshot」）
  snapshot() {
    const rt = this.rt;
    const nowMs = rt.lastUpdateTs || 0;
    const heading = this._heading();
    const motion = this._motionStats(nowMs);
    const command = rt.command
      ? {
        cmd: rt.command.cmd,
        held: !!rt.command.held,
        sinceMs: rt.command.sinceMs,
        deadlineMs: rt.command.deadlineMs,
        progressDeg: round1(this._commandProgress()),
        targetDeg: TURN_CMDS.has(rt.command.cmd) ? this.cfg.turnDeg : 0,
        status: rt.command.status,
      }
      : null;
    const headingRef = rt.command ? rt.command.headingRef : heading;
    const maxLevel = this._maxLevel();
    const stats = rt.stats;
    return {
      version: VERSION,
      gameId: GAME_ID,
      title: TITLE,
      running: !!rt.running,
      paused: !!rt.paused,
      ended: !!rt.ended,
      endReason: rt.endReason || '',
      phase: rt.phase,
      startedAtMs: rt.startedAtMs || 0,
      elapsedMs: rt.running || rt.ended ? Math.max(0, nowMs - (rt.startedAtMs || 0)) : 0,
      remainingMs: rt.endTimeMs ? (rt.ended ? 0 : Math.max(0, rt.endTimeMs - nowMs)) : null,
      command,
      heading: round1(heading),
      headingRef: round1(headingRef),
      headingDelta: round1(heading - headingRef),
      turnInvert: !!this.cfg.turnInvert,
      voiceEnabled: this.cfg.voiceEnabled !== false,
      motion,
      sensorOnline: !!rt.sensorOnline,
      raw: {
        quat: rt.quat ? { ...rt.quat } : null,
        accel: rt.accel ? rt.accel.slice() : null,
        gyro: rt.gyro ? rt.gyro.slice() : null,
      },
      level: rt.level,
      maxLevel,
      voltage: this._levelVoltage(),
      compliantStreak: rt.compliantStreak,
      stats: {
        commands: stats.commands,
        completed: stats.completed,
        violations: stats.violations,
        shocks: stats.shocks,
        manualShocks: stats.manualShocks,
        compliance: stats.commands ? Math.round((stats.completed / stats.commands) * 100) : 100,
      },
      addon: {
        mode: this.cfg.addonMode,
        pressure: rt.pressure == null ? null : round1(rt.pressure),
        // 基线：提肛/寸止都显示校准采样到的压力；target 按模式解释（提肛=基线+增量，寸止=临界值）
        baseline: this.cfg.addonMode === 0 || rt.baseline.pressure == null
          ? null
          : round1(rt.baseline.pressure),
        target: this._addonTarget(),
        ok: rt.addonOk,
        edgingPhase: this.cfg.addonMode === 2 ? rt.edgingPhase : null,
      },
      lastViolation: rt.lastViolation ? { ...rt.lastViolation } : null,
      prompt: rt.prompt ? { key: rt.prompt.key, seq: rt.prompt.seq } : null,
      manualShockReadyAtMs: rt.manualShockReadyAtMs || 0,
      // 宿主不转发 result.logs，页面要看到日志只能随快照下发（与 maid/surge 一致）
      logs: rt.logs.map((entry) => ({ ...entry })),
    };
  }

  // ---- 内部：回合框架 ----

  _beginTurn() {
    this._effects = [];
    this._turnLogs = [];
    this._turnPrompt = null;
    this._turnViolated = false;
  }

  _ok(nowMs) {
    if (Number.isFinite(nowMs)) this.rt.lastUpdateTs = nowMs;
    return {
      ok: true,
      snapshot: this.snapshot(),
      effects: this._effects.slice(),
      logs: this._turnLogs.slice(),
      nextWakeAtMs: this._nextWake(nowMs),
    };
  }

  _fail(code, message) {
    return {
      ok: false,
      code,
      message,
      snapshot: this.snapshot(),
      effects: [],
      logs: [],
      nextWakeAtMs: null,
    };
  }

  _applyParams(input, strict) {
    const values = strict ? {} : defaultParams();
    if (!input) return { values };
    for (const spec of PARAMS) {
      if (!Object.prototype.hasOwnProperty.call(input, spec.key)) continue;
      const raw = input[spec.key];
      if (spec.type === 'boolean') {
        if (typeof raw !== 'boolean') {
          if (!strict) continue; // 开局单个非法参数只回落默认值，不整体重置
          return { error: `${spec.key} 必须是布尔值` };
        }
        values[spec.key] = raw;
        continue;
      }
      const normalized = normalizeNumber(raw, spec);
      if (normalized == null) {
        if (!strict) continue;
        return { error: `${spec.key} 不是合法数字` };
      }
      values[spec.key] = normalized;
    }
    return { values: strict ? { ...this.cfg, ...values } : values };
  }

  _resetRuntime(nowMs) {
    this.rt = {
      running: false,
      paused: false,
      ended: false,
      endReason: '',
      startedAtMs: 0,
      endedAtMs: 0,
      endTimeMs: 0,
      lastUpdateTs: nowMs || 0,
      phase: PHASE.STOPPED,
      calibEndMs: 0,
      calibAccel: [],
      calibGyro: [],
      calibPressure: [],
      baseline: { accelStd: 0, gyroMean: 0, pressure: null },
      pressurePending: false,
      sensorWaitUntilMs: 0,
      sensorWarned: false,
      hasPressure: false,
      pressure: null,
      quat: null,
      accel: null,
      gyro: null,
      gravitySensor: null,
      vertical: [0, 0, 1],
      headingRaw: 0,
      hasImu: false,
      lastImuAtMs: 0,
      sensorOnline: false,
      motionSamples: [],
      command: null,
      stopCheckAtMs: 0,
      level: 1,
      compliantStreak: 0,
      stats: { commands: 0, completed: 0, violations: 0, shocks: 0, manualShocks: 0 },
      lastViolation: null,
      addonOk: null,
      addonBelowSinceMs: 0,
      addonPromptArmed: true,
      edgingPhase: null,
      edgingLatched: false,
      prompt: null,
      promptSeq: 0,
      manualShockReadyAtMs: 0,
      logs: [],
    };
  }

  _resetAddon(nowMs) {
    const rt = this.rt;
    rt.addonOk = null;
    rt.addonBelowSinceMs = 0;
    rt.addonPromptArmed = true;
    rt.edgingPhase = null;
    rt.edgingLatched = false;
    rt.pressurePending = this.cfg.addonMode === 1 && rt.baseline.pressure == null;
    rt.sensorWaitUntilMs = rt.pressurePending ? (nowMs || rt.lastUpdateTs || 0) + SENSOR_WAIT_MS : 0;
    rt.sensorWarned = false;
  }

  // 档位：1..maxLevel，电压封顶 maxVoltage；voltageStep 为 0 时按 1 算（避免除零）
  _maxLevel() {
    const step = Math.max(1, this.cfg.voltageStep);
    return Math.max(1, Math.floor((this.cfg.maxVoltage - this.cfg.shockVoltage) / step) + 1);
  }

  _levelVoltage() {
    const raw = this.cfg.shockVoltage + (this.rt.level - 1) * this.cfg.voltageStep;
    return Math.round(clamp(Math.min(raw, this.cfg.maxVoltage), 0, 100));
  }

  _pelvicTarget() {
    const baseline = this.rt.baseline.pressure;
    if (baseline == null) return null;
    return baseline + this.cfg.pelvicDelta;
  }

  // 快照里的 addon.target：模式 1 = 提肛目标压力，模式 2 = 寸止临界压力，0 = 无
  _addonTarget() {
    if (this.cfg.addonMode === 1) {
      const target = this._pelvicTarget();
      return target == null ? null : round1(target);
    }
    if (this.cfg.addonMode === 2) return round1(this.cfg.edgingCritical);
    return null;
  }

  // 朝向用「转向反向」参数翻转符号，判定与显示统一走这里
  _heading() {
    return this.cfg.turnInvert ? -this.rt.headingRaw : this.rt.headingRaw;
  }

  _commandProgress() {
    const c = this.rt.command;
    if (!c) return 0;
    if (!TURN_CMDS.has(c.cmd)) return 0;
    const dir = c.cmd === 'left' ? 1 : -1;
    return dir * (this._heading() - c.windowRef);
  }

  _log(level, message, atMs) {
    const entry = { level, message, atMs: Number.isFinite(atMs) ? atMs : this.rt.lastUpdateTs };
    this._turnLogs.push(entry);
    this.rt.logs.unshift(entry);
    if (this.rt.logs.length > LOG_LIMIT) this.rt.logs.length = LOG_LIMIT;
  }

  _emitPrompt(key, nowMs) {
    this.rt.promptSeq += 1;
    const entry = { key, seq: this.rt.promptSeq };
    const priority = promptPriority(key);
    // 同一 tick 只留最重要的一条；但 seq 仍然每次递增
    if (!this._turnPrompt || priority > this._turnPrompt.priority) {
      this._turnPrompt = { priority, entry };
      this.rt.prompt = entry;
    }
    return entry;
  }

  // 有截止时间的下一步：宿主可以据此提前唤醒（宿主自身仍按 80ms 定时 tick）
  _nextWake(nowMs) {
    const rt = this.rt;
    if (!rt.running || rt.paused) return null;
    const candidates = [];
    if (rt.endTimeMs) candidates.push(rt.endTimeMs);
    if (rt.phase === PHASE.CALIBRATING) candidates.push(rt.calibEndMs);
    if (rt.pressurePending && rt.sensorWaitUntilMs) candidates.push(rt.sensorWaitUntilMs);
    if (rt.command) {
      candidates.push(rt.command.deadlineMs);
      if (rt.command.held) candidates.push(rt.command.lastPressMs + HOLD_KEEPALIVE_MS);
    }
    if (rt.stopCheckAtMs) candidates.push(rt.stopCheckAtMs);
    if (this.cfg.addonMode === 1 && rt.addonBelowSinceMs) {
      candidates.push(rt.addonBelowSinceMs + Math.max(0, this.cfg.pelvicGraceSec) * 1000);
    }
    if (rt.hasImu && rt.sensorOnline) candidates.push(rt.lastImuAtMs + IMU_OFFLINE_MS);
    const future = candidates.filter((value) => Number.isFinite(value) && value > nowMs);
    return future.length ? Math.min(...future) : nowMs + 1000;
  }

  // ---- 内部：设备事件 ----

  _applyEvents(nowMs, events) {
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const type = String(event.type || '');
      const name = String(event.name || '');
      const seed = event.seed === true;
      if (type === 'sensor') {
        if (this._isPressureName(name)) this._onPressure(nowMs, toFinite(event.value), false);
        continue;
      }
      if (type !== 'device-property') continue;
      if (name === 'quat') this._onQuat(nowMs, event.value);
      else if (name === 'accel') this._onAccel(nowMs, event.value);
      else if (name === 'gyro') this._onGyro(nowMs, event.value);
      else if (this._isPressureName(name)) this._onPressure(nowMs, toFinite(event.value), seed);
    }
  }

  _isPressureName(name) {
    return name === 'pressure' || name === 'sphincterPressure';
  }

  _touchImu(nowMs) {
    this.rt.hasImu = true;
    this.rt.lastImuAtMs = nowMs;
  }

  // 竖直轴：把低通后的传感器系加速度转到世界系并归一化，作为「重力方向」；
  // 强制指向世界 +Z（DAN01 融合世界系 Z 向上），这样左转（俯视逆时针）为正。
  // 没有加速度时回落到世界 Z。
  _verticalAxis() {
    const rt = this.rt;
    if (rt.gravitySensor && rt.quat) {
      const world = rotateVec(rt.quat, rt.gravitySensor);
      const unit = normalize3(world);
      if (unit) return unit[2] < 0 ? [-unit[0], -unit[1], -unit[2]] : unit;
    }
    return [0, 0, 1];
  }

  _onQuat(nowMs, value) {
    const q = decodeQuat(value);
    if (!q) return;
    this._touchImu(nowMs);
    const rt = this.rt;
    const previous = rt.quat;
    rt.quat = q;
    // 竖直轴用「当前帧四元数 × 低通后的传感器系加速度」估计（世界系重力方向）
    const axis = this._verticalAxis();
    rt.vertical = axis;
    if (previous) {
      const delta = yawDeltaDeg(previous, q, axis);
      if (delta != null) rt.headingRaw += delta;
    }
  }

  _onAccel(nowMs, value) {
    const accel = decodeVector(value, 3, ACCEL_SCALE);
    if (!accel) return;
    this._touchImu(nowMs);
    const rt = this.rt;
    rt.accel = accel;
    if (!rt.gravitySensor) rt.gravitySensor = accel.slice();
    else {
      rt.gravitySensor = rt.gravitySensor.map((old, index) => old + GRAVITY_LP_ALPHA * (accel[index] - old));
    }
    rt.vertical = this._verticalAxis();
    const magnitude = Math.hypot(accel[0], accel[1], accel[2]);
    this._pushMotionSample(nowMs, magnitude, null);
    if (rt.phase === PHASE.CALIBRATING) {
      rt.calibAccel.push(magnitude);
      if (rt.calibAccel.length > MAX_CALIB_SAMPLES) rt.calibAccel.shift();
    }
  }

  _onGyro(nowMs, value) {
    const gyro = decodeVector(value, 3, GYRO_SCALE);
    if (!gyro) return;
    this._touchImu(nowMs);
    const rt = this.rt;
    rt.gyro = gyro;
    const magnitude = Math.hypot(gyro[0], gyro[1], gyro[2]);
    this._pushMotionSample(nowMs, null, magnitude);
    if (rt.phase === PHASE.CALIBRATING) {
      rt.calibGyro.push(magnitude);
      if (rt.calibGyro.length > MAX_CALIB_SAMPLES) rt.calibGyro.shift();
    }
  }

  _pushMotionSample(nowMs, accelMag, gyroMag) {
    const samples = this.rt.motionSamples;
    samples.push({ ts: nowMs, a: accelMag, g: gyroMag });
    if (samples.length > MAX_MOTION_SAMPLES) samples.splice(0, samples.length - MAX_MOTION_SAMPLES);
  }

  _onPressure(nowMs, value, seed) {
    if (value == null) return;
    const rt = this.rt;
    rt.pressure = value;
    rt.hasPressure = true;
    if (rt.phase === PHASE.CALIBRATING) {
      rt.calibPressure.push(value);
      if (rt.calibPressure.length > MAX_CALIB_SAMPLES) rt.calibPressure.shift();
    }
    // 附加规则等待基线：第一份压力当作基线（对齐页面版 readValue）
    if (rt.pressurePending && rt.baseline.pressure == null) {
      rt.baseline.pressure = value;
      rt.pressurePending = false;
      rt.sensorWaitUntilMs = 0;
      this._log('info', `提肛压力基线 ${round1(value)}kPa`, nowMs);
    }
    if (this.cfg.addonMode === 2) {
      rt.edgingPhase = this._edgingPhaseFor(value);
      // seed 不是变化：开局就已在临界以上时只锁存，不电击
      if (seed && rt.edgingPhase === 'EDGING') rt.edgingLatched = true;
    }
    if (seed) return;
    // 违规判定统一在 _advance 里推进（同一 tick 也走那里），这里只更新状态
  }

  // 动作能量：1 秒滑动窗口内的 |accel| 标准差与 |gyro| 均值。
  // 能量 0..1 = clamp(max(相对阈值的倍数) / 2, 0, 1)：刚到阈值是 0.5，两倍阈值饱和。
  _motionStats(nowMs) {
    const rt = this.rt;
    const cutoff = nowMs - MOTION_WINDOW_MS;
    const rows = rt.motionSamples.filter((row) => row.ts >= cutoff && row.ts <= nowMs);
    const accelRows = rows.map((row) => row.a).filter((value) => Number.isFinite(value));
    const gyroRows = rows.map((row) => row.g).filter((value) => Number.isFinite(value));
    const accelStd = stdDev(accelRows);
    const gyroMean = gyroRows.length ? mean(gyroRows) : 0;
    const baseline = rt.baseline;
    const ratioA = (accelStd - baseline.accelStd) / Math.max(0.01, this.cfg.motionAccelStd);
    const ratioG = (gyroMean - baseline.gyroMean) / Math.max(0.01, this.cfg.motionGyroDps);
    const moving = accelStd > baseline.accelStd + this.cfg.motionAccelStd
      || gyroMean > baseline.gyroMean + this.cfg.motionGyroDps;
    return {
      energy: Math.round(clamp(Math.max(ratioA, ratioG) / 2, 0, 1) * 100) / 100,
      moving,
      accelStd: Math.round(accelStd * 1000) / 1000,
      gyroMean: Math.round(gyroMean * 100) / 100,
    };
  }

  _edgingPhaseFor(pressure) {
    const mid = this.cfg.edgingMid;
    const critical = Math.max(this.cfg.edgingCritical, mid + 0.1);
    if (pressure < mid) return 'CALM';
    if (pressure < critical) return 'MIDDLE';
    return 'EDGING';
  }

  // ---- 内部：推进 ----

  _advance(nowMs) {
    const rt = this.rt;
    if (!rt.running) return;
    if (rt.endTimeMs && nowMs >= rt.endTimeMs) {
      this._finish(nowMs, 'time');
      return;
    }
    this._updateSensorOnline(nowMs);
    if (rt.phase === PHASE.CALIBRATING) {
      if (nowMs < rt.calibEndMs) return;
      this._finishCalibration(nowMs);
    }
    this._checkAddonDeadline(nowMs);
    this._checkKeepalive(nowMs);
    // IMU 离线：暂停全部判定与附加规则，只保留 A 端的按住超时处理
    if (!rt.sensorOnline) return;
    this._updateAddon(nowMs);
    this._judge(nowMs);
  }

  _updateSensorOnline(nowMs) {
    const rt = this.rt;
    const online = rt.hasImu && (nowMs - rt.lastImuAtMs) <= IMU_OFFLINE_MS;
    if (rt.sensorOnline && !online) {
      this._emitPrompt('sensor_lost', nowMs);
      this._log('warn', 'IMU 数据中断，暂停判定', nowMs);
      this._pushMotionSample(nowMs, null, null); // 断档：避免旧样本继续算在动
      rt.motionSamples = [];
      rt.addonBelowSinceMs = 0;
      rt.stopCheckAtMs = 0;
    } else if (!rt.sensorOnline && online) {
      // 恢复后重新给缓冲/窗口，避免刚上线就按过期截止时间判违规
      rt.motionSamples = [];
      if (rt.phase === PHASE.MOVING && rt.command) {
        rt.command.deadlineMs = nowMs + Math.max(0, this.cfg.reactionSec) * 1000;
      } else if (rt.phase === PHASE.TURNING && rt.command) {
        rt.command.windowRef = this._heading();
        rt.command.deadlineMs = nowMs + Math.max(0, this.cfg.reactionSec) * 1000;
      } else if (rt.phase === PHASE.STOPPED) {
        rt.stopCheckAtMs = nowMs + Math.max(0, this.cfg.stopGraceSec) * 1000;
      }
      rt.addonBelowSinceMs = 0;
      this._log('info', 'IMU 数据恢复', nowMs);
    }
    rt.sensorOnline = online;
  }

  _finishCalibration(nowMs) {
    const rt = this.rt;
    rt.baseline.accelStd = stdDev(rt.calibAccel);
    rt.baseline.gyroMean = rt.calibGyro.length ? mean(rt.calibGyro) : 0;
    if (rt.calibPressure.length) rt.baseline.pressure = mean(rt.calibPressure);
    rt.calibAccel = [];
    rt.calibGyro = [];
    rt.calibPressure = [];
    rt.phase = PHASE.STOPPED;
    this._enterStopped(nowMs);
    this._emitPrompt('calib_done', nowMs);
    this._log('info', `校准完成（加速度基线 ${round1(rt.baseline.accelStd)}，角速度基线 ${round1(rt.baseline.gyroMean)}）`, nowMs);
    if (this.cfg.addonMode !== 0 && !rt.hasPressure) {
      rt.pressurePending = true;
      rt.sensorWaitUntilMs = nowMs + SENSOR_WAIT_MS;
      rt.sensorWarned = false;
      this._log('info', '附加规则等待括约肌压力数据…', nowMs);
    }
  }

  _checkAddonDeadline(nowMs) {
    const rt = this.rt;
    if (!rt.pressurePending) return;
    if (rt.hasPressure) {
      rt.pressurePending = false;
      rt.sensorWaitUntilMs = 0;
      return;
    }
    if (rt.sensorWaitUntilMs && nowMs >= rt.sensorWaitUntilMs) {
      rt.pressurePending = false;
      rt.sensorWarned = true;
      rt.addonOk = null;
      this._log('warn', '附加规则缺少括约肌压力数据，暂不判定（不会电击）', nowMs);
    }
  }

  _updateAddon(nowMs) {
    const rt = this.rt;
    if (this.cfg.addonMode === 1) return this._updatePelvic(nowMs);
    if (this.cfg.addonMode === 2) return this._updateEdging(nowMs);
    rt.addonOk = null;
    rt.addonBelowSinceMs = 0;
  }

  _updatePelvic(nowMs) {
    const rt = this.rt;
    const target = this._pelvicTarget();
    if (target == null || rt.pressure == null) {
      rt.addonOk = null;
      rt.addonBelowSinceMs = 0;
      return;
    }
    const ok = rt.pressure >= target;
    rt.addonOk = ok;
    if (ok) {
      rt.addonBelowSinceMs = 0;
      rt.addonPromptArmed = true;
      return;
    }
    const eligible = !this.cfg.pelvicOnlyMoving
      || rt.phase === PHASE.MOVING
      || rt.phase === PHASE.TURNING;
    if (!eligible) {
      rt.addonBelowSinceMs = 0; // 不在要求时段：不累计宽限
      return;
    }
    if (!rt.addonBelowSinceMs) {
      rt.addonBelowSinceMs = nowMs;
      if (rt.addonPromptArmed) {
        this._emitPrompt('pelvic_remind', nowMs);
        rt.addonPromptArmed = false;
        this._log('info', `提肛压力低于目标 ${round1(target)}kPa`, nowMs);
      }
    }
    if (nowMs - rt.addonBelowSinceMs >= Math.max(0, this.cfg.pelvicGraceSec) * 1000) {
      this._violate(nowMs, 'pelvic');
      rt.addonBelowSinceMs = nowMs; // 再宽限一轮，持续不达标就继续判
    }
  }

  _updateEdging(nowMs) {
    const rt = this.rt;
    if (rt.pressure == null) {
      rt.addonOk = null;
      rt.edgingPhase = null;
      return;
    }
    const phase = this._edgingPhaseFor(rt.pressure);
    rt.edgingPhase = phase;
    rt.addonOk = phase !== 'EDGING';
    if (phase === 'EDGING') {
      if (!rt.edgingLatched) {
        rt.edgingLatched = true;
        // 寸止到临界电一次；这是附加规则，不升档（文档化的设计决定）
        this._violate(nowMs, 'edging', { escalate: false, prompt: 'edging_peak' });
      }
    } else if (phase === 'CALM') {
      rt.edgingLatched = false; // 回落到中间值以下才重新武装
    }
  }

  _violate(nowMs, reason, options = {}) {
    const rt = this.rt;
    rt.stats.violations += 1;
    rt.lastViolation = { reason, atMs: nowMs };
    rt.compliantStreak = 0;
    if (rt.command) {
      rt.command.status = 'violating';
      rt.command.violated = true;
    }
    this._emitPrompt(options.prompt || 'violation', nowMs);
    if (this._turnViolated) {
      this._log('warn', `同一时刻多条违规，合并为一次电击（${reason}）`, nowMs);
      return;
    }
    this._turnViolated = true;
    const voltage = this._levelVoltage();
    rt.stats.shocks += 1;
    this._effects.push({
      type: 'device.shock',
      role: 'punish',
      voltage,
      durationMs: Math.round(clamp(this.cfg.shockDurationMs, 100, 5000)),
    });
    this._log('warn', `不服从（${reason}），电击 ${voltage}V`, nowMs);
    if (options.escalate !== false && this.cfg.escalation && rt.level < this._maxLevel()) {
      rt.level += 1;
      this._emitPrompt('level_up', nowMs);
      this._log('info', `升到 ${rt.level} 档`, nowMs);
    }
  }

  // ---- 内部：指令 ----

  _onPress(nowMs, cmd) {
    const rt = this.rt;
    const current = rt.command;
    if (current && current.cmd === cmd) {
      // 按住期间每 400ms 重发：只续命，不重置窗口
      current.lastPressMs = nowMs;
      current.held = true;
      return;
    }
    this._startCommand(nowMs, cmd);
  }

  _startCommand(nowMs, cmd) {
    const rt = this.rt;
    if (rt.command) this._endCommand(nowMs, 'replaced');
    const reactionMs = Math.max(0, this.cfg.reactionSec) * 1000;
    const heading = this._heading();
    rt.command = {
      cmd,
      held: true,
      sinceMs: nowMs,
      deadlineMs: nowMs + reactionMs,
      headingRef: heading,
      windowRef: heading,
      lastPressMs: nowMs,
      status: 'pending',
      violated: false,
      everMoved: false,
    };
    rt.stats.commands += 1;
    rt.phase = TURN_CMDS.has(cmd) ? PHASE.TURNING : PHASE.MOVING;
    rt.stopCheckAtMs = 0;
    rt.addonBelowSinceMs = 0;
    this._emitPrompt(`cmd_${cmd}`, nowMs);
    this._log('info', `指令：${CMD_TEXT[cmd]}`, nowMs);
  }

  // 指令结束：整条没被判违规就记完成（连续完成可降档）
  _endCommand(nowMs, reason) {
    const rt = this.rt;
    const command = rt.command;
    if (!command) return;
    if (!command.violated) {
      rt.stats.completed += 1;
      rt.compliantStreak += 1;
      if (this.cfg.escalation && rt.compliantStreak >= Math.max(1, Math.round(this.cfg.deescalateAfter))) {
        rt.compliantStreak = 0;
        if (rt.level > 1) {
          rt.level -= 1;
          this._emitPrompt('level_down', nowMs);
          this._log('info', `降到 ${rt.level} 档`, nowMs);
        }
      }
    } else {
      rt.compliantStreak = 0;
    }
    rt.command = null;
    if (reason !== 'completed') this._log('debug', `指令结束（${reason}）`, nowMs);
  }

  _enterStopped(nowMs) {
    const rt = this.rt;
    rt.phase = PHASE.STOPPED;
    rt.stopCheckAtMs = nowMs + Math.max(0, this.cfg.stopGraceSec) * 1000;
  }

  _onRelease(nowMs, cmd) {
    const rt = this.rt;
    if (!rt.command || rt.command.cmd !== cmd) return;
    const command = rt.command;
    command.held = false;
    command.lastPressMs = 0;
    if (TURN_CMDS.has(cmd)) return; // 转向：等本窗口到点再判，完成/超时才结束指令
    this._endCommand(nowMs, 'release');
    this._enterStopped(nowMs);
    this._emitPrompt('cmd_stop', nowMs);
    this._log('info', '停', nowMs);
  }

  // A 端 1200ms 没重发就视为松开（A 断网时 B 不会被一直要求爬）
  _checkKeepalive(nowMs) {
    const rt = this.rt;
    const command = rt.command;
    if (!command || !command.held) return;
    if (nowMs - command.lastPressMs <= HOLD_KEEPALIVE_MS) return;
    command.held = false;
    command.lastPressMs = 0;
    if (TURN_CMDS.has(command.cmd)) return;
    this._endCommand(nowMs, 'keepalive');
    this._enterStopped(nowMs);
    this._emitPrompt('cmd_stop', nowMs);
    this._log('warn', '按住超时未收到重发，按松开处理', nowMs);
  }

  _judge(nowMs) {
    const phase = this.rt.phase;
    if (phase === PHASE.MOVING) return this._judgeMoving(nowMs);
    if (phase === PHASE.TURNING) return this._judgeTurning(nowMs);
    if (phase === PHASE.STOPPED) return this._judgeStopped(nowMs);
  }

  _judgeMoving(nowMs) {
    const rt = this.rt;
    const command = rt.command;
    if (!command) {
      this._enterStopped(nowMs);
      return;
    }
    const motion = this._motionStats(nowMs);
    if (motion.moving) command.everMoved = true;
    if (nowMs < command.deadlineMs) return;
    const offHeading = Math.abs(this._heading() - command.headingRef) > this.cfg.headingTolerance;
    let reason = null;
    if (!motion.moving) reason = command.everMoved ? 'no-move' : 'no-start';
    else if (offHeading) reason = 'off-heading';
    if (reason) {
      this._violate(nowMs, reason);
      // 同一条指令连续不服从：每隔 reactionSec 再判一次
      command.deadlineMs = nowMs + Math.max(0, this.cfg.reactionSec) * 1000;
      command.status = 'violating';
    } else {
      command.status = 'ok';
      command.deadlineMs = nowMs + MOTION_WINDOW_MS;
    }
  }

  _judgeTurning(nowMs) {
    const rt = this.rt;
    const command = rt.command;
    if (!command) {
      this._enterStopped(nowMs);
      return;
    }
    if (nowMs < command.deadlineMs) return;
    const progress = this._commandProgress();
    if (progress >= this.cfg.turnDeg) {
      command.status = 'ok';
      if (command.held) {
        this._beginTurnWindow(nowMs);
      } else {
        this._endCommand(nowMs, 'completed');
        this._enterStopped(nowMs);
      }
      return;
    }
    this._violate(nowMs, 'turn-timeout');
    if (command.held) {
      this._beginTurnWindow(nowMs);
    } else {
      this._endCommand(nowMs, 'timeout');
      this._enterStopped(nowMs);
    }
  }

  _beginTurnWindow(nowMs) {
    const command = this.rt.command;
    if (!command) return;
    command.windowRef = this._heading();
    command.deadlineMs = nowMs + Math.max(0, this.cfg.reactionSec) * 1000;
    command.status = 'pending';
  }

  _judgeStopped(nowMs) {
    const rt = this.rt;
    if (rt.command) return;
    if (!rt.stopCheckAtMs || nowMs < rt.stopCheckAtMs) return;
    if (this._motionStats(nowMs).moving) {
      this._violate(nowMs, 'not-stopped');
      rt.stopCheckAtMs = nowMs + Math.max(0, this.cfg.reactionSec) * 1000;
    } else {
      rt.stopCheckAtMs = nowMs + MOTION_WINDOW_MS;
    }
  }

  // ---- 内部：手动电击 / 重新校准 / 结束 ----

  // 手动电击：运行中可用（暂停也算运行），冷却 1 秒；未运行由 action() 拒绝
  _manualShock(nowMs) {
    const rt = this.rt;
    if (nowMs < rt.manualShockReadyAtMs) {
      this._log('info', '手动电击冷却中', nowMs);
      return;
    }
    rt.manualShockReadyAtMs = nowMs + MANUAL_SHOCK_COOLDOWN_MS;
    const voltage = this._levelVoltage();
    rt.stats.manualShocks += 1;
    rt.stats.shocks += 1;
    this._effects.push({
      type: 'device.shock',
      role: 'punish',
      voltage,
      durationMs: Math.round(clamp(this.cfg.shockDurationMs, 100, 5000)),
    });
    this._log('warn', `手动电击 ${voltage}V`, nowMs);
  }

  // 回到校准阶段：不计违规，当前指令直接丢弃（不计完成）
  _recalibrate(nowMs) {
    const rt = this.rt;
    rt.command = null;
    rt.phase = PHASE.CALIBRATING;
    rt.calibEndMs = nowMs + Math.max(1, this.cfg.calibSec) * 1000;
    rt.calibAccel = [];
    rt.calibGyro = [];
    rt.calibPressure = [];
    rt.stopCheckAtMs = 0;
    rt.addonBelowSinceMs = 0;
    rt.addonPromptArmed = true;
    rt.edgingLatched = false;
    this._emitPrompt('calib_start', nowMs);
    this._log('info', '重新校准，请保持不动', nowMs);
  }

  _finish(nowMs, reason) {
    const rt = this.rt;
    this._effects.push({ type: 'device.shock-stop', role: 'punish' });
    rt.running = false;
    rt.paused = false;
    rt.ended = true;
    rt.endReason = reason || 'stop';
    rt.endedAtMs = nowMs;
    rt.command = null;
    rt.stopCheckAtMs = 0;
    rt.addonBelowSinceMs = 0;
    rt.pressurePending = false;
    rt.sensorWaitUntilMs = 0;
    this._emitPrompt('game_end', nowMs);
    this._log('info', `游戏结束（指令 ${rt.stats.commands}，完成 ${rt.stats.completed}，违规 ${rt.stats.violations}，电击 ${rt.stats.shocks}）`, nowMs);
  }
}

module.exports = {
  RcCarCore,
  GAME_ID,
  VERSION,
  TITLE,
  PARAMS,
  PHASE,
  // 纯函数导出：方向标定与单测用
  decodeInt16Hex,
  decodeQuat,
  decodeVector,
  yawDeltaDeg,
  quatMul,
  quatConj,
  rotateVec,
  normalize3,
};
