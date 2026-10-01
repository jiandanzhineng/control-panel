const { GAME_ID, VERSION, TITLE, PARAMS } = require('./pressure-edging-v2-manifest');

const PHASE_TEXT = {
  INITIAL_CALM: '平静期', MIDDLE: '中期刺激', EDGING: '边缘寸止',
  DELAY: '冷却延迟', SUB_CALM: '平静期', ENDED: '已结束',
};

const round1 = (value) => Math.round(Number(value) * 10) / 10;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function normalizedParams(input, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('参数必须是对象'), { code: 'INVALID_PARAMS' });
  }
  const next = { ...previous };
  for (const spec of PARAMS) {
    if (!(spec.key in input)) continue;
    const value = input[spec.key];
    if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') throw Object.assign(new Error(`${spec.label}必须是布尔值`), { code: 'INVALID_PARAMS' });
      next[spec.key] = value;
      continue;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw Object.assign(new Error(`${spec.label}必须是数字`), { code: 'INVALID_PARAMS' });
    // 与配置页一致只限制 min/max；原版页面不按步长取整，也不校验中间/临界的大小关系
    next[spec.key] = clamp(number, spec.min, spec.max);
  }
  return next;
}

// 游戏内微调阈值，对齐原版 game.js adjustThreshold/normalizeThresholds：临界气压没有上限
function adjustedThresholds(cfg, which, delta) {
  const c = Number(cfg.criticalPressure) || 20;
  const m = Number(cfg.midPressure) || (c * 0.9);
  let mid = m;
  let crit = c;
  if (which === 'mid') mid = Math.max(0, Math.min(c - 0.1, m + delta));
  else if (which === 'crit') crit = Math.max(m + 0.1, c + delta);
  return normalizedThresholds(mid, crit);
}

function normalizedThresholds(mid, crit) {
  const c = Number(crit) || 20;
  const midPressure = Number(clamp(Number(mid) || 0, 0, c - 0.1).toFixed(1));
  const criticalPressure = Number(Math.max(midPressure + 0.1, c).toFixed(1));
  return { midPressure, criticalPressure };
}

class PressureEdgingV2Core {
  constructor({ params, random } = {}) {
    this.random = typeof random === 'function' ? random : Math.random;
    this.cfg = normalizedParams(params || {}, Object.fromEntries(PARAMS.map((spec) => [spec.key, spec.default])));
    this.logs = [];
    this.reset();
  }

  reset() {
    this.rt = {
      running: false, paused: false, ended: false, phase: 'INITIAL_CALM',
      startedAtMs: 0, endedAtMs: 0, endTime: 0, endReason: '', pauseStartedAt: 0,
      stateTimer: 0, endCalmLocked: false, recordedMidIntensity: 0,
      currentPressure: 0, averagePressure: 0, pressureHistory: [],
      unRandomIntensity: 0, targetIntensity: 0, currentIntensity: 0, midIntensity: 0,
      lastUpdateTs: 0, lastIntensityUpdateTs: 0,
      isShocking: false, shockUntilMs: 0, shockCount: 0,
      edgingCount: 0, totalStimulationTime: 0,
    };
  }

  begin() { this.effects = []; this.turnLogs = []; }
  log(level, message, nowMs) {
    const entry = { level, message, atMs: nowMs };
    this.logs.unshift(entry);
    this.logs.length = Math.min(this.logs.length, 20);
    this.turnLogs.push(entry);
  }
  result(nowMs) {
    return { ok: true, snapshot: this.snapshot(), effects: this.effects, logs: this.turnLogs, nextWakeAtMs: this.rt.running ? Math.min(this.rt.endTime, nowMs + 80) : null };
  }

  start(nowMs) {
    this.begin();
    this.reset();
    this.rt.running = true;
    this.rt.startedAtMs = nowMs;
    this.rt.endTime = nowMs + this.cfg.duration * 60000;
    this.rt.midIntensity = 0.5 * this.cfg.maxMotorIntensity;
    this.rt.lastUpdateTs = nowMs;
    this.rt.lastIntensityUpdateTs = nowMs;
    this.effects.push(
      { type: 'device.set-report-delay', role: 'sensor', ms: 100 },
      { type: 'device.set-strength', role: 'motor', value: 0 },
      { type: 'device.lock', role: 'lock', open: false },
      { type: 'device.shock-stop', role: 'punish' },
    );
    this.log('info', '气压寸止3阶段已启动', nowMs);
    return this.result(nowMs);
  }

