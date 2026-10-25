const { VERSION, TITLE, GAME_ID, PARAMS } = require('./surge-edging-manifest');

const PHASE = {
  IDLE: 'IDLE',
  INITIAL_CALM: 'INITIAL_CALM',
  MIDDLE: 'MIDDLE',
  EDGING: 'EDGING',
  DELAY: 'DELAY',
  SUB_CALM: 'SUB_CALM',
  ENDED: 'ENDED',
};

const PHASE_TEXT = {
  IDLE: '准备就绪',
  INITIAL_CALM: '平静期',
  MIDDLE: '中期刺激',
  EDGING: '边缘寸止',
  DELAY: '冷却延迟',
  SUB_CALM: '平静期',
  ENDED: '已结束',
};

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function normalizeNumber(value, spec) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // 与配置页一致只限制 min/max；原版页面不按步长取整
  return Math.min(spec.max, Math.max(spec.min, n));
}

function defaultParams() {
  const params = {};
  for (const spec of PARAMS) params[spec.key] = spec.default;
  return params;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

class SurgeEdgingCore {
  constructor({ params, random } = {}) {
    this.random = typeof random === 'function' ? random : () => 0.5;
    this.cfg = defaultParams();
    const initial = this._applyParams(params || {}, false);
    if (!initial.error) this.cfg = initial.values;
    this._resetRuntime(0);
    this._effects = [];
    this._turnLogs = [];
  }

  start(nowMs) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (this.rt.running) return this._fail('ALREADY_RUNNING', '游戏已在运行');
    this._resetRuntime(nowMs);
    this.rt.running = true;
    this.rt.paused = false;
    this.rt.ended = false;
    this.rt.phase = PHASE.INITIAL_CALM;
    this.rt.startedAtMs = nowMs;
    this.rt.endTime = nowMs + this.cfg.duration * 60 * 1000;
    this.rt.lastUpdateTs = nowMs;
    this.rt.lastIntensityUpdateTs = nowMs;
    this.rt.midLimits = this._midLimits();
    this._effects.push({ type: 'device.set-report-delay', role: 'sensor', ms: 100 });
    this._effects.push({ type: 'device.set-strength', role: 'motor', value: 0 });
    this._effects.push({ type: 'device.lock', role: 'lock', open: false });
    this._effects.push({ type: 'device.shock-stop', role: 'punish' });
    this._log('info', `气压突变寸止已启动（窗口 ${this.cfg.surgeWindowSec}s / 抬升 ${this.cfg.surgeRiseKpa}kPa）`, nowMs);
    return this._ok(nowMs);
  }

  pause(nowMs) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._fail('NOT_RUNNING', '游戏未运行');
    if (this.rt.paused) return this._ok(nowMs);
    this.rt.paused = true;
    this.rt.pauseStartedAt = nowMs;
    // 原版：只把电机置 0，保留当前强度，不打断正在进行的电击
    this.rt.lastSentStrength = 0;
    this._effects.push({ type: 'device.stop-strength', role: 'motor' });
    this._log('info', '已暂停', nowMs);
    return this._ok(nowMs);
  }

  resume(nowMs) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._fail('NOT_RUNNING', '游戏未运行');
    if (!this.rt.paused) return this._fail('NOT_PAUSED', '游戏未暂停');
    // 原版：暂停不顺延任何计时（含结束时间），继续时只清空突变窗口
    this.rt.windowSamples = [];
    this.rt.paused = false;
    this.rt.pauseStartedAt = 0;
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
    const previousDuration = this.cfg.duration;
    const next = this._applyParams(params, true);
    if (next.error) return this._fail('INVALID_PARAMS', next.error);
    Object.assign(this.cfg, next.values);
    this.rt.midLimits = this._midLimits();
    if (this.rt.running && this.cfg.duration !== previousDuration) {
      this.rt.endTime += (this.cfg.duration - previousDuration) * 60 * 1000;
    }
    this._log('info', '参数已更新', this.rt.lastUpdateTs || 0);
    return this._ok(this.rt.lastUpdateTs || 0);
  }

  action(name, payload, nowMs) {
    if (name === 'start') return this.start(nowMs);
    if (name === 'pause') return this.pause(nowMs);
    if (name === 'resume') return this.resume(nowMs);
    if (name === 'stop') return this.stop(nowMs, 'action');
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._fail('NOT_RUNNING', '游戏未运行');
    if (this.rt.paused && name !== 'adjustMid' && name !== 'shockOnce') return this._fail('PAUSED', '游戏已暂停');
    if (name === 'forceEdge') this._forceEdge(nowMs, payload || {});
    else if (name === 'addIntensity') this._addIntensity(nowMs, payload || {});
    else if (name === 'shockOnce') this._shock(nowMs, true);
    else if (name === 'adjustMid') this._adjustMid(nowMs, payload || {});
    else return this._fail('UNKNOWN_ACTION', '未知操作');
    return this._ok(nowMs);
  }

  step({ nowMs, events } = {}) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._ok(nowMs);
    const sensorEvents = (Array.isArray(events) ? events : []).filter((event) => (
      event && event.type === 'sensor' && event.name === 'sphincterPressure'
    ));
    if (this.rt.paused) {
      // 原版：暂停只更新读数，不计入平均压
      for (const event of sensorEvents) this.rt.currentPressure = Number(event.value) || 0;
      return this._ok(nowMs);
    }
    if (nowMs >= this.rt.endTime) {
      this._finish(nowMs, 'duration');
      return this._ok(nowMs);
    }
    if (sensorEvents.length === 0) this._advance(nowMs);
    else {
      for (const event of sensorEvents) this._onPressure(nowMs, Number(event.value) || 0);
    }
    if (this.rt.running && nowMs >= this.rt.endTime) this._finish(nowMs, 'duration');
    this._syncShockFlag(nowMs);
    return this._ok(nowMs);
  }

  snapshot() {
    const paused = !!this.rt.paused;
    const phase = this.rt.phase;
    return {
      version: VERSION,
      gameId: GAME_ID,
      title: TITLE,
      running: !!this.rt.running,
      paused,
      ended: !!this.rt.ended,
      phase,
      phaseText: paused ? '已暂停' : (PHASE_TEXT[phase] || phase),
      startedAtMs: this.rt.startedAtMs || 0,
      endedAtMs: this.rt.endedAtMs || 0,
      endTimeMs: this.rt.endTime || 0,
      endReason: this.rt.endReason || '',
      currentPressure: round1(this.rt.currentPressure),
      averagePressure: round1(this.rt.averagePressure),
      midPressure: round1(this.rt.midPressure),
      currentIntensity: round1(this.rt.currentIntensity),
      targetIntensity: round1(this.rt.targetIntensity),
      edgingCount: this.rt.edgingCount,
      shockCount: this.rt.shockCount,
      edgePeak: round1(this.rt.edgePeak),
      lastEdgePeak: round1(this.rt.lastEdgePeak),
      edgeTriggerTs: this.rt.edgeTriggerTs || 0,
      endCalmLocked: !!this.rt.endCalmLocked,
      isShocking: !!this.rt.isShocking,
      params: { ...this.cfg },
      logs: this.rt.logs.map((entry) => ({ ...entry })),
    };
  }

  _beginTurn() {
    this._effects = [];
    this._turnLogs = [];
  }

  _ok(nowMs) {
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

  _resetRuntime(nowMs) {
    this.rt = {
      running: false,
      paused: false,
      ended: false,
      phase: PHASE.IDLE,
      startedAtMs: 0,
      endedAtMs: 0,
      endTime: 0,
      endReason: '',
      pauseStartedAt: 0,
      stateTimer: 0,
      endCalmLocked: false,
      currentPressure: 0,
      averagePressure: 0,
      recentPressures: [],
      windowSamples: [],
      rawOn: false,
      rawSince: 0,
      surgeActive: false,
      surgeReleased: false,
      releaseBaseline: null,
      delayMin: null,
      lastDelayMin: 0,
      edgePeak: 0,
      lastEdgePeak: 0,
      edgeTriggerTs: 0,
      rawPeak: 0,
      rawPeakTs: 0,
      midBelowTs: null,
      midPressure: 50,
      unRandomIntensity: 0,
      targetIntensity: 0,
      currentIntensity: 0,
      midLimits: this._midLimits(),
      lastSentStrength: 0,
      lastSendTs: 0,
      lastUpdateTs: nowMs,
      lastIntensityUpdateTs: nowMs,
      isShocking: false,
      shockUntilMs: 0,
      shockCount: 0,
      edgingCount: 0,
      edgeStartTs: 0,
      logs: [],
    };
  }

  _applyParams(input, strict) {
    const values = strict ? {} : { ...this.cfg };
    if (!strict) Object.assign(values, defaultParams());
    if (!input) return { values };
    for (const spec of PARAMS) {
      if (!Object.prototype.hasOwnProperty.call(input, spec.key)) continue;
      const raw = input[spec.key];
      if (spec.type === 'boolean') {
        if (typeof raw !== 'boolean') {
          if (!strict) continue; // 开局时单个非法参数只回落该项默认值，不整体重置
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

  _midLimits() {
    const inputMax = Number(this.cfg.midIntensityMax);
    const maxIntensity = Math.max(1, Number(this.cfg.maxMotorIntensity) || 50);
    const dmax = (inputMax >= 10 && inputMax <= maxIntensity) ? inputMax : Math.min(20, maxIntensity);
    const dmin = Math.min(Math.max(0, Math.min(10, Number(this.cfg.midIntensityMin) || 5)), dmax);
    return { dmin, dmax };
  }

  _log(level, message, atMs) {
    const entry = { level, message, atMs };
    this._turnLogs.push(entry);
    this.rt.logs.unshift(entry);
    if (this.rt.logs.length > 30) this.rt.logs.length = 30;
  }

  _pushAverage(pressure) {
    this.rt.recentPressures.push(pressure);
    if (this.rt.recentPressures.length > 60) this.rt.recentPressures.shift();
    const rows = this.rt.recentPressures;
    const sum = rows.reduce((total, value) => total + value, 0);
    this.rt.averagePressure = rows.length ? sum / rows.length : pressure;
  }

  _onPressure(nowMs, pressure) {
    this.rt.currentPressure = pressure;
    this._pushAverage(pressure);
    this._updateSurge(nowMs, pressure);
    this._advance(nowMs);
  }

  _advance(nowMs) {
    if (!this.rt.running || this.rt.paused) return;
    this._calculateState(nowMs);
    this._updateIntensity(nowMs);
  }

  // 突变检测：当前值 − 本窗口[-τ,0]最小值 ≥ surgeRiseKpa，且连续保持 ≥ minSurgeMs；
  // 峰值取最短持续区间内的压力最大值 rawPeak（含时间戳，用于中间压更新与绿标定位）；
  // 释放基准 = 触发瞬间的窗口最小值 w1Min；边缘期结束：气压回落到基准 + 0.2kPa 之下。
  _updateSurge(nowMs, pressure) {
    const winMs = Math.max(50, (Number(this.cfg.surgeWindowSec) || 1.5) * 1000);
    this.rt.windowSamples.push({ ts: nowMs, p: pressure });
    const cutoff = nowMs - 2 * winMs;
    while (this.rt.windowSamples.length && this.rt.windowSamples[0].ts < cutoff) {
      this.rt.windowSamples.shift();
    }
    if (this.rt.phase === PHASE.DELAY) return;
    const t0 = nowMs - winMs;
    let w1Max = -Infinity;
    let w1Min = Infinity;
    for (const sample of this.rt.windowSamples) {
      if (sample.ts > t0) {
        w1Max = Math.max(w1Max, sample.p);
        w1Min = Math.min(w1Min, sample.p);
      }
    }
    if (w1Max === -Infinity || w1Min === Infinity) {
      this.rt.rawOn = false;
      this.rt.surgeActive = false;
      this.rt.surgeReleased = false;
      return;
    }
    const rise = Math.max(0.1, Number(this.cfg.surgeRiseKpa) || 1);
    const on = (pressure - w1Min) >= rise;
    if (on) {
      if (!this.rt.rawOn) {
        this.rt.rawSince = nowMs;
        this.rt.rawPeak = pressure;
        this.rt.rawPeakTs = nowMs;
      }
      this.rt.rawOn = true;
      if (pressure > this.rt.rawPeak) {
        this.rt.rawPeak = pressure;
        this.rt.rawPeakTs = nowMs;
      }
      if (!this.rt.surgeActive && (nowMs - this.rt.rawSince) >= (Number(this.cfg.minSurgeMs) || 100)) {
        this.rt.surgeActive = true;
        this.rt.edgePeak = this.rt.rawPeak;
        this.rt.edgeTriggerTs = this.rt.rawPeakTs;
        this.rt.releaseBaseline = w1Min;
      }
    } else {
      this.rt.rawOn = false;
      this.rt.surgeActive = false;
      this.rt.rawPeak = 0;
      this.rt.rawPeakTs = 0;
    }
    const baseline = this.rt.releaseBaseline == null ? w1Min : this.rt.releaseBaseline;
    this.rt.surgeReleased = pressure < baseline + 0.2;
  }

  _shock(nowMs, force) {
    if (!force && this.rt.isShocking) return;
    this.rt.isShocking = true;
    this.rt.shockCount += 1;
    const durationMs = Math.round(Math.max(100, this.cfg.shockDuration * 1000));
    this.rt.shockUntilMs = nowMs + durationMs;
    this._effects.push({
      type: 'device.shock',
      role: 'punish',
      voltage: Math.round(this.cfg.shockVoltage),
      durationMs,
    });
    this._log('warn', `突发电击 ${this.cfg.shockVoltage}V / ${this.cfg.shockDuration}s`, nowMs);
  }

  _syncShockFlag(nowMs) {
    if (this.rt.isShocking && this.rt.shockUntilMs && nowMs >= this.rt.shockUntilMs) {
      this.rt.isShocking = false;
      this._log('info', '电击结束', nowMs);
    }
  }

  _adjustMid(nowMs, payload) {
    const delta = Number(payload.delta);
    if (!Number.isFinite(delta)) return;
    this.rt.midPressure = Math.max(1, round1(this.rt.midPressure + delta));
    this._log('info', `手动微调中间压力 → ${this.rt.midPressure.toFixed(1)}`, nowMs);
  }

  _addIntensity(nowMs, payload) {
    const delta = Number.isFinite(Number(payload.delta)) ? Number(payload.delta) : 10;
    const next = Math.max(0, Math.min(this.cfg.maxMotorIntensity, this.rt.targetIntensity + delta));
    this.rt.targetIntensity = next;
    this._log('info', `手动 +${delta} 强度 → ${next.toFixed(1)}`, nowMs);
  }

  _forceEdge(nowMs, payload) {
    if (this.rt.phase === PHASE.EDGING) return;
    const peak = Number(payload.peak);
    this.rt.edgePeak = Number.isFinite(peak) && peak > 0 ? peak : Math.max(this.rt.currentPressure, 1);
    this.rt.surgeActive = true;
    this._enterEdging(nowMs);
  }

  _enterMid(nowMs) {
    this.rt.phase = PHASE.MIDDLE;
    this.rt.midBelowTs = null; // 重置连续回落计时
    this._log('info', `进入中期刺激（P1=${this.rt.midPressure.toFixed(1)}，ΔP=${this.cfg.midOffsetKpa}）`, nowMs);
  }

  _enterEdging(nowMs) {
    const peak = this.rt.edgePeak > 0 ? this.rt.edgePeak : this.rt.currentPressure;
    this.rt.lastEdgePeak = round1(peak);
    const peakMid = this.rt.lastEdgePeak - (Number(this.cfg.midOffsetKpa) || 0.5);
    const delayFloor = (Number(this.rt.lastDelayMin) || 0) + 1;
    this.rt.midPressure = round1(Math.max(1, Math.max(peakMid, delayFloor)));
    this.rt.edgePeak = 0;
    this.rt.phase = PHASE.EDGING;
    this.rt.edgeStartTs = nowMs;
    this.rt.edgingCount += 1;
    this._log('info', `进入边缘期 #${this.rt.edgingCount}，触发峰值 ${this.rt.lastEdgePeak}，中间压 → ${this.rt.midPressure}`, nowMs);
    this._shock(nowMs, false);
  }

  _calculateState(nowMs) {
    const dtSec = Math.max(0, (nowMs - this.rt.lastUpdateTs) / 1000);
    this.rt.lastUpdateTs = nowMs;
    const pressure = this.rt.currentPressure;
    const remainMs = this.rt.endTime - nowMs;
    const takeoffMs = Math.max(0, (Number(this.cfg.endCalmLock) || 0) * 1000);
    const inTakeoff = takeoffMs > 0 && remainMs <= takeoffMs;
    if (inTakeoff) {
      if (this.rt.phase !== PHASE.SUB_CALM) this.rt.phase = PHASE.SUB_CALM;
      if (!this.rt.endCalmLocked) {
        this.rt.endCalmLocked = true;
        this._log('info', '进入结束前起飞期', nowMs);
      }
    } else if (this.rt.endCalmLocked) this.rt.endCalmLocked = false;

    const surge = this.rt.surgeActive;
    if (this.rt.phase === PHASE.INITIAL_CALM || this.rt.phase === PHASE.SUB_CALM) {
      this.rt.unRandomIntensity += dtSec * (Number(this.cfg.gradualIncrease) || 0);
      const rnd = 1 + (this.random() - 0.5) * 2 * ((Number(this.cfg.randomPercent) || 0) / 100);
      this.rt.targetIntensity = Math.max(0, Math.min(this.cfg.maxMotorIntensity, this.rt.unRandomIntensity * rnd));
      if (!inTakeoff && surge && this.rt.edgePeak) {
        this.rt.unRandomIntensity = this.rt.currentIntensity;
        this._enterEdging(nowMs);
      } else if (!inTakeoff && pressure >= this.rt.midPressure) {
        this.rt.unRandomIntensity = this.rt.currentIntensity;
        this._enterMid(nowMs);
      }
      return;
    }
    if (this.rt.phase === PHASE.MIDDLE) {
      const p1 = this.rt.midPressure;
      const dP = Math.max(0.01, Number(this.cfg.midOffsetKpa) || 0.5);
      const lim = this.rt.midLimits || { dmin: 5, dmax: 20 };
      const designed = pressure >= p1 + dP
        ? lim.dmin
        : lim.dmax - (lim.dmax - lim.dmin) * ((pressure - p1) / dP);
      // 限制在 [dmin, dmax]：midDelay 内压力回落到 P1 以下时公式会算出 >dmax，必须封顶
      this.rt.targetIntensity = Math.max(lim.dmin, Math.min(lim.dmax, designed));
      if (surge && this.rt.edgePeak) {
        this.rt.unRandomIntensity = this.rt.currentIntensity;
        this._enterEdging(nowMs);
        return;
      }
      // 回落判据：压力【连续】低于中间值 midDelay 秒后才转平静期（回升即重置计时）；
      // 边缘期触发不受影响
      if (pressure < this.rt.midPressure) {
        if (this.rt.midBelowTs == null) this.rt.midBelowTs = nowMs;
        if ((nowMs - this.rt.midBelowTs) > (Number(this.cfg.midDelay) || 0) * 1000) {
          this.rt.midBelowTs = null;
          this.rt.unRandomIntensity = this.rt.currentIntensity;
          this.rt.phase = PHASE.SUB_CALM;
          this._log('info', '压力连续回落，进入平静期', nowMs);
        }
      } else {
        this.rt.midBelowTs = null;
      }
      return;
    }
    if (this.rt.phase === PHASE.EDGING) {
      this.rt.targetIntensity = 0;
      const edgeOver = (nowMs - this.rt.edgeStartTs) > (Number(this.cfg.maxEdgeSec) || 5) * 1000;
      if (this.rt.surgeReleased || edgeOver) {
        if (edgeOver) this._log('info', `边缘期超时(${Number(this.cfg.maxEdgeSec) || 5}s)，强制进入冷却`, nowMs);
        this.rt.delayMin = null;
        this.rt.phase = PHASE.DELAY;
        this.rt.stateTimer = nowMs;
        this._log('info', `冷却延迟(${this.cfg.lowPressureDelay}s)…`, nowMs);
      }
      return;
    }
    if (this.rt.phase === PHASE.DELAY) {
      this.rt.targetIntensity = 0;
      this.rt.delayMin = this.rt.delayMin == null ? pressure : Math.min(this.rt.delayMin, pressure);
      if (nowMs - this.rt.stateTimer > (Number(this.cfg.lowPressureDelay) || 0) * 1000) {
        this.rt.lastDelayMin = this.rt.delayMin == null ? pressure : this.rt.delayMin;
        const denom = Math.max(1, this.rt.midPressure);
        this.rt.unRandomIntensity = Math.max(0, this.cfg.maxMotorIntensity * (this.rt.midPressure - pressure) / denom);
        this.rt.phase = PHASE.SUB_CALM;
        this._log('info', '冷却结束，进入平静期', nowMs);
      }
    }
  }

  _updateIntensity(nowMs) {
    if (!this.rt.running || this.rt.paused) return;
    if (!this.rt.lastIntensityUpdateTs) this.rt.lastIntensityUpdateTs = nowMs;
    const dtSec = Math.max(0, (nowMs - this.rt.lastIntensityUpdateTs) / 1000);
    this.rt.lastIntensityUpdateTs = nowMs;
    const current = this.rt.currentIntensity;
    const target = this.rt.targetIntensity;
    const next = target < current ? target : Math.min(current + Math.max(0, this.cfg.gradualIncrease) * dtSec, target);
    const rounded = Math.round(next);
    // 限速合并（latest-wins）：平静期/中期每 sendIntervalMs（默认1000ms）发一次最新设计值；
    // 边缘期触发时 target 归零 → emergencyZero 立即发送停止命令，保证安全。
    const interval = Math.max(200, Number(this.cfg.sendIntervalMs) || 1000);
    const due = (nowMs - (this.rt.lastSendTs || 0)) >= interval;
    const emergencyZero = rounded === 0 && this.rt.lastSentStrength > 0;
    if (emergencyZero) {
      this._effects.push({ type: 'device.stop-strength', role: 'motor' });
      this.rt.lastSentStrength = 0;
      this.rt.lastSendTs = nowMs;
      this.rt.currentIntensity = 0;
    } else if (due) {
      this._effects.push({ type: 'device.set-strength', role: 'motor', value: rounded });
      this.rt.lastSentStrength = rounded;
      this.rt.lastSendTs = nowMs;
      this.rt.currentIntensity = rounded;
    } else {
      this.rt.currentIntensity = next;
    }
  }

  _finish(nowMs, reason) {
    this.rt.running = false;
    this.rt.paused = false;
    this.rt.ended = true;
    this.rt.endedAtMs = nowMs;
    this.rt.endReason = reason || 'stop';
    this.rt.phase = PHASE.ENDED;
    this.rt.targetIntensity = 0;
    this.rt.currentIntensity = 0;
    this.rt.unRandomIntensity = 0;
    this.rt.isShocking = false;
    this._effects.push({ type: 'device.stop-strength', role: 'motor' });
    this._effects.push({ type: 'device.shock-stop', role: 'punish' });
    this._effects.push({ type: 'device.lock', role: 'lock', open: true });
    this._effects.push({ type: 'device.set-report-delay', role: 'sensor', ms: 5000 });
    this._effects.push({ type: 'device.stop-all' });
    this._log('info', `结束（边缘 ${this.rt.edgingCount} 次，电击 ${this.rt.shockCount} 次）`, nowMs);
  }

  _nextWake(nowMs) {
    if (!this.rt.running || this.rt.paused) return null;
    const candidates = [this.rt.endTime, (this.rt.lastSendTs || nowMs) + this.cfg.sendIntervalMs];
    if (this.rt.phase === PHASE.EDGING) {
      candidates.push(this.rt.edgeStartTs + this.cfg.maxEdgeSec * 1000);
    }
    if (this.rt.phase === PHASE.DELAY) {
      candidates.push(this.rt.stateTimer + this.cfg.lowPressureDelay * 1000);
    }
    if (this.rt.shockUntilMs > nowMs) candidates.push(this.rt.shockUntilMs);
    const future = candidates.filter((value) => Number.isFinite(value) && value > nowMs);
    return future.length ? Math.min(...future) : nowMs + 1000;
  }
}

module.exports = {
  SurgeEdgingCore,
  VERSION,
  TITLE,
  GAME_ID,
  PARAMS,
  PHASE,
};
