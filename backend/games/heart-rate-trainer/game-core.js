// 运动心率电击提醒 — 分离式游戏核心（纯逻辑，PC 与手机宿主共用）
// 契约：docs/architecture/split-game-contract.md
// 确定性约束：不碰 DOM / 定时器 / 网络 / 文件；时间只来自 nowMs，随机只用注入的 random()。
//
// 事件契约（manifest 声明 "events":"v2"）：
//   { type:'device-property', role:'hrm', deviceId, name:'heart_rate'|'heartRate', value, seed? }
//   { type:'device-property', role:'hrm', deviceId, name:'hr_status', value, seed? }
//   { type:'device-property', role:'hrm', deviceId, name:'hr_contact', value, seed? }
//   { type:'device-property', role:'hrm', deviceId, name:'battery', value, seed? }

'use strict';

const GAME_ID = 'heart-rate-trainer';
const VERSION = '1.0.0';
const TITLE = '运动心率电击提醒';

const LOG_LIMIT = 15;
const HISTORY_SAMPLE_MS = 1000;
const MAX_HISTORY_POINTS = 120;
const UNSAFE_VOLTAGE_CAP = 30;
const ABS_MAX_VOLTAGE = 80;
const RECOVERY_STREAK_MS = 3000;
const MIN_DURATION_MINUTES = 1;

const SENSOR_POLICIES = ['wait', 'auto_pause'];