  pause(nowMs) {
    this.begin();
    if (!this.rt.running || this.rt.paused) return this.result(nowMs);
    this.rt.paused = true;
    this.rt.pauseStartedAt = nowMs;
    // 原版暂停：电机置 0，不打断正在进行的电击
    this.rt.currentIntensity = 0;
    this.effects.push({ type: 'device.stop-strength', role: 'motor' });
    this.log('info', '已暂停', nowMs);
    return this.result(nowMs);
  }

  resume(nowMs) {
    this.begin();
    if (!this.rt.running || !this.rt.paused) return this.result(nowMs);
    // 原版暂停期间游戏时钟照走：不顺延结束时间，也不平移状态机计时
    this.rt.paused = false;
    this.rt.pauseStartedAt = 0;
    this.log('info', '已继续', nowMs);
    return this.result(nowMs);
  }

  stop(nowMs, reason = 'stop') {
    this.begin();
    if (!this.rt.running) return this.result(nowMs);
    this.rt.running = false;
    this.rt.paused = false;
    this.rt.ended = true;
    this.rt.phase = 'ENDED';
    this.rt.endedAtMs = nowMs;
    this.rt.endReason = reason;
    this.rt.currentIntensity = 0;
    this.rt.targetIntensity = 0;
    this.rt.isShocking = false;
    this.effects.push({ type: 'device.stop-all' });
    this.log('info', `结束（边缘 ${this.rt.edgingCount}，电击 ${this.rt.shockCount}）`, nowMs);
    return this.result(nowMs);
  }

  setParams(input) {
    this.begin();
    const previousDuration = this.cfg.duration;
    this.cfg = normalizedParams(input, this.cfg);
    if (this.rt.running) this.rt.endTime += (this.cfg.duration - previousDuration) * 60000;
    this.log('info', '参数已更新', this.rt.lastUpdateTs);
    return this.result(this.rt.lastUpdateTs);
  }

  action(name, payload = {}, nowMs) {
    if (name === 'pause') return this.pause(nowMs);
    if (name === 'resume') return this.resume(nowMs);
    if (name === 'stop') return this.stop(nowMs, 'action');
    this.begin();
    if (!this.rt.running) return this.result(nowMs);
    // 原版页面的按钮在暂停中同样可用（电击、阈值微调、+10）
    if (this.rt.paused && name === 'forceEdge') return this.result(nowMs);
    if (name === 'addIntensity') {
      // 原版：只把本帧目标强度抬 10，下一帧状态机照常重算
      const delta = Number.isFinite(Number(payload.delta)) ? Number(payload.delta) : 10;
      this.rt.targetIntensity = clamp(this.rt.targetIntensity + delta, 0, this.cfg.maxMotorIntensity);
      this.log('info', `手动 +${delta} 强度 → ${this.rt.targetIntensity.toFixed(1)}`, nowMs);
    } else if (name === 'shockOnce') {
      this.shock(nowMs, true);
    } else if (name === 'forceEdge') {
      this.enterEdge(nowMs);
    } else if (name === 'adjustThreshold') {
      const delta = Number(payload.delta);
      if (!Number.isFinite(delta)) throw Object.assign(new Error('阈值调整量无效'), { code: 'INVALID_ACTION' });
      if (payload.which !== 'mid' && payload.which !== 'crit') throw Object.assign(new Error('未知阈值'), { code: 'INVALID_ACTION' });
      Object.assign(this.cfg, adjustedThresholds(this.cfg, payload.which, delta));
    } else if (name === 'setThresholds') {
      // 曲线拖动结束时提交，对齐原版 endChartDrag
      const mid = Number(payload.midPressure);
      const crit = Number(payload.criticalPressure);
      if (!Number.isFinite(mid) || !Number.isFinite(crit)) throw Object.assign(new Error('阈值无效'), { code: 'INVALID_ACTION' });
      Object.assign(this.cfg, normalizedThresholds(mid, crit));
      this.log('info', `更新阈值 中间=${this.cfg.midPressure.toFixed(1)} 临界=${this.cfg.criticalPressure.toFixed(1)}`, nowMs);
    } else {
      throw Object.assign(new Error('未知操作'), { code: 'UNKNOWN_ACTION' });
    }
    return this.result(nowMs);
  }

