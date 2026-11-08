// 女仆偷懒惩罚 — 分离式游戏核心（纯逻辑，宿主后端加载）
// 契约：docs/architecture/split-game-contract.md
// 行为逐条对齐页面版 game.js（v2.1.3）：.tmp/maid-punishment-behavior.md 是验收清单。
// 本文件不碰 DOM / 计时器 / 网络 / 文件；时间只来自 nowMs，随机只用注入的 random()。
//
// 事件契约（宿主 → 核心，events 数组元素；manifest 声明 "events":"v2"，见契约文档第 3 节）：
//   { type:'device-property', role, deviceId, name:'tiptoePressure', value }  踮脚压力（角色 tiptoeSensor）
//   { type:'device-property', role, deviceId, name:'button0'|'button1', value }  按钮 1/0（角色 qtz）
//   { type:'action', name:'lock-key', role, deviceId }                         手动模式：锁按键
//   { type:'device-event', role, deviceId, name:'key_clicked', payload }       设备原始消息（同上）
// 开局补发的属性事件带 seed:true：按钮值只作为基线（等真实变化才判违规），压力保持 readValue 语义。
// 兼容别名：pressure1 / sphincterPressure = tiptoePressure；buttonInput0/1 = button0/1。
// 宿主只转发 deviceMap 里已映射设备的事件，且属性只在值真的变化时转发。

const GAME_ID = 'maid-punishment';
const VERSION = '2.2.3';
const TITLE = '女仆偷懒惩罚';

const LOG_LIMIT = 10;          // 页面日志面板保留最近 10 条（game.js L46）
const TD01_RAMP_MS = 5000;     // TD01 每 5 秒递增一次（game.js L169）
const TD01_START_INTENSITY = 10; // 启动强度（game.js L92）
const TD01_MAX_INTENSITY = 255;  // 递增上限（game.js L170）
const PROGRESSIVE_STEP_V = 5;    // 渐进模式每次电击 +5V（game.js L67）
const UNSAFE_VOLTAGE_CAP = 30;   // 非 allowUnsafeIntensity 时的电压上限（game.js L70）
const VOLTAGE_ABS_CAP = 100;     // 渐进模式的绝对上限（game.js L68）
const DEFAULT_SHOCK_SECONDS = 10; // 页面不发时长；真正停掉电击的是 bridge 会话安全自动停止（默认 10s）
const MIN_DURATION_MINUTES = 1;

// 与 index.html 内联 manifest 的 params 一致（键 / 默认值 / 边界），页面侧同名校验
const PARAMS = [
  { key: 'duration', type: 'number', default: 10, min: 1, max: 120 },
  { key: 'shockIntensity', type: 'number', default: 24, min: 1, max: 50 },
  { key: 'progressiveIntensity', type: 'boolean', default: false },
  { key: 'maxIntensityIncrease', type: 'number', default: 10, min: 0, max: 30, visibleWhen: { key: 'progressiveIntensity', equals: true } },
  { key: 'allowUnsafeIntensity', type: 'boolean', default: false },
  { key: 'td01DelaySeconds', type: 'number', default: 5, min: 0, max: 300 },
  { key: 'td01IntensityIncrease', type: 'number', default: 50, min: 1, max: 255 },
  { key: 'td01ShockProbability', type: 'number', default: 0, min: 0, max: 100 },
  { key: 'manualStart', type: 'boolean', default: false },
  { key: 'tiptoePressureThreshold', type: 'number', default: 100, min: 1, max: 1000 },
  { key: 'tiptoeDebounceMs', type: 'number', default: 300, min: 0, max: 2000, hidden: true },
  { key: 'shockDurationSeconds', type: 'number', default: DEFAULT_SHOCK_SECONDS, min: 1, max: 10 },
];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 页面版 `cfg.x || fallback` 的等价写法：0 / 空 / 非法都回落默认值
function orDefault(value, fallback) {
  const n = toFinite(value);
  return (n && n !== 0) ? n : fallback;
}