// 与 index.html 内联 manifest.params 完全一致（绝不使用 hidden）
const PARAMS = [
  { key: 'duration', type: 'number', default: 20, min: 1, max: 180 },
  { key: 'minHeartRate', type: 'number', default: 120, min: 50, max: 200 },
  { key: 'warmupSeconds', type: 'number', default: 30, min: 0, max: 600 },
  { key: 'shockVoltage', type: 'number', default: 18, min: 1, max: 80 },
  { key: 'shockDurationSeconds', type: 'number', default: 2, min: 0.5, max: 10 },
  { key: 'cooldownSeconds', type: 'number', default: 15, min: 1, max: 300 },
  { key: 'belowThresholdGraceSeconds', type: 'number', default: 5, min: 0, max: 60 },
  { key: 'progressiveShock', type: 'boolean', default: false },
  { key: 'progressiveStepVoltage', type: 'number', default: 3, min: 1, max: 20 },
  { key: 'maxShockVoltage', type: 'number', default: 30, min: 5, max: 80 },
  { key: 'allowUnsafeVoltage', type: 'boolean', default: false },
  { key: 'sensorLossPolicy', type: 'enum', default: 'wait', enum: SENSOR_POLICIES },
  { key: 'sensorLossGraceSeconds', type: 'number', default: 8, min: 2, max: 60 },
  { key: 'warningMotorIntensity', type: 'number', default: 80, min: 0, max: 255 },
  { key: 'backgroundKeepAlive', type: 'boolean', default: false },
];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toFinite(value) {
  if (typeof value === 'boolean' || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function defaultParams() {
  const out = {};
  for (const spec of PARAMS) out[spec.key] = spec.default;
  return out;
}

function normalizeParam(spec, raw) {
  if (spec.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === 1 || raw === '1') return true;
    if (raw === 'false' || raw === 0 || raw === '0') return false;
    return null;
  }
  if (spec.type === 'enum') {
    const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
    return spec.enum.includes(text) ? text : null;
  }
  const n = toFinite(raw);
  if (n == null) return null;
  return clamp(n, spec.min, spec.max);
}

function mergeParams(current, input) {
  const next = { ...current };
  if (!isPlainObject(input)) return next;
  for (const spec of PARAMS) {
    if (!Object.prototype.hasOwnProperty.call(input, spec.key)) continue;
    const value = normalizeParam(spec, input[spec.key]);
    if (value !== null) next[spec.key] = value;
  }
  return next;
}

class HeartRateTrainerCore {
  constructor({ params, random } = {}) {
    this.random = typeof random === 'function' ? random : () => 0.5;
    this.cfg = mergeParams(defaultParams(), params);
    this._effects = [];
    this._turnLogs = [];
    this._resetRuntime(0);
  }

  // ---- 生命周期 ----

  start(nowMs) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (this.rt.running) return this._fail('ALREADY_RUNNING', '训练已在运行中');

    this._resetRuntime(nowMs);
    const totalMs = this._durationMs(this.cfg.duration);
    const warmupMs = Math.round(this.cfg.warmupSeconds * 1000);

    this.rt.running = true;
    this.rt.paused = false;
    this.rt.ended = false;
    this.rt.startedAtMs = nowMs;
    this.rt.lastUpdateMs = nowMs;
    this.rt.lastStatTickMs = nowMs;
    this.rt.endTimeMs = nowMs + totalMs;
    this.rt.warmupEndMs = nowMs + warmupMs;
    this.rt.warmupCompleted = warmupMs <= 0;
    this.rt.remainingSec = Math.ceil(totalMs / 1000);
    this.rt.signalLostSinceMs = nowMs;
    this.rt.phase = warmupMs > 0 ? 'WARMUP' : 'SIGNAL_WAIT';

    this._setLock(false, nowMs, false);
    if (warmupMs > 0) {
      this._log('info', `运动开始，热身 ${Math.round(warmupMs / 1000)} 秒后启动心率下限监控（≥${Math.round(this.cfg.minHeartRate)} bpm）`, nowMs);
    } else {
      this._log('info', `运动开始，目标心率下限 ${Math.round(this.cfg.minHeartRate)} bpm`, nowMs);
    }
    return this._ok(nowMs);
  }

  pause(nowMs) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._fail('NOT_RUNNING', '训练未运行');
    if (this.rt.paused) return this._ok(nowMs);

    // 暂停前先结算截至此刻的运动统计，并幂等下发停电、停振与解锁意图
    this._accumulateStats(nowMs);
    const wasShocking = this.rt.isShocking;
    this.rt.paused = true;
    this.rt.pausedAtMs = nowMs;
    this.rt.lastUpdateMs = nowMs;
    this.rt.isShocking = false;
    this.rt.shockUntilMs = 0;
    this.rt.motorActive = false;
    this.rt.motorIntensity = 0;
    this._effects.push({ type: 'device.shock-stop', role: 'shock' });
    this._effects.push({ type: 'device.stop-strength', role: 'motor' });
    this._setLock(true, nowMs, false);
    if (wasShocking) {
      this.rt.cooldownUntilMs = nowMs + clamp(Math.round(this.cfg.cooldownSeconds * 1000), 1000, 300000);
    }
    this.rt.phase = 'PAUSED';
    this._log('info', '训练已暂停', nowMs);
    return this._ok(nowMs);
  }

  resume(nowMs) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._fail('NOT_RUNNING', '训练未运行');
    if (!this.rt.paused) return this._fail('NOT_PAUSED', '训练未暂停');

    const pausedDelta = Math.max(0, nowMs - (this.rt.pausedAtMs || nowMs));
    this.rt.totalPausedMs += pausedDelta;
    this.rt.endTimeMs += pausedDelta;
    if (this.rt.warmupEndMs > 0) this.rt.warmupEndMs += pausedDelta;
    if (this.rt.cooldownUntilMs > 0) this.rt.cooldownUntilMs += pausedDelta;
    if (this.rt.belowSinceMs !== null) this.rt.belowSinceMs += pausedDelta;
    if (this.rt.signalLostSinceMs !== null) this.rt.signalLostSinceMs += pausedDelta;
    if (this.rt.inZoneStreakSinceMs !== null) this.rt.inZoneStreakSinceMs += pausedDelta;

    this.rt.paused = false;
    this.rt.pausedAtMs = 0;
    this.rt.lastUpdateMs = nowMs;
    this.rt.lastStatTickMs = nowMs;
    this._setLock(false, nowMs, false);
    this._log('info', '训练已继续', nowMs);
    this._evaluate(nowMs);
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
    const prevDuration = this.cfg.duration;
    const prevWarmup = this.cfg.warmupSeconds;
    const prevMotor = this.cfg.warningMotorIntensity;
    this.cfg = mergeParams(this.cfg, params);

    const nowMs = this.rt.lastUpdateMs || 0;
    if (this.rt.running) {
      if (this.cfg.duration !== prevDuration) {
        this.rt.endTimeMs = this.rt.startedAtMs + this.rt.totalPausedMs + this._durationMs(this.cfg.duration);
        const anchor = this.rt.paused ? this.rt.pausedAtMs : nowMs;
        this.rt.remainingSec = Math.max(0, Math.ceil((this.rt.endTimeMs - anchor) / 1000));
      }
      if (this.cfg.warmupSeconds !== prevWarmup && !this.rt.warmupSkipped) {
        this.rt.warmupEndMs = this.rt.startedAtMs + this.rt.totalPausedMs + Math.round(this.cfg.warmupSeconds * 1000);
        const anchor = this.rt.paused ? this.rt.pausedAtMs : nowMs;
        this.rt.warmupCompleted = anchor >= this.rt.warmupEndMs;
      }
      // 运行中若收紧电压上限（如关闭 allowUnsafeVoltage 或调低电压），立即停止当前超限电击
      if (this.rt.isShocking && this.rt.lastShockVoltage > this._maxAllowedVoltageNow()) {
        const stopAnchor = this.rt.paused ? (this.rt.pausedAtMs || nowMs) : nowMs;
        this._stopShock(stopAnchor, !this.rt.paused);
        this._log('info', '电击上限已收紧，已立即终止当前超限电击', stopAnchor);
      }
      if (this.cfg.warningMotorIntensity === 0 && prevMotor > 0 && this.rt.motorActive) {
        this._stopWarningMotor();
      } else if (
        this.rt.motorActive
        && this.cfg.warningMotorIntensity > 0
        && this.cfg.warningMotorIntensity !== prevMotor
      ) {
        this._startWarningMotor(this.cfg.warningMotorIntensity);
      }
      if (!this.rt.paused) {
        if (nowMs >= this.rt.endTimeMs) {
          this._finish(nowMs, 'duration');
          return this._ok(nowMs);
        }
        this._evaluate(nowMs);
      }
      this._log('info', `参数已更新（心率下限 ${Math.round(this.cfg.minHeartRate)} bpm，电击 ${this._effectiveNextVoltage()}V）`, nowMs);
    }
    return this._ok(nowMs);
  }

  action(name, payload, nowMs) {
    if (name === 'start') return this.start(nowMs);
    if (name === 'pause') return this.pause(nowMs);
    if (name === 'resume') return this.resume(nowMs);
    if (name === 'stop') return this.stop(nowMs, (payload && payload.reason) || 'action');
    if (name === 'togglePause') {
      return this.rt.paused ? this.resume(nowMs) : this.pause(nowMs);
    }

    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._fail('NOT_RUNNING', '训练未运行');

    const data = isPlainObject(payload) ? payload : {};
    if (name === 'skipWarmup') {
      if (nowMs < this.rt.warmupEndMs) {
        this.rt.warmupEndMs = nowMs;
        this.rt.warmupSkipped = true;
        this.rt.warmupCompleted = true;
        if (this.rt.paused && this.rt.pausedAtMs > 0) {
          this.rt.warmupEndMs = this.rt.pausedAtMs;
        }
        if (!this._hasLiveSensorSignal()) {
          this.rt.signalLostSinceMs = this.rt.paused ? (this.rt.pausedAtMs || nowMs) : nowMs;
        }
        this._log('info', '已跳过热身，立即开始心率下限监控', nowMs);
        if (!this.rt.paused) this._evaluate(nowMs);
      }
      return this._ok(nowMs);
    }

    if (name === 'adjustMinHr') {
      const delta = toFinite(data.delta);
      if (delta == null) return this._fail('INVALID_PAYLOAD', '缺少心率调整步长');
      this.cfg.minHeartRate = clamp(Math.round(this.cfg.minHeartRate + delta), 50, 200);
      this._log('info', `心率下限调整为 ${this.cfg.minHeartRate} bpm`, nowMs);
      if (!this.rt.paused) this._evaluate(nowMs);
      return this._ok(nowMs);
    }

    if (name === 'adjustVoltage') {
      const delta = toFinite(data.delta);
      if (delta == null) return this._fail('INVALID_PAYLOAD', '缺少电压调整步长');
      const safetyCap = this.cfg.allowUnsafeVoltage ? ABS_MAX_VOLTAGE : UNSAFE_VOLTAGE_CAP;
      const capNow = this.cfg.progressiveShock
        ? clamp(Math.round(this.cfg.maxShockVoltage), 1, safetyCap)
        : safetyCap;
      this.cfg.shockVoltage = clamp(Math.round(this.cfg.shockVoltage + delta), 1, capNow);
      if (this.rt.isShocking && this.rt.lastShockVoltage > this._maxAllowedVoltageNow()) {
        const stopAnchor = this.rt.paused ? (this.rt.pausedAtMs || nowMs) : nowMs;
        this._stopShock(stopAnchor, !this.rt.paused);
        this._log('info', '电击上限已收紧，已立即终止当前超限电击', stopAnchor);
      }
      this._log('info', `基础电击强度调整为 ${this.cfg.shockVoltage}V（当前有效上限 ${this._effectiveNextVoltage()}V）`, nowMs);
      return this._ok(nowMs);
    }

    if (name === 'shockOnce') {
      return this._fail('ACTION_DISABLED', '训练进行中禁止手动触发电击，请在设备管理页测试强度');
    }

    if (name === 'unlock') {
      this._setLock(true, nowMs, true);
      return this._ok(nowMs);
    }

    return this._fail('UNKNOWN_ACTION', `未知操作: ${String(name)}`);
  }

  step({ nowMs, events } = {}) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    const rows = Array.isArray(events) ? events : [];
    if (!this.rt.running) {
      return this._ok(nowMs);
    }

    // 暂停期间仍更新实时心率与佩戴状态以便界面观察，但不推进计时、不写曲线、不触发电击
    this._applyEvents(nowMs, rows);
    if (this.rt.paused) {
      return this._ok(nowMs);
    }

    this._accumulateStats(nowMs);
    this.rt.lastUpdateMs = nowMs;
    this.rt.remainingSec = Math.max(0, Math.ceil((this.rt.endTimeMs - nowMs) / 1000));

    if (nowMs >= this.rt.endTimeMs) {
      this._finish(nowMs, 'duration');
      return this._ok(nowMs);
    }

    this._evaluate(nowMs);
    this._sampleHistory(nowMs, this.rt.shockedInCurrentSecond);
    return this._ok(nowMs);
  }

  snapshot() {
    const rt = this.rt;
    const now = rt.paused ? (rt.pausedAtMs || rt.lastUpdateMs) : rt.lastUpdateMs;
    const warmupRemainingSec = rt.running && now < rt.warmupEndMs
      ? Math.max(0, Math.ceil((rt.warmupEndMs - now) / 1000))
      : 0;
    const cooldownRemainingSec = rt.running && !rt.isShocking && now < rt.cooldownUntilMs
      ? Math.max(0, Math.ceil((rt.cooldownUntilMs - now) / 1000))
      : 0;
    const shockRemainingMs = rt.running && rt.isShocking && now < rt.shockUntilMs
      ? Math.max(0, rt.shockUntilMs - now)
      : 0;

    let graceRemainingSec = 0;
    if (rt.running && !rt.paused && rt.phase === 'WARNING' && rt.belowSinceMs !== null) {
      const deadline = rt.belowSinceMs + Math.round(this.cfg.belowThresholdGraceSeconds * 1000);
      graceRemainingSec = Math.max(0, Math.ceil(Math.max(0, deadline - now) / 1000));
    }

    let signalLossRemainingSec = 0;
    if (rt.running && !rt.paused && (rt.phase === 'SIGNAL_WAIT' || rt.phase === 'SIGNAL_LOST') && rt.signalLostSinceMs !== null) {
      const deadline = rt.signalLostSinceMs + Math.round(this.cfg.sensorLossGraceSeconds * 1000);
      signalLossRemainingSec = Math.max(0, Math.ceil(Math.max(0, deadline - now) / 1000));
    }

    const effectiveHr = this._effectiveHeartRate();
    const minHr = Math.round(this.cfg.minHeartRate);
    const hrDelta = effectiveHr !== null ? Math.round(effectiveHr - minHr) : null;
    const avgHeartRate = rt.hrSampleMs > 0 ? Math.round(rt.hrWeightedSum / rt.hrSampleMs) : (rt.lastValidHeartRate || 0);
    const compliancePercent = rt.monitoredMs > 0
      ? clamp(Math.round((rt.inZoneMs / rt.monitoredMs) * 100), 0, 100)
      : 100;

    return {
      version: VERSION,
      gameId: GAME_ID,
      title: TITLE,
      running: !!rt.running,
      paused: !!rt.paused,
      ended: !!rt.ended,
      phase: rt.phase,
      statusText: this._statusText(warmupRemainingSec, graceRemainingSec, cooldownRemainingSec),
      startedAtMs: rt.startedAtMs || 0,
      endedAtMs: rt.endedAtMs || 0,
      endTimeMs: rt.endTimeMs || 0,
      endReason: rt.endReason || '',
      remainingSec: rt.remainingSec,
      warmupRemainingSec,
      graceRemainingSec,
      cooldownRemainingSec,
      signalLossRemainingSec,
      shockRemainingMs,
      heartRate: effectiveHr,
      lastValidHeartRate: rt.lastValidHeartRate,
      rawHeartRate: rt.rawHeartRate,
      minHeartRate: minHr,
      hrDelta,
      hrStatus: rt.hrStatus,
      hrContact: rt.hrContact,
      sensorConnected: this._hasLiveSensorSignal(),
      battery: rt.battery,
      isShocking: !!rt.isShocking,
      shockCount: rt.shockCount,
      consecutiveShocks: rt.consecutiveShocks,
      lastShockVoltage: rt.lastShockVoltage,
      requestedShockVoltage: Math.round(this.cfg.shockVoltage),
      nextShockVoltage: this._effectiveNextVoltage(),
      motorActive: !!rt.motorActive,
      motorIntensity: rt.motorIntensity,
      isLocked: !!rt.isLocked,
      lockedText: rt.lockedText,
      inZoneSeconds: Math.floor(rt.inZoneMs / 1000),
      monitoredSeconds: Math.floor(rt.monitoredMs / 1000),
      compliancePercent,
      avgHeartRate,
      maxHeartRate: rt.maxHeartRate,
      minSeenHeartRate: rt.minSeenHeartRate,
      nextWakeAtMs: this._nextWakeAtMs(now),
      params: { ...this.cfg },
      history: rt.history.map((pt) => ({ ...pt })),
      logs: rt.logs.map((entry) => ({ ...entry })),
    };
  }

  // ---- 内部实现 ----

  _resetRuntime(nowMs) {
    this.rt = {
      running: false,
      paused: false,
      ended: false,
      phase: 'IDLE',
      startedAtMs: 0,
      endedAtMs: 0,
      endTimeMs: 0,
      warmupEndMs: 0,
      warmupSkipped: false,
      warmupCompleted: false,
      pausedAtMs: 0,
      totalPausedMs: 0,
      lastUpdateMs: nowMs,
      lastStatTickMs: nowMs,
      remainingSec: Math.round(this._durationMs(this.cfg.duration) / 1000),

      // 心率传感器状态（绑定单一 HRM 设备 ID，防止多条心率带属性串扰）
      hrmDeviceId: null,
      rawHeartRate: null,
      lastValidHeartRate: null,
      hasEverHadValidHr: false,
      hrStatus: 'waiting', // waiting | ok | no_contact | stale | disconnected
      hrContact: null,
      battery: null,
      signalLostSinceMs: null,

      // 判定与电击/冷却状态
      belowSinceMs: null,
      inZoneStreakSinceMs: null,
      isShocking: false,
      shockUntilMs: 0,
      cooldownUntilMs: 0,
      shockCount: 0,
      consecutiveShocks: 0,
      lastShockVoltage: 0,
      motorActive: false,
      motorIntensity: 0,
      isLocked: false,
      lockedText: '未加锁',

      // 统计与曲线
      monitoredMs: 0,
      inZoneMs: 0,
      hrWeightedSum: 0,
      hrSampleMs: 0,
      maxHeartRate: 0,
      minSeenHeartRate: 0,
      lastHistoryBucket: -1,
      shockedInCurrentSecond: false,
      history: [],
      logs: [],
    };
  }

  _durationMs(minutes) {
    const mins = Math.max(MIN_DURATION_MINUTES, toFinite(minutes) || 20);
    return Math.round(mins * 60000);
  }

  result(nowMs) {
    this._beginTurn();
    return this._ok(nowMs);
  }

  _beginTurn() {
    this._effects = [];
    this._turnLogs = [];
  }

  _ok(nowMs) {
    const effects = this._effects.slice();
    const logs = this._turnLogs.slice();
    this._effects = [];
    this._turnLogs = [];
    return {
      ok: true,
      snapshot: this.snapshot(),
      effects,
      logs,
      nextWakeAtMs: this._nextWakeAtMs(nowMs),
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

  _log(level, message, atMs) {
    const entry = {
      level,
      message: String(message),
      atMs: Number.isFinite(atMs) ? atMs : (this.rt.lastUpdateMs || 0),
    };
    this._turnLogs.push(entry);
    this.rt.logs.unshift(entry);
    if (this.rt.logs.length > LOG_LIMIT) {
      this.rt.logs.length = LOG_LIMIT;
    }
  }

  _applyEvents(nowMs, events) {
    let hrUpdatedPositiveLive = false;
    let seedPositiveBpm = null;
    let explicitStatusInTurn = null;

    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'device-property') {
        if (ev.role !== 'hrm') continue;
        const devId = ev.deviceId != null ? String(ev.deviceId).trim() : '';
        if (!devId) continue;
        if (this.rt.hrmDeviceId === null) {
          this.rt.hrmDeviceId = devId;
        } else if (this.rt.hrmDeviceId !== devId) {
          continue;
        }
        const prop = String(ev.name || '');
        if (prop === 'heart_rate' || prop === 'heartRate') {
          const bpm = toFinite(ev.value);
          if (bpm !== null) {
            const rounded = Math.max(0, Math.round(bpm));
            if (ev.seed === true) {
              if (rounded > 0) {
                seedPositiveBpm = rounded;
                this.rt.lastValidHeartRate = rounded;
              } else {
                this.rt.rawHeartRate = null;
              }
            } else if (rounded > 0) {
              this.rt.rawHeartRate = rounded;
              hrUpdatedPositiveLive = true;
            } else {
              this.rt.rawHeartRate = null;
            }
          } else {
            this.rt.rawHeartRate = null;
          }
        } else if (prop === 'hr_status') {
          const s = String(ev.value || '').trim();
          if (s) {
            this.rt.hrStatus = s;
            explicitStatusInTurn = s;
            if (s === 'no_contact' || s === 'stale' || s === 'disconnected' || s === 'offline') {
              this.rt.rawHeartRate = null;
            }
          }
        } else if (prop === 'hr_contact') {
          const c = toFinite(ev.value);
          if (c !== null) {
            this.rt.hrContact = c > 0 ? 1 : 0;
            if (this.rt.hrContact === 0) {
              this.rt.rawHeartRate = null;
            }
          }
        } else if (prop === 'battery') {
          const b = toFinite(ev.value);
          if (b !== null) this.rt.battery = clamp(Math.round(b), 0, 100);
        }
      } else if (ev.type === 'device-event') {
        if (ev.role !== 'hrm') continue;
        const devId = ev.deviceId != null ? String(ev.deviceId).trim() : '';
        if (devId && this.rt.hrmDeviceId !== null && this.rt.hrmDeviceId !== devId) continue;
        const evName = String(ev.name || '').toLowerCase();
        if (evName === 'disconnected' || evName === 'offline' || evName === 'disconnect') {
          this.rt.rawHeartRate = null;
          this.rt.hrStatus = 'disconnected';
          explicitStatusInTurn = 'disconnected';
        }
      } else if (ev.type === 'sensor' && ev.role === 'hrm' && (ev.name === 'heartRate' || ev.name === 'heart_rate')) {
        const devId = ev.deviceId != null ? String(ev.deviceId).trim() : '';
        if (this.rt.hrmDeviceId !== null && devId !== this.rt.hrmDeviceId) continue;
        if (this.rt.hrmDeviceId === null && devId) this.rt.hrmDeviceId = devId;
        const bpm = toFinite(ev.value);
        if (bpm !== null) {
          const rounded = Math.max(0, Math.round(bpm));
          this.rt.rawHeartRate = rounded > 0 ? rounded : null;
          if (rounded > 0) hrUpdatedPositiveLive = true;
        } else {
          this.rt.rawHeartRate = null;
        }
      }
    }

    // 开局 seed 样本仅当同批或当前显式处于 hr_status === 'ok'（由心率带 5s 看门狗背书）时才作为实时心率；
    // 无显式 ok 状态的缓存读数只写入 lastValidHeartRate 供界面展示，绝不直接参与电击判定。
    if (seedPositiveBpm !== null && (explicitStatusInTurn === 'ok' || this.rt.hrStatus === 'ok') && this.rt.rawHeartRate === null) {
      this.rt.rawHeartRate = seedPositiveBpm;
    }

    // 仅在初始 waiting 状态下允许由非 seed 的实时正 BPM 升为 ok；一旦曾明确报告 no_contact / stale / disconnected
    // 或 hr_contact === 0，必须收到显式恢复状态才重新生效，绝不用单条 BPM 覆盖失联或脱落标记。
    if (hrUpdatedPositiveLive && explicitStatusInTurn === null && this.rt.hrStatus === 'waiting') {
      this.rt.hrStatus = 'ok';
    }

    // 根据最新属性刷新传感器信号有效性与统计极值
    if (this._hasLiveSensorSignal()) {
      const bpm = this.rt.rawHeartRate;
      const wasLost = this.rt.signalLostSinceMs !== null && this.rt.hasEverHadValidHr && (
        this.rt.phase === 'SIGNAL_LOST' || this.rt.phase === 'SIGNAL_WAIT'
      );
      this.rt.lastValidHeartRate = bpm;
      this.rt.hasEverHadValidHr = true;
      this.rt.signalLostSinceMs = null;
      if (this.rt.maxHeartRate === 0 || bpm > this.rt.maxHeartRate) this.rt.maxHeartRate = bpm;
      if (this.rt.minSeenHeartRate === 0 || bpm < this.rt.minSeenHeartRate) this.rt.minSeenHeartRate = bpm;
      if (wasLost) {
        this._log('info', `心率信号已恢复（${bpm} bpm）`, nowMs);
      }
    } else {
      this.rt.rawHeartRate = null;
      if (this.rt.signalLostSinceMs === null) {
        this.rt.signalLostSinceMs = this.rt.paused ? (this.rt.pausedAtMs || nowMs) : nowMs;
      }
      this.rt.belowSinceMs = null;
      this.rt.inZoneStreakSinceMs = null;
      // 任何失联/过期/无接触发生时，立即撤销电击与预警电机输出许可
      if (this.rt.isShocking) {
        this._stopShock(nowMs, !this.rt.paused);
        this._log('warn', '心率信号中断或接触不良，已立即终止电击输出', nowMs);
      }
      this._stopWarningMotor();
    }
  }

  _hasLiveSensorSignal() {
    const rt = this.rt;
    if (rt.rawHeartRate === null || rt.rawHeartRate <= 0) return false;
    if (
      rt.hrStatus === 'no_contact'
      || rt.hrStatus === 'stale'
      || rt.hrStatus === 'disconnected'
      || rt.hrStatus === 'offline'
    ) {
      return false;
    }
    if (rt.hrContact === 0) return false;
    return true;
  }

  _effectiveHeartRate() {
    return this._hasLiveSensorSignal() ? this.rt.rawHeartRate : null;
  }

  _accumulateStats(nowMs) {
    const dt = Math.max(0, nowMs - (this.rt.lastStatTickMs || nowMs));
    this.rt.lastStatTickMs = nowMs;
    if (dt <= 0) return;

    const effectiveHr = this._effectiveHeartRate();
    if (effectiveHr !== null && effectiveHr > 0) {
      this.rt.hrWeightedSum += effectiveHr * dt;
      this.rt.hrSampleMs += dt;
    }

    // 热身结束后计入有效监控时长与达标时长（无实时有效心率时不计入监控分母）
    if (nowMs > this.rt.warmupEndMs) {
      const activeDt = this.rt.warmupEndMs > (nowMs - dt)
        ? Math.max(0, nowMs - this.rt.warmupEndMs)
        : dt;
      if (effectiveHr !== null) {
        this.rt.monitoredMs += activeDt;
        if (effectiveHr >= this.cfg.minHeartRate) {
          this.rt.inZoneMs += activeDt;
        }
      }
    }
  }

  _sampleHistory(nowMs, shockedFlag) {
    if (!this.rt.running || this.rt.paused) return;
    const elapsedActiveMs = Math.max(0, nowMs - this.rt.startedAtMs - this.rt.totalPausedMs);
    const bucket = Math.floor(elapsedActiveMs / HISTORY_SAMPLE_MS);
    const bpm = this._effectiveHeartRate();
    const minHr = Math.round(this.cfg.minHeartRate);

    if (bucket === this.rt.lastHistoryBucket && this.rt.history.length > 0) {
      const last = this.rt.history[this.rt.history.length - 1];
      last.bpm = bpm !== null ? bpm : 0;
      last.valid = bpm !== null;
      last.minHr = minHr;
      if (shockedFlag) last.shocked = true;
      this.rt.shockedInCurrentSecond = false;
      return;
    }

    this.rt.lastHistoryBucket = bucket;
    this.rt.history.push({
      offsetSec: bucket,
      bpm: bpm !== null ? bpm : 0,
      valid: bpm !== null,
      minHr,
      shocked: !!shockedFlag,
    });
    if (this.rt.history.length > MAX_HISTORY_POINTS) {
      this.rt.history.splice(0, this.rt.history.length - MAX_HISTORY_POINTS);
    }
    this.rt.shockedInCurrentSecond = false;
  }

  _evaluate(nowMs) {
    const rt = this.rt;
    if (!rt.running || rt.paused) return;

    // 0. 无论处于何种阶段，只要失去有效实时心率信号，立即终止正在输出的电击与震动
    if (!this._hasLiveSensorSignal()) {
      if (rt.isShocking) {
        this._stopShock(nowMs, true);
        this._log('warn', '心率信号中断或接触不良，已立即终止电击输出', nowMs);
      }
      this._stopWarningMotor();
    }

    // 1. 若正在电击且到达电击结束时刻：停止电击并从实际停止时刻起算完整冷却期（落入下方 COOLDOWN 分支）
    if (rt.isShocking && nowMs >= rt.shockUntilMs) {
      this._stopShock(nowMs, true);
    }

    // 2. 若仍在电击中：保持 SHOCKING 状态
    if (rt.isShocking) {
      rt.phase = 'SHOCKING';
      return;
    }

    // 3. 热身期：不触发预警与电击
    if (nowMs < rt.warmupEndMs) {
      this._stopWarningMotor();
      rt.belowSinceMs = null;
      rt.inZoneStreakSinceMs = null;
      if (rt.signalLostSinceMs !== null) rt.signalLostSinceMs = nowMs;
      rt.phase = 'WARMUP';
      return;
    }

    // 首次跨越热身结束时刻：以当前实际评估时刻重新锚定失联起点与迟到缓冲，防止宿主休眠吃掉宽限期
    let lateWarmupTransition = false;
    if (!rt.warmupCompleted) {
      rt.warmupCompleted = true;
      lateWarmupTransition = (nowMs - rt.warmupEndMs) > 1000;
      if (!this._hasLiveSensorSignal()) {
        rt.signalLostSinceMs = nowMs;
      }
      rt.belowSinceMs = null;
    }

    // 4. 冷却期：给玩家留出提速拉升心率的时间，不重复电击
    if (rt.cooldownUntilMs > 0 && nowMs < rt.cooldownUntilMs) {
      this._stopWarningMotor();
      rt.belowSinceMs = null;
      if (rt.signalLostSinceMs !== null) rt.signalLostSinceMs = nowMs;
      const hr = this._effectiveHeartRate();
      if (hr !== null && hr >= this.cfg.minHeartRate) {
        this._updateRecoveryStreak(nowMs);
      } else {
        rt.inZoneStreakSinceMs = null;
      }
      rt.phase = 'COOLDOWN';
      return;
    }
    if (rt.cooldownUntilMs > 0 && nowMs >= rt.cooldownUntilMs) {
      rt.cooldownUntilMs = 0;
      if (!this._hasLiveSensorSignal()) {
        rt.signalLostSinceMs = nowMs;
      }
    }

    // 5. 检查传感器信号有效性（无有效实时信号绝不触发电击）
    const effectiveHr = this._effectiveHeartRate();
    if (effectiveHr === null) {
      rt.belowSinceMs = null;
      rt.inZoneStreakSinceMs = null;
      if (rt.signalLostSinceMs === null) rt.signalLostSinceMs = nowMs;
      const lossGraceMs = Math.round(this.cfg.sensorLossGraceSeconds * 1000);
      const lostElapsed = nowMs - rt.signalLostSinceMs;

      if (lostElapsed < lossGraceMs) {
        this._stopWarningMotor();
        rt.phase = rt.hasEverHadValidHr ? 'SIGNAL_LOST' : 'SIGNAL_WAIT';
        return;
      }

      this._stopWarningMotor();
      if (this.cfg.sensorLossPolicy === 'auto_pause') {
        rt.paused = true;
        rt.pausedAtMs = nowMs;
        rt.lastUpdateMs = nowMs;
        rt.phase = 'PAUSED';
        this._effects.push({ type: 'device.shock-stop', role: 'shock' });
        this._setLock(true, nowMs, false);
        this._log('warn', '心率信号中断超过宽限期，已自动暂停训练计时', nowMs);
        return;
      }

      rt.phase = 'SIGNAL_LOST';
      return;
    }

    // 6. 有有效心率：对比目标心率下限
    if (effectiveHr >= this.cfg.minHeartRate) {
      rt.belowSinceMs = null;
      this._stopWarningMotor();
      this._updateRecoveryStreak(nowMs);
      rt.phase = 'ACTIVE_OK';
      return;
    }

    // 7. 心率低于下限：进入低心率容忍期或触发电击
    rt.inZoneStreakSinceMs = null;
    if (rt.belowSinceMs === null) {
      rt.belowSinceMs = nowMs;
      if (this.cfg.belowThresholdGraceSeconds > 0 || lateWarmupTransition) {
        this._log(
          'warn',
          `心率 ${effectiveHr} bpm 低于下限 ${Math.round(this.cfg.minHeartRate)} bpm，请加快运动节奏！`,
          nowMs,
        );
      }
      if (lateWarmupTransition && this.cfg.belowThresholdGraceSeconds <= 0) {
        if (this.cfg.warningMotorIntensity > 0 && !rt.motorActive) {
          this._startWarningMotor(this.cfg.warningMotorIntensity);
        }
        rt.phase = 'WARNING';
        return;
      }
    }

    const graceMs = Math.round(this.cfg.belowThresholdGraceSeconds * 1000);
    const belowElapsed = nowMs - rt.belowSinceMs;
    if (belowElapsed >= graceMs) {
      this._triggerShock(
        nowMs,
        `心率 ${effectiveHr} bpm 低于下限 ${Math.round(this.cfg.minHeartRate)} bpm`,
        { countAsViolation: true },
      );
      return;
    }

    if (this.cfg.warningMotorIntensity > 0 && !rt.motorActive) {
      this._startWarningMotor(this.cfg.warningMotorIntensity);
    }
    rt.phase = 'WARNING';
  }

  _updateRecoveryStreak(nowMs) {
    if (this.rt.consecutiveShocks <= 0) {
      this.rt.inZoneStreakSinceMs = nowMs;
      return;
    }
    if (this.rt.inZoneStreakSinceMs === null) {
      this.rt.inZoneStreakSinceMs = nowMs;
      return;
    }
    if (nowMs - this.rt.inZoneStreakSinceMs >= RECOVERY_STREAK_MS) {
      this.rt.consecutiveShocks = 0;
      this.rt.inZoneStreakSinceMs = nowMs;
      if (this.cfg.progressiveShock) {
        this._log('info', '心率已稳定达标，连续电击递增已重置回基础强度', nowMs);
      }
    }
  }

  _maxAllowedVoltageNow() {
    const safetyCap = this.cfg.allowUnsafeVoltage ? ABS_MAX_VOLTAGE : UNSAFE_VOLTAGE_CAP;
    if (this.cfg.progressiveShock) {
      return clamp(Math.round(this.cfg.maxShockVoltage), 1, safetyCap);
    }
    return clamp(Math.round(this.cfg.shockVoltage), 1, safetyCap);
  }

  _effectiveNextVoltage() {
    const safetyCap = this.cfg.allowUnsafeVoltage ? ABS_MAX_VOLTAGE : UNSAFE_VOLTAGE_CAP;
    let voltage = Math.round(this.cfg.shockVoltage);
    if (this.cfg.progressiveShock) {
      const cap = clamp(Math.round(this.cfg.maxShockVoltage), 1, safetyCap);
      voltage = Math.min(cap, voltage + this.rt.consecutiveShocks * Math.round(this.cfg.progressiveStepVoltage));
    }
    return clamp(voltage, 1, safetyCap);
  }

  _triggerShock(nowMs, reasonText, { countAsViolation = true } = {}) {
    if (
      !this.rt.running
      || this.rt.paused
      || this.rt.ended
      || nowMs < this.rt.warmupEndMs
      || (this.rt.cooldownUntilMs > 0 && nowMs < this.rt.cooldownUntilMs)
      || !this._hasLiveSensorSignal()
    ) {
      return;
    }
    this._stopWarningMotor();
    const voltage = this._effectiveNextVoltage();
    const durationMs = clamp(Math.round(this.cfg.shockDurationSeconds * 1000), 500, 10000);
    const cooldownMs = clamp(Math.round(this.cfg.cooldownSeconds * 1000), 1000, 300000);

    this.rt.isShocking = true;
    this.rt.shockUntilMs = nowMs + durationMs;
    this.rt.cooldownUntilMs = this.rt.shockUntilMs + cooldownMs;
    this.rt.belowSinceMs = null;
    this.rt.shockCount += 1;
    if (countAsViolation) {
      this.rt.consecutiveShocks += 1;
    }
    this.rt.lastShockVoltage = voltage;
    this.rt.shockedInCurrentSecond = true;
    this.rt.phase = 'SHOCKING';

    this._effects.push({
      type: 'device.shock',
      role: 'shock',
      voltage,
      durationMs,
    });
    const secText = (durationMs / 1000).toFixed(durationMs % 1000 === 0 ? 0 : 1);
    this._log(
      'warn',
      `${reasonText} → 电击 ${voltage}V × ${secText}s（冷却 ${Math.round(cooldownMs / 1000)}s，第 ${this.rt.shockCount} 次）`,
      nowMs,
    );
  }

  _stopShock(nowMs, enterCooldown) {
    if (!this.rt.isShocking) return;
    const cooldownMs = clamp(Math.round(this.cfg.cooldownSeconds * 1000), 1000, 300000);
    this.rt.isShocking = false;
    this.rt.shockUntilMs = 0;
    this._effects.push({
      type: 'device.shock-stop',
      role: 'shock',
    });
    if (enterCooldown) {
      this.rt.cooldownUntilMs = nowMs + cooldownMs;
      this.rt.phase = 'COOLDOWN';
    }
  }

  _startWarningMotor(intensity) {
    const value = clamp(Math.round(intensity), 0, 255);
    if (value <= 0) return;
    this.rt.motorActive = true;
    this.rt.motorIntensity = value;
    this._effects.push({
      type: 'device.set-strength',
      role: 'motor',
      value,
    });
  }

  _stopWarningMotor() {
    if (!this.rt.motorActive) return;
    this.rt.motorActive = false;
    this.rt.motorIntensity = 0;
    this._effects.push({
      type: 'device.stop-strength',
      role: 'motor',
    });
  }

  _setLock(open, nowMs, logAction) {
    const isOpen = !!open;
    this.rt.isLocked = !isOpen;
    this.rt.lockedText = isOpen ? '已解锁' : '已加锁';
    this._effects.push({
      type: 'device.lock',
      role: 'lock',
      open: isOpen,
    });
    if (logAction) {
      this._log('info', isOpen ? '自动锁已解锁' : '自动锁已加锁', nowMs);
    }
  }

  _finish(nowMs, reason) {
    if (!this.rt.paused) {
      this._accumulateStats(nowMs);
    }
    this.rt.running = false;
    this.rt.paused = false;
    this.rt.ended = true;
    this.rt.endedAtMs = nowMs;
    this.rt.endReason = String(reason || 'stop');
    this.rt.remainingSec = reason === 'duration' ? 0 : Math.max(0, Math.ceil((this.rt.endTimeMs - nowMs) / 1000));
    this.rt.isShocking = false;
    this.rt.shockUntilMs = 0;
    this.rt.cooldownUntilMs = 0;
    this.rt.motorActive = false;
    this.rt.motorIntensity = 0;
    this.rt.isLocked = false;
    this.rt.lockedText = '已解锁';
    this.rt.phase = 'ENDED';
    this.rt.lastUpdateMs = nowMs;

    this._effects.push({ type: 'device.lock', role: 'lock', open: true });
    this._effects.push({ type: 'device.stop-all' });

    if (reason === 'duration') {
      this._log('info', `运动目标完成！累计电击提醒 ${this.rt.shockCount} 次，设备已安全复位并解锁`, nowMs);
    } else {
      this._log('info', `训练已结束（${this.rt.endReason}），设备已安全复位`, nowMs);
    }
  }

  _statusText(warmupSec, graceSec, cooldownSec) {
    const rt = this.rt;
    if (rt.ended) return rt.endReason === 'duration' ? '训练已完成' : '训练已结束';
    if (!rt.running) return '准备就绪';
    if (rt.paused) return '已暂停';
    if (rt.phase === 'SHOCKING') return `低心率电击提醒中（${rt.lastShockVoltage}V）`;
    if (rt.phase === 'WARMUP') return `热身缓冲中（${warmupSec}s）`;
    if (rt.phase === 'COOLDOWN') return `电击冷却恢复期（${cooldownSec}s）`;
    if (rt.phase === 'WARNING') return graceSec > 0 ? `心率偏低预警（${graceSec}s 后电击）` : '心率偏低预警';
    if (rt.phase === 'SIGNAL_WAIT') return '等待心率传感器数据…';
    if (rt.phase === 'SIGNAL_LOST') return '心率信号中断，请检查佩戴';
    return '心率达标，保持节奏！';
  }

  _nextWakeAtMs(nowMs) {
    const rt = this.rt;
    if (!rt.running || rt.paused || !Number.isFinite(nowMs)) return null;
    const candidates = [rt.endTimeMs, nowMs + 1000];
    if (rt.isShocking && rt.shockUntilMs > nowMs) candidates.push(rt.shockUntilMs);
    if (rt.warmupEndMs > nowMs) candidates.push(rt.warmupEndMs);
    if (rt.cooldownUntilMs > nowMs) candidates.push(rt.cooldownUntilMs);
    if (rt.belowSinceMs !== null) {
      const graceAt = rt.belowSinceMs + Math.round(this.cfg.belowThresholdGraceSeconds * 1000);
      if (graceAt > nowMs) candidates.push(graceAt);
    }
    if (rt.signalLostSinceMs !== null) {
      const lossAt = rt.signalLostSinceMs + Math.round(this.cfg.sensorLossGraceSeconds * 1000);
      if (lossAt > nowMs) candidates.push(lossAt);
    }
    if (rt.inZoneStreakSinceMs !== null && rt.consecutiveShocks > 0) {
      const resetAt = rt.inZoneStreakSinceMs + RECOVERY_STREAK_MS;
      if (resetAt > nowMs) candidates.push(resetAt);
    }
    return Math.min(...candidates);
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.HeartRateTrainerCore = HeartRateTrainerCore;
}
if (typeof module === 'object' && module.exports) {
  module.exports = { HeartRateTrainerCore, PARAMS, VERSION };
}