  step({ nowMs, events } = {}) {
    this.begin();
    if (!this.rt.running) return this.result(nowMs);
    for (const event of Array.isArray(events) ? events : []) {
      if (event?.type !== 'sensor' || event.name !== 'sphincterPressure') continue;
      this.rt.currentPressure = Number(event.value) || 0;
      this.rt.pressureHistory.push(this.rt.currentPressure);
      if (this.rt.pressureHistory.length > 60) this.rt.pressureHistory.shift();
      this.rt.averagePressure = this.rt.pressureHistory.reduce((sum, value) => sum + value, 0) / this.rt.pressureHistory.length;
    }
    if (this.rt.paused) return this.result(nowMs);
    if (nowMs >= this.rt.endTime) return this.stop(nowMs, 'duration');
    this.calculateState(nowMs);
    this.updateIntensity(nowMs);
    if (this.rt.isShocking && nowMs >= this.rt.shockUntilMs) {
      this.rt.isShocking = false;
      this.log('info', '电击结束', nowMs);
    }
    return this.result(nowMs);
  }

  shock(nowMs, force) {
    if (!force && this.rt.isShocking) return;
    this.rt.isShocking = true;
    this.rt.shockCount += 1;
    this.rt.shockUntilMs = nowMs + Math.max(100, this.cfg.shockDuration * 1000);
    this.effects.push({ type: 'device.shock', role: 'punish', voltage: this.cfg.shockVoltage, durationMs: this.cfg.shockDuration * 1000 });
    this.log('warn', `触发电击 ${this.cfg.shockVoltage}V / ${this.cfg.shockDuration}s`, nowMs);
  }

  enterEdge(nowMs) {
    this.rt.phase = 'EDGING';
    this.rt.edgingCount += 1;
    // 与原版一致：本帧目标强度归零，由 updateIntensity 立即下发 0
    this.rt.targetIntensity = 0;
    this.shock(nowMs, false);
    this.log('info', '过载！边缘寸止中', nowMs);
  }