// 有限数就用它（含 0），否则回落默认值；用于 td01DelaySeconds 这类 0 是合法值的参数
function orNumber(value, fallback) {
  const n = toFinite(value);
  return n == null ? fallback : n;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function defaultParams() {
  const out = {};
  for (const spec of PARAMS) out[spec.key] = spec.default;
  return out;
}

// 边界与页面一致：配置页已限 min/max，宿主 setParams 也可能直接传值，这里再钳一次
function normalizeParam(spec, raw) {
  if (spec.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === 1) return true;
    if (raw === 'false' || raw === 0) return false;
    return null;
  }
  const n = toFinite(raw);
  if (n == null) return null;
  return clamp(n, spec.min, spec.max);
}

// 页面版是整份覆盖：缺失键保持默认值，非法值回落默认值（不抛错，契约要求 setParams 不崩）
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

class MaidPunishmentCore {
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
    if (this.rt.running) return this._fail('ALREADY_RUNNING', '游戏已在运行');
    this._resetRuntime(nowMs);
    this.rt.running = true;
    this.rt.paused = false;
    this.rt.ended = false;
    this.rt.startedAtMs = nowMs;
    this.rt.endTimeMs = nowMs + Math.max(MIN_DURATION_MINUTES, Math.floor(this.cfg.duration)) * 60000;
    this.rt.lastNoShockTs = nowMs;
    this.rt.remainingSec = Math.max(MIN_DURATION_MINUTES, Math.floor(this.cfg.duration)) * 60;
    // 页面版 start()：非手动 → setLock(false)（加锁）；手动 → setLock(true)（解锁）并等锁按键
    if (this.cfg.manualStart) {
      this.rt.waitingForManualStart = true;
      this._setLock(true, nowMs, false);
    } else {
      this.rt.waitingForManualStart = false;
      this._setLock(false, nowMs, false);
    }
    this._log('info', '女仆惩罚启动', nowMs);
    return this._ok(nowMs);
  }

  pause(nowMs) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._fail('NOT_RUNNING', '游戏未运行');
    if (this.rt.paused) return this._ok(nowMs);
    this.rt.paused = true;
    // 页面版暂停按钮：先停正在进行的电击与 TD01，再置状态；总时长不顺延
    this._stopShockSeq(nowMs, false);
    this._stopTd01(nowMs, false);
    this._log('info', '已暂停', nowMs);
    return this._ok(nowMs);
  }

  resume(nowMs) {
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._fail('NOT_RUNNING', '游戏未运行');
    if (!this.rt.paused) return this._fail('NOT_PAUSED', '游戏未暂停');
    this.rt.paused = false;
    this._log('info', '已继续', nowMs);
    // 恢复后按当前传感器状态重新评估（页面版 L239）
    this._applyTiptoeState(nowMs);
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
    this.cfg = mergeParams(this.cfg, params);
    if (this.rt.running && this.cfg.duration !== previousDuration) {
      // 与其它宿主 core 一致：运行中改时长顺延结束时间（页面版无参数 UI，无对应行为）
      this.rt.endTimeMs += (this.cfg.duration - previousDuration) * 60000;
    }
    this._log('info', '参数已更新', this.rt.lastUpdateTs);
    return this._ok(this.rt.lastUpdateTs);
  }

  action(name, payload, nowMs) {
    if (name === 'start') return this.start(nowMs);
    if (name === 'pause') return this.pause(nowMs);
    if (name === 'resume') return this.resume(nowMs);
    if (name === 'stop') return this.stop(nowMs, 'action');
    this._beginTurn();
    if (!Number.isFinite(nowMs)) return this._fail('INVALID_TIME', 'nowMs 必须是有限数字');
    if (!this.rt.running) return this._fail('NOT_RUNNING', '游戏未运行');
    if (name === 'forceStart') this._forceStart(nowMs);
    else if (name === 'unlock') this._setLock(true, nowMs, true);
    else if (name === 'shockOnce') this._manualShock(nowMs);
    else return this._fail('UNKNOWN_ACTION', '未知操作');
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
    // 设备事件照常处理：页面版暂停时 loop 直接 return，但设备回调
    // （onProperty/onValue → evalPressure、onMessage → forceStart）不受暂停影响，
    // 只有 applyTiptoeState 内部 return 才不因传感器触发电击。
    this._applyEvents(nowMs, rows);
    // 暂停：不推进时间、不评估传感器、不做结束判定（页面版 loop 前三行 return）
    if (this.rt.paused) return this._ok(nowMs);
    this._advance(nowMs);
    if (this.rt.running && !this.rt.waitingForManualStart && nowMs >= this.rt.endTimeMs) {
      this._finish(nowMs, 'duration');
    }
    this.rt.lastUpdateTs = nowMs;
    return this._ok(nowMs);
  }

  // 页面只渲染这份快照（键名对齐原页面 view 字段 + data-bind）
  snapshot() {
    const rt = this.rt;
    const paused = !!rt.paused;
    return {
      version: VERSION,
      gameId: GAME_ID,
      title: TITLE,
      running: !!rt.running,
      paused,
      ended: !!rt.ended,
      waitingForManualStart: !!rt.waitingForManualStart,
      startedAtMs: rt.startedAtMs || 0,
      endedAtMs: rt.endedAtMs || 0,
      endTimeMs: rt.endTimeMs || 0,
      endReason: rt.endReason || '',
      remainingSec: rt.remainingSec,
      statusText: this._statusText(),
      btnText: paused ? '继续' : '暂停',
      isLocked: !!rt.isLocked,
      lockedText: rt.lockedText || '',
      button0Pressed: !!rt.button0Pressed,
      button1Pressed: !!rt.button1Pressed,
      hasPressure: !!rt.hasPressure,
      pressure1: Number.isFinite(rt.pressure1) ? Math.round(rt.pressure1 * 10) / 10 : null,
      pressureViolated: !!rt.pressureViolated,
      isShocking: !!rt.isShocking,
      shockCount: rt.shockCount,
      lastShockVoltage: rt.lastShockVoltage,
      td01Active: !!rt.td01Active,
      td01Intensity: rt.td01Intensity,
      hasTd01: !!rt.hasTd01,
      lastNoShockTs: rt.lastNoShockTs || 0,
      nextWakeAtMs: this._nextWake(rt.lastUpdateTs),
      params: { ...this.cfg },
      logs: rt.logs.map((entry) => ({ ...entry })),
    };
  }

  _statusText() {
    const rt = this.rt;
    if (rt.isShocking) return `电击中(${rt.lastShockVoltage}V)`;
    if (rt.ended) return '已结束';
    if (rt.paused) return '已暂停';
    if (rt.waitingForManualStart) return '等待手动开启';
    return '运行中';
  }

  // ---- 内部：回合框架 ----

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
      endReason: '',
      startedAtMs: 0,
      endedAtMs: 0,
      endTimeMs: 0,
      waitingForManualStart: false,
      isLocked: false,
      lockedText: '',
      button0Pressed: false,
      button1Pressed: false,
      hasPressure: false, // 收到第一个压力事件后为 true（页面版 isMapped(tiptoeSensor) 的等价物）
      pressure1: null,
      pressureViolated: false,
      pressureViolatedSince: 0,
      lost: false, // 上一次判定的「没踮脚」状态
      shockEndedWhileLost: false, // 电击因时长到点自动结束、而违规尚未解除
      remainingSec: null,
      isShocking: false,
      lastShockVoltage: 0,
      shockCount: 0,
      hasTd01: true,
      td01Active: false,
      td01Intensity: 0,
      lastTd01IncreaseTs: 0,
      lastNoShockTs: nowMs || 0,
      lastUpdateTs: nowMs || 0,
      logs: [],
    };
  }

  _log(level, message, atMs) {
    const entry = { level, message, atMs: Number.isFinite(atMs) ? atMs : this.rt.lastUpdateTs };
    this._turnLogs.push(entry);
    this.rt.logs.unshift(entry);
    if (this.rt.logs.length > LOG_LIMIT) this.rt.logs.length = LOG_LIMIT;
  }

  // 有截止时间的下一步：宿主可以据此提前唤醒（宿主自身仍按 80ms 定时 tick）
  _nextWake(nowMs) {
    const rt = this.rt;
    if (!rt.running || rt.paused) return null;
    const candidates = [rt.endTimeMs];
    if (rt.isShocking && rt.shockUntilMs > nowMs) candidates.push(rt.shockUntilMs);
    if (!rt.waitingForManualStart) {
      if (rt.td01Active) candidates.push((rt.lastTd01IncreaseTs || nowMs) + TD01_RAMP_MS);
      else if (!rt.isShocking && rt.lastNoShockTs) {
        candidates.push(rt.lastNoShockTs + Math.round(orNumber(this.cfg.td01DelaySeconds, 5) * 1000));
      }
      if (rt.pressureViolatedSince && !rt.pressureViolated) {
        candidates.push(rt.pressureViolatedSince + orNumber(this.cfg.tiptoeDebounceMs, 0));
      }
    }
    const future = candidates.filter((value) => Number.isFinite(value) && value > nowMs);
    return future.length ? Math.min(...future) : nowMs + 1000;
  }

  // ---- 内部：设备事件 ----

  _applyEvents(nowMs, events) {
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const type = String(event.type || '');
      const name = String(event.name || '');
      const value = toFinite(event.value);
      if (type === 'action') {
        if (name === 'lock-key' || name === 'lockKey') this._onLockKey(nowMs);
        continue;
      }
      if (type === 'device-event') {
        if (name === 'key_clicked') this._onLockKey(nowMs);
        continue;
      }
      if (name === 'button0' || name === 'buttonInput0' || name === 'button1' || name === 'buttonInput1') {
        this._onButton(
          nowMs,
          name === 'button0' || name === 'buttonInput0' ? 0 : 1,
          value === 1,
          { seed: event.seed === true },
        );
        continue;
      }
      // 踮脚压力：宿主按设备真实属性名转发（CUNZHI01 是 pressure1、QTZ 是 button0/1 派生），
      // 三个名字都接受；同一 nowMs 内写同一个值不会重复判定。
      if (name === 'tiptoePressure' || name === 'pressure1' || name === 'sphincterPressure') {
        this._onPressure(nowMs, value == null ? 0 : value);
      }
    }
  }

  _onButton(nowMs, index, pressed, { seed = false } = {}) {
    if (index === 0) this.rt.button0Pressed = pressed;
    else this.rt.button1Pressed = pressed;
    // 开局补发的按钮基线只作为状态：页面版只监听按钮「变化」，启动时正在按住的按钮不电击，
    // 必须等真实变化（松手后重新按下）才判违规。压力走 _onPressure，保持页面版 readValue 语义。
    if (seed) return;
    this._applyTiptoeState(nowMs);
  }

  _onPressure(nowMs, pressure) {
    this.rt.pressure1 = pressure;
    this.rt.hasPressure = true; // 有压力设备在报数（页面版 hasPressure = isMapped）
    const over = pressure > orNumber(this.cfg.tiptoePressureThreshold, 0);
    if (over) {
      if (!this.rt.pressureViolatedSince) this.rt.pressureViolatedSince = nowMs;
      if (!this.rt.pressureViolated && (nowMs - this.rt.pressureViolatedSince) >= orNumber(this.cfg.tiptoeDebounceMs, 0)) {
        this.rt.pressureViolated = true;
      }
    } else if (this.rt.pressureViolated || this.rt.pressureViolatedSince) {
      this.rt.pressureViolated = false;
      this.rt.pressureViolatedSince = 0;
    }
    this._applyTiptoeState(nowMs);
  }

  _onLockKey(nowMs) {
    // 页面版锁按键回调直接调 forceStart()：守卫只看 isActive，不看 paused/等待状态。
    // 暂停中收到锁按键，页面照样会开表（startTime 重置、setLock(false)），只是 paused 仍为真。
    if (!this.cfg.manualStart) return;
    if (!this.rt.running) return;
    this._forceStart(nowMs);
  }

  // 违规判定：按钮线或踮脚压力线任一成立 = 没踮脚
  _applyTiptoeState(nowMs) {
    const rt = this.rt;
    if (rt.paused) return; // 暂停期间不因传感器触发电击；恢复时会重新评估
    const lost = rt.button0Pressed || rt.button1Pressed || (rt.hasPressure && rt.pressureViolated);
    rt.lost = lost;
    if (lost && !rt.isShocking) {
      this._startShockSeq(nowMs);
      this._resetTd01(nowMs);
    } else if (!lost && rt.isShocking) {
      this._stopShockSeq(nowMs, true);
      rt.lastNoShockTs = nowMs;
    } else if (!lost && rt.shockEndedWhileLost) {
      // 电击已按 shockDuration 自动停掉后违规才解除：页面版此时 isShocking 仍为真，
      // 走的是上面那条分支；这里补一次同样的「重置未受罚计时」。
      // 只在「到点自动停」时置位，暂停停掉的情况与页面一致（页面此时什么都不做）。
      rt.shockEndedWhileLost = false;
      rt.lastNoShockTs = nowMs;
    }
  }

  _calcShockVoltage() {
    const cfg = this.cfg;
    let voltage = orDefault(cfg.shockIntensity, 24);
    if (cfg.progressiveIntensity) {
      // 页面版用「本次电击之前」的累计次数算增幅（game.js L75 先算电压、L77 才自增）
      const increase = Math.min(this.rt.shockCount * PROGRESSIVE_STEP_V, orDefault(cfg.maxIntensityIncrease, 0));
      voltage = Math.min(voltage + increase, VOLTAGE_ABS_CAP);
    }
    if (!cfg.allowUnsafeIntensity) voltage = Math.min(voltage, UNSAFE_VOLTAGE_CAP);
    return Math.round(voltage);
  }

  _startShockSeq(nowMs, extra) {
    const rt = this.rt;
    if (rt.isShocking) return;
    const voltage = this._calcShockVoltage();
    rt.isShocking = true;
    rt.lastShockVoltage = voltage;
    rt.shockCount += 1;
    const durationMs = Math.round(Math.max(1, orNumber(this.cfg.shockDurationSeconds, DEFAULT_SHOCK_SECONDS)) * 1000);
    rt.shockUntilMs = nowMs + durationMs;
    this._effects.push({ type: 'device.shock', role: 'shock', voltage, durationMs });
    if (!extra) this._log('warn', `电击 ${voltage}V（第 ${rt.shockCount} 次）`, nowMs);
  }

  _stopShockSeq(nowMs, fromTiptoe) {
    const rt = this.rt;
    if (!rt.isShocking) return;
    rt.isShocking = false;
    rt.shockUntilMs = 0;
    rt.shockEndedWhileLost = false;
    this._effects.push({ type: 'device.shock-stop', role: 'shock' });
    if (fromTiptoe) rt.lastNoShockTs = nowMs;
  }

  // 手动「电击一次」：页面没有这个按钮，分离式页面的操作员视图需要它
  _manualShock(nowMs) {
    this._startShockSeq(nowMs, false);
    this._resetTd01(nowMs);
  }

  // ---- 内部：TD01 ----

  _startTd01(nowMs) {
    const rt = this.rt;
    if (!rt.hasTd01 || rt.td01Active) return;
    rt.td01Active = true;
    rt.td01Intensity = TD01_START_INTENSITY;
    rt.lastTd01IncreaseTs = nowMs;
    this._effects.push({ type: 'device.set-strength', role: 'motor', value: TD01_START_INTENSITY });
    this._log('info', 'TD01 启动', nowMs);
    const probability = clamp(toFinite(this.cfg.td01ShockProbability) || 0, 0, 100);
    if (probability > 0 && this.random() * 100 < probability) {
      // 页面版这一次额外电击不写状态文本、不写日志，但计入电击次数（game.js L97-101）
      this._startShockSeq(nowMs, true);
    }
  }

  _stopTd01(nowMs) {
    const rt = this.rt;
    if (!rt.td01Active) return;
    this._effects.push({ type: 'device.stop-strength', role: 'motor' });
    rt.td01Active = false;
    rt.td01Intensity = 0;
  }

  _resetTd01(nowMs) {
    this._stopTd01(nowMs);
    this.rt.lastNoShockTs = nowMs;
  }

  // ---- 内部：推进 ----

  _advance(nowMs) {
    const rt = this.rt;
    if (!rt.running || rt.paused || rt.waitingForManualStart) return;
    // 页面版 loop 每 500ms 重新 eval 一次压力：值不再变化时靠它把防抖判成违规（game.js L156-158）
    rt.remainingSec = Math.max(0, Math.ceil((rt.endTimeMs - nowMs) / 1000));
    if (rt.hasPressure && rt.pressureViolatedSince && !rt.pressureViolated && rt.pressure1 != null) {
      this._onPressure(nowMs, rt.pressure1);
    }
    // 页面版顺序：压力补判 → 到点结束 → 电击时长 → TD01；结束这一 tick 不再推进 TD01
    if (nowMs >= rt.endTimeMs) return;
    if (rt.isShocking && rt.shockUntilMs && nowMs >= rt.shockUntilMs) {
      // 电击时长到点（宿主侧的 shock 意图也带同样时长，两边一致）；
      // 这不是「违规解除」，所以不重置 lastNoShockTs；违规仍成立时记一笔，
      // 等违规解除时补做页面版「解除违规即重置计时」的动作。
      const stillLost = rt.button0Pressed || rt.button1Pressed || (rt.hasPressure && rt.pressureViolated);
      this._stopShockSeq(nowMs, false);
      if (stillLost) rt.shockEndedWhileLost = true;
    }
    // 页面版里「正在违规」时电击一直持续，TD01 因此始终被 isShocking 挡住；
    // 分离式下电击有时长上限，这里额外用 lost 挡住，避免连续违规时 TD01 反而开爬。
    if (rt.hasTd01 && !rt.isShocking && !rt.lost) {
      if (!rt.td01Active && (nowMs - rt.lastNoShockTs) >= Math.round(orNumber(this.cfg.td01DelaySeconds, 5) * 1000)) {
        this._startTd01(nowMs);
      }
      if (rt.td01Active && (nowMs - (rt.lastTd01IncreaseTs || 0)) >= TD01_RAMP_MS) {
        rt.td01Intensity = Math.min(rt.td01Intensity + orDefault(this.cfg.td01IntensityIncrease, 50), TD01_MAX_INTENSITY);
        rt.lastTd01IncreaseTs = nowMs;
        this._effects.push({ type: 'device.set-strength', role: 'motor', value: Math.round(rt.td01Intensity) });
      }
    }
  }

  // ---- 内部：锁 / 结束 ----

  _setLock(open, nowMs, manual) {
    const rt = this.rt;
    this._effects.push({ type: 'device.lock', role: 'lock', open: !!open });
    rt.isLocked = !open;
    rt.lockedText = open ? '已解锁' : '已加锁';
    if (manual) this._log('info', '手动解锁', nowMs);
  }

  _forceStart(nowMs) {
    const rt = this.rt;
    if (!rt.running || !rt.waitingForManualStart) return;
    rt.waitingForManualStart = false;
    rt.startedAtMs = nowMs;
    rt.endTimeMs = nowMs + Math.max(MIN_DURATION_MINUTES, Math.floor(this.cfg.duration)) * 60000;
    rt.lastNoShockTs = nowMs;
    rt.remainingSec = Math.max(MIN_DURATION_MINUTES, Math.floor(this.cfg.duration)) * 60;
    this._setLock(false, nowMs, false);
  }

  _finish(nowMs, reason) {
    const rt = this.rt;
    this._stopShockSeq(nowMs, false);
    this._stopTd01(nowMs);
    this._setLock(true, nowMs, false);
    rt.pressureViolated = false;
    rt.pressureViolatedSince = 0;
    rt.running = false;
    rt.ended = true;
    rt.endReason = reason || 'stop';
    rt.endedAtMs = nowMs;
    rt.lastUpdateTs = nowMs;
    this._log('info', `女仆惩罚结束（电击 ${rt.shockCount} 次）`, nowMs);
    // 页面版 end() 会把读数上报频率放回 5000ms；分离式逻辑不做设备配置，交给宿主复位
    this._effects.push({ type: 'device.stop-all' });
  }
}

module.exports = {
  MaidPunishmentCore,
  GAME_ID,
  VERSION,
  TITLE,
  PARAMS,
};