  calculateState(nowMs) {
    const rt = this.rt;
    const cfg = this.cfg;
    const dt = Math.max(0, (nowMs - rt.lastUpdateTs) / 1000);
    rt.lastUpdateTs = nowMs;
    const pressure = rt.currentPressure;
    const takeoff = cfg.endCalmLock > 0 && rt.endTime - nowMs <= cfg.endCalmLock * 1000;
    if (takeoff) {
      rt.phase = 'SUB_CALM';
      if (!rt.endCalmLocked) {
        rt.endCalmLocked = true;
        this.log('info', '进入结束前起飞期', nowMs);
      }
    }
    if (!takeoff) rt.endCalmLocked = false;

    if (rt.phase === 'INITIAL_CALM' || rt.phase === 'SUB_CALM') {
      rt.unRandomIntensity += dt * cfg.gradualIncrease;
      const rnd = 1 + (this.random() - 0.5) * 2 * cfg.randomPercent / 100;
      rt.targetIntensity = clamp(rt.unRandomIntensity * rnd, 0, cfg.maxMotorIntensity);
      if (!takeoff && pressure > cfg.midPressure) {
        rt.recordedMidIntensity = rt.currentIntensity;
        if (rt.recordedMidIntensity < 1) rt.recordedMidIntensity = rt.targetIntensity;
        if (rt.recordedMidIntensity < 1) rt.recordedMidIntensity = cfg.maxMotorIntensity * 0.5;
        rt.phase = 'MIDDLE';
        this.log('info', `进入中期，基准强度 ${round1(rt.recordedMidIntensity)}`, nowMs);
      }
    } else if (rt.phase === 'MIDDLE') {
      rt.midIntensity = rt.recordedMidIntensity;
      const factor = (cfg.criticalPressure - pressure) / Math.max(0.01, cfg.criticalPressure - cfg.midPressure);
      rt.targetIntensity = clamp(rt.recordedMidIntensity * Math.max(0, factor), 0, cfg.maxMotorIntensity);
      if (pressure >= cfg.criticalPressure) this.enterEdge(nowMs);
      else if (pressure < cfg.midPressure) {
        rt.unRandomIntensity = rt.currentIntensity;
        rt.phase = 'SUB_CALM';
        this.log('info', '压力回落，进入平静期', nowMs);
      }
    } else if (rt.phase === 'EDGING') {
      rt.targetIntensity = 0;
      if (pressure < cfg.criticalPressure) {
        rt.phase = 'DELAY';
        rt.stateTimer = nowMs;
        this.log('info', `冷却延迟(${cfg.lowPressureDelay}s)…`, nowMs);
      }
    } else if (rt.phase === 'DELAY') {
      rt.targetIntensity = 0;
      if (pressure >= cfg.criticalPressure) rt.phase = 'EDGING';
      else if (nowMs - rt.stateTimer > cfg.lowPressureDelay * 1000) {
        if (pressure > cfg.midPressure) rt.phase = 'MIDDLE';
        else {
          const denominator = Math.max(1e-6, cfg.criticalPressure - cfg.sensitivity);
          rt.unRandomIntensity = Math.max(0, cfg.maxMotorIntensity * (cfg.criticalPressure - pressure) / denominator);
          rt.phase = 'SUB_CALM';
        }
        this.log('info', rt.phase === 'MIDDLE' ? '延迟结束，高压保持' : '延迟结束，重新积累', nowMs);
      }
    }
  }

  updateIntensity(nowMs) {
    const rt = this.rt;
    const dt = Math.max(0, (nowMs - rt.lastIntensityUpdateTs) / 1000);
    rt.lastIntensityUpdateTs = nowMs;
    const cur = rt.currentIntensity;
    const next = rt.targetIntensity < cur
      ? rt.targetIntensity
      : Math.min(cur + Math.max(0, this.cfg.rampRate) * dt, rt.targetIntensity);
    // 原版：取整值变化才下发，并把当前强度对齐到下发值；刺激时长只在下发时累计
    const rounded = Math.round(next);
    if (rounded !== Math.round(cur)) {
      if (!Number.isNaN(rounded)) {
        this.effects.push(rounded === 0
          ? { type: 'device.stop-strength', role: 'motor' }
          : { type: 'device.set-strength', role: 'motor', value: rounded });
        rt.currentIntensity = rounded;
        if (rounded > 0) rt.totalStimulationTime += dt;
      }
    } else rt.currentIntensity = next;
  }

  snapshot() {
    const rt = this.rt;
    return {
      version: VERSION, gameId: GAME_ID, title: TITLE,
      running: rt.running, paused: rt.paused, ended: rt.ended,
      phase: rt.phase, phaseText: rt.paused ? '已暂停' : PHASE_TEXT[rt.phase],
      startedAtMs: rt.startedAtMs, endedAtMs: rt.endedAtMs, endTimeMs: rt.endTime, endReason: rt.endReason,
      currentPressure: round1(rt.currentPressure), averagePressure: round1(rt.averagePressure),
      midPressure: round1(this.cfg.midPressure), criticalPressure: round1(this.cfg.criticalPressure),
      currentIntensity: round1(rt.currentIntensity), targetIntensity: round1(rt.targetIntensity),
      midIntensity: round1(rt.midIntensity || rt.recordedMidIntensity || 0),
      edgingCount: rt.edgingCount, shockCount: rt.shockCount,
      totalStimulationTime: round1(rt.totalStimulationTime), isShocking: rt.isShocking,
      params: { ...this.cfg }, logs: this.logs.slice(),
    };
  }
}

module.exports = { PressureEdgingV2Core, GAME_ID, VERSION, TITLE, PARAMS };
