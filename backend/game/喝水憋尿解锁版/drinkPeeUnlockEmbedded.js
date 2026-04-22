const drinkPeeUnlock = {
  title: '喝水/憋尿解锁玩法',
  description: '称重(DZC01)回调更新 + 状态机：保持提肛与双脚踮脚，同时持续变轻/变重，达成目标或超时自动解锁。',
  parameter: [
    { key: 'mode', type: 'enum', name: '模式', required: true, default: 'drink', enum: ['drink', 'pee'] },
    { key: 'durationSec', type: 'number', name: '时长(秒)', required: true, default: 1800, min: 10, max: 24 * 60 * 60, step: 1 },
    { key: 'targetWeight', type: 'number', name: '目标重量变化(g)', required: true, default: 500, min: 1, max: 200000, step: 1 },
    { key: 'changeThreshold', type: 'number', name: '有效变化阈值(g，在每个历史窗口时间内变化超过该值则认为是有效变化)', required: true, default: 1, min: 0, max: 5000, step: 0.1 },
    { key: 'stableWindowSec', type: 'number', name: '历史窗口(秒，检测有效变化的时间窗口)', required: true, default: 30, min: 1, max: 600, step: 1 },
    { key: 'punishCooldownSec', type: 'number', name: '惩罚冷却(秒)', required: true, default: 10, min: 1, max: 600, step: 1 },
    { key: 'shockIntensity', type: 'number', name: '电击强度(V)', required: false, default: 24, min: 0, max: 100, step: 1 },
    { key: 'shockDuration', type: 'number', name: '电击持续(秒)', required: false, default: 2, min: 0.1, max: 30, step: 0.1 },
    { key: 'pressureThreshold', type: 'number', name: '气压阈值(kPa)', required: false, default: 20, min: 0, max: 1000, step: 0.2 },
    { key: 'vibeStartProb', type: 'number', name: '振动启动概率(每秒)', required: false, default: 0.05, min: 0, max: 1, step: 0.01 },
    { key: 'vibeIntensity', type: 'number', name: '振动强度(0-255)', required: false, default: 255, min: 0, max: 255, step: 1 },
    { key: 'vibeDuration', type: 'number', name: '振动时长(秒)', required: false, default: 3, min: 0.1, max: 60, step: 0.1 },
  ],
  requiredDevices: [
    { logicalId: 'SCALE_DEVICE', name: '电子秤', type: 'DZC01', required: true },
    { logicalId: 'QIYA_DEVICE', name: '气压传感器', type: 'QIYA', required: false },
    { logicalId: 'QTZ_DEVICE', name: '踮脚感受器', type: 'QTZ', required: false },
    { logicalId: 'DIANJI_DEVICE', name: '电击设备', type: 'DIANJI', required: false },
    { logicalId: 'VIBE_DEVICE', name: '振动设备', interface: 'strength', required: false },
    { logicalId: 'ZIDONGSUO_DEVICE', name: '自动锁', type: 'ZIDONGSUO', required: false },
  ],
  _runtime: {
    config: {
      mode: 'drink',
      durationSec: 1800,
      targetWeight: 500,
      changeThreshold: 1,
      stableWindowSec: 30,
      punishCooldownSec: 10,
      shockIntensity: 24,
      shockDuration: 2,
      pressureThreshold: 20000,
      vibeStartProb: 0.05,
      vibeIntensity: 60,
      vibeDuration: 3,
    },
    running: false,
    state: 'End',
    startTs: 0,
    endTs: 0,
    lastLoopTs: 0,
    cooldownUntil: 0,
    forceStop: false,

    pressure: 0,
    pressureMin: null,
    pressureMax: null,
    button0: null,
    button1: null,
    qiyaMapped: false,
    qtzMapped: false,

    weight: null,
    weightTs: 0,
    weightHistory: [],
    weightMin: null,
    weightMax: null,
    lastWeightEvalTs: 0,
    initialWeight: 0,

    progress: 0,
    lastPunishReason: '',
    shockCount: 0,
    shockTimer: null,

    vibeActive: false,
    vibeTimer: null,
    lastProgressLogTs: 0,
  },

  start(deviceManager, parameters) {
    this.updateParameters(parameters);
    const now = Date.now();

    const rt = this._runtime;
    rt.running = true;
    rt.state = 'Running';
    rt.startTs = now;
    rt.endTs = now + Math.max(1, Number(rt.config.durationSec) || 0) * 1000;
    rt.lastLoopTs = now;
    rt.cooldownUntil = 0;
    rt.forceStop = false;

    rt.pressureMin = null;
    rt.pressureMax = null;
    rt.button0 = 0;
    rt.button1 = 0;
    rt.qiyaMapped = this._isMapped(deviceManager, 'QIYA_DEVICE');
    rt.qtzMapped = this._isMapped(deviceManager, 'QTZ_DEVICE');

    rt.weight = null;
    rt.weightTs = 0;
    rt.weightHistory = [];
    rt.weightMin = null;
    rt.weightMax = null;
    rt.lastWeightEvalTs = 0;

    rt.progress = 0;
    rt.lastPunishReason = '无';
    rt.shockCount = 0;
    if (rt.shockTimer) clearTimeout(rt.shockTimer);
    rt.shockTimer = null;

    rt.vibeActive = false;
    if (rt.vibeTimer) clearTimeout(rt.vibeTimer);
    rt.vibeTimer = null;

    try { deviceManager.setDeviceProperty('SCALE_DEVICE', { report_delay_ms: 1000 }); } catch (_) {}
    try { deviceManager.setDeviceProperty('ZIDONGSUO_DEVICE', { open: 0 }); } catch (_) {}
    try { deviceManager.setDeviceProperty('DIANJI_DEVICE', { shock: 0, voltage: rt.config.shockIntensity }); } catch (_) {}
    try { deviceManager.setDeviceProperty('VIBE_DEVICE', { power: 0 }); } catch (_) {}

    this._registerListeners(deviceManager);

    deviceManager.emitState(this._snapshotState());
    deviceManager.emitUi({ fields: { statusText: '运行中' } });
    deviceManager.log('info', '游戏启动', { 
      mode: rt.config.mode, 
      target: rt.config.targetWeight, 
      duration: rt.config.durationSec 
    });
  },

  loop(deviceManager) {
    const rt = this._runtime;
    if (!rt.running) return false;
    if (rt.forceStop) {
      this.end(deviceManager, { reason: '手动结束' });
      return false;
    }

    const now = Date.now();
    rt.lastLoopTs = now;

    if (now >= rt.endTs) {
      this._enterUnlocked(deviceManager, '超时自动解锁');
      this.end(deviceManager, { reason: '超时自动解锁' });
      return false;
    }

    if (rt.state === 'Cooldown') {
      if (now >= rt.cooldownUntil) {
        // this._clearWeightWindow(); // 保持历史记录，以便再次判定
        rt.state = 'Running';
        deviceManager.log('info', '冷却结束，恢复运行');
        rt.lastPunishReason = '无';
        deviceManager.emitUi({ fields: { statusText: '运行中' } });
        deviceManager.emitState(this._snapshotState());
      } else {
        deviceManager.emitState({ remainingSec: this._remainingSec(now), cooldownRemainingSec: Math.max(0, Math.ceil((rt.cooldownUntil - now) / 1000)) });
      }
      return true;
    }

    if (rt.state === 'Running') {
      const pressureOk = this._pressureOk();
      const tiptoeOk = this._tiptoeOk();
      if (!pressureOk) return this._enterPunish(deviceManager, '气压不足');
      if (!tiptoeOk) return this._enterPunish(deviceManager, '未踮脚');

      if (!rt.vibeActive && Math.random() < Math.max(0, Math.min(1, Number(rt.config.vibeStartProb) || 0))) {
        this._startVibe(deviceManager);
      }

      deviceManager.emitState({
        remainingSec: this._remainingSec(now),
        tiptoeOk,
        pressureOk,
      });
      return true;
    }

    if (rt.state === 'Unlocked') {
      this.end(deviceManager, { reason: '已解锁' });
      return false;
    }

    return true;
  },

  end(deviceManager, extra) {
    const rt = this._runtime;
    rt.running = false;
    if (rt.shockTimer) clearTimeout(rt.shockTimer);
    rt.shockTimer = null;
    if (rt.vibeTimer) clearTimeout(rt.vibeTimer);
    rt.vibeTimer = null;

    try { deviceManager.setDeviceProperty('VIBE_DEVICE', { power: 0 }); } catch (_) {}
    try { deviceManager.setDeviceProperty('DIANJI_DEVICE', { shock: 0 }); } catch (_) {}
    try { deviceManager.setDeviceProperty('ZIDONGSUO_DEVICE', { open: 1 }); } catch (_) {}
    try { deviceManager.setDeviceProperty('SCALE_DEVICE', { report_delay_ms: 5000 }); } catch (_) {}

    deviceManager.emitUi({ fields: { statusText: '已结束' } });
    deviceManager.emitState({ running: false, state: 'End', ...this._snapshotState() });
    deviceManager.log('info', '喝水/憋尿解锁玩法结束', { reason: extra?.reason || '', progress: rt.progress, mode: rt.config.mode });
  },

  updateParameters(parameters) {
    const p = parameters || {};
    const cfg = this._runtime.config;
    Object.keys(cfg).forEach((k) => {
      if (p[k] !== undefined && p[k] !== null) cfg[k] = p[k];
    });
  },

  onAction(action, payload, deviceManager) {
    const rt = this._runtime;
    switch (action) {
      case 'stop': {
        rt.forceStop = true;
        deviceManager.log('warn', '用户手动停止游戏');
        return { stopping: true };
      }

      default:
        throw Object.assign(new Error(`Action not supported: ${action}`), { code: 'GAMEPLAY_ACTION_NOT_SUPPORTED' });
    }
  },

  _registerListeners(deviceManager) {
    const rt = this._runtime;

    try {
      deviceManager.listenDeviceProperty('SCALE_DEVICE', 'weight', (newVal) => {
        const w = Number(newVal);
        if (Number.isNaN(w)) return;
        this._onWeightSample(deviceManager, w, Date.now());
      });
    } catch (_) {}

    try {
      deviceManager.listenDeviceProperty('QIYA_DEVICE', 'pressure', (newVal) => {
        const p = Number(newVal);
        if (Number.isNaN(p)) return;
        rt.pressure = p;
        rt.pressureMin = rt.pressureMin === null ? p : Math.min(rt.pressureMin, p);
        rt.pressureMax = rt.pressureMax === null ? p : Math.max(rt.pressureMax, p);
        deviceManager.emitState({ pressure: p, pressureMin: rt.pressureMin, pressureMax: rt.pressureMax });
      });
    } catch (_) {}

    try {
      deviceManager.listenDeviceProperty('QTZ_DEVICE', 'button0', (newVal) => {
        rt.button0 = newVal;
        deviceManager.emitState({ button0: newVal, tiptoeOk: this._tiptoeOk() });
      });
      deviceManager.listenDeviceProperty('QTZ_DEVICE', 'button1', (newVal) => {
        rt.button1 = newVal;
        deviceManager.emitState({ button1: newVal, tiptoeOk: this._tiptoeOk() });
      });
    } catch (_) {}
  },

  _onWeightSample(deviceManager, weight, ts) {
    const rt = this._runtime;
    const windowMs = Math.max(1, Number(rt.config.stableWindowSec) || 0) * 1000;
    const cutoff = ts - windowMs;

    rt.weight = weight;
    rt.weightTs = ts;
    if (!rt.initialWeight && weight > 0) rt.initialWeight = weight;
    rt.weightHistory = (rt.weightHistory || []).filter((it) => it && typeof it.ts === 'number' && it.ts >= cutoff);

    const bestBefore = this._calcMinMax(rt.weightHistory);
    rt.weightHistory.push({ ts, weight });

    const bestAfter = this._calcMinMax(rt.weightHistory);
    rt.weightMin = bestAfter.min;
    rt.weightMax = bestAfter.max;

    deviceManager.emitState({
      weight,
      weightTs: ts,
      weightMin: rt.weightMin,
      weightMax: rt.weightMax,
      weightCount: rt.weightHistory.length,
      progress: this._round1(rt.progress),
      targetWeight: Number(rt.config.targetWeight) || 0,
    });

    // if (rt.state !== 'Running') return;

    const oldProgress = rt.progress;
    const mode = rt.config.mode === 'pee' ? 'pee' : 'drink';

    // New Logic: Progress = |current - initial|
    if (rt.initialWeight) {
      if (mode === 'drink') {
        rt.progress = Math.max(0, rt.initialWeight - weight);
      } else {
        rt.progress = Math.max(0, weight - rt.initialWeight);
      }
    } else {
      rt.progress = 0;
    }

    // Log progress update
    const diff = rt.progress - oldProgress;
    if (diff > 0.5) {
      const now = Date.now();
      if (now - (rt.lastProgressLogTs || 0) >= 2000) {
        rt.lastProgressLogTs = now;
        deviceManager.log('info', `进度更新: ${this._round1(rt.progress)}g`, { current: this._round1(rt.progress) });
      }
    }

    const historyDuration = rt.weightHistory.length > 0 ? (ts - rt.weightHistory[0].ts) : 0;
    const isFullCycle = historyDuration >= windowMs;

    if (rt.progress >= Math.max(1, Number(rt.config.targetWeight) || 0)) {
      this._enterUnlocked(deviceManager, '达成目标');
      this.end(deviceManager, { reason: '达成目标' });
      return;
    }

    // New Punishment Logic: Countdown based on last significant difference
    let punishCountdown = windowMs / 1000;
    const thresholdG = Math.max(0, Number(rt.config.changeThreshold) || 0);
    let lastValidTs = -1;
    const history = rt.weightHistory;
    
    // Find t1: last time weight was significantly different
    for (let i = history.length - 1; i >= 0; i--) {
      const item = history[i];
      if (mode === 'drink') {
        if (item.weight > weight + thresholdG) {
          lastValidTs = item.ts;
          break;
        }
      } else {
        if (item.weight < weight - thresholdG) {
          lastValidTs = item.ts;
          break;
        }
      }
    }

    if (lastValidTs > 0) {
      const elapsed = ts - lastValidTs;
      punishCountdown = Math.max(0, (windowMs - elapsed) / 1000);
    } else {
      // If full cycle and no valid t1 found, it means timeout
      if (isFullCycle) {
        punishCountdown = 0;
      } else {
        // Warmup: show remaining warmup time
        punishCountdown = Math.max(0, (windowMs - historyDuration) / 1000);
      }
    }

    deviceManager.emitState({ 
      progress: this._round1(rt.progress), 
      mode, 
      remainingSec: this._remainingSec(ts),
      punishCountdown: Math.ceil(punishCountdown)
    });

    if (rt.state === 'Running' && isFullCycle && punishCountdown <= 0) {
       return this._enterPunish(deviceManager, '长时间未变化');
    }
  },

  _enterPunish(deviceManager, reason) {
    const rt = this._runtime;
    if (rt.state === 'Punish' || rt.state === 'Cooldown' || rt.state === 'Unlocked') return true;

    rt.state = 'Punish';
    rt.lastPunishReason = String(reason || '惩罚');
    this._stopVibe(deviceManager);

    const shockDurationMs = Math.max(100, (Number(rt.config.shockDuration) || 0) * 1000);
    const voltage = Number(rt.config.shockIntensity) || 0;

    try { deviceManager.setDeviceProperty('DIANJI_DEVICE', { voltage, shock: 1 }); } catch (_) {}
    rt.shockCount += 1;
    deviceManager.emitUi({ fields: { statusText: `惩罚：${rt.lastPunishReason}` } });
    deviceManager.emitState(this._snapshotState());
    deviceManager.log('warn', `触发惩罚: ${rt.lastPunishReason}`, { voltage, duration: shockDurationMs / 1000 });

    if (rt.shockTimer) clearTimeout(rt.shockTimer);
    rt.shockTimer = setTimeout(() => {
      try { deviceManager.setDeviceProperty('DIANJI_DEVICE', { shock: 0 }); } catch (_) {}
      this._enterCooldown(deviceManager);
    }, shockDurationMs);

    return true;
  },

  _enterCooldown(deviceManager) {
    const rt = this._runtime;
    const now = Date.now();
    rt.state = 'Cooldown';
    rt.cooldownUntil = now + Math.max(1, Number(rt.config.punishCooldownSec) || 0) * 1000;
    deviceManager.emitUi({ fields: { statusText: '冷却中' } });
    deviceManager.emitState(this._snapshotState());
    deviceManager.log('info', `进入冷却状态 (${Number(rt.config.punishCooldownSec)}s)`);
  },

  _enterUnlocked(deviceManager, reason) {
    const rt = this._runtime;
    rt.state = 'Unlocked';
    rt.lastPunishReason = String(reason || '已解锁');
    this._stopVibe(deviceManager);
    try { deviceManager.setDeviceProperty('DIANJI_DEVICE', { shock: 0 }); } catch (_) {}
    try { deviceManager.setDeviceProperty('ZIDONGSUO_DEVICE', { open: 1 }); } catch (_) {}
    deviceManager.emitUi({ fields: { statusText: `已解锁：${rt.lastPunishReason}` } });
    deviceManager.emitState(this._snapshotState());
    deviceManager.log('info', `解锁成功: ${rt.lastPunishReason}`);
  },
  _startVibe(deviceManager) {
    const rt = this._runtime;
    if (rt.vibeActive) return;
    rt.vibeActive = true;

    const intensity = Math.max(0, Math.min(100, Number(rt.config.vibeIntensity) || 0));
    const power = Math.round((intensity / 100) * 255);
    const durationMs = Math.max(100, (Number(rt.config.vibeDuration) || 0) * 1000);

    try { deviceManager.setDeviceProperty('VIBE_DEVICE', { power }); } catch (_) {}
    deviceManager.emitState({ vibeActive: true, vibePower: power });

    if (rt.vibeTimer) clearTimeout(rt.vibeTimer);
    rt.vibeTimer = setTimeout(() => this._stopVibe(deviceManager), durationMs);
    deviceManager.log('info', '触发随机振动干扰', { power, duration: durationMs / 1000 });
  },

  _stopVibe(deviceManager) {
    const rt = this._runtime;
    if (!rt.vibeActive) {
      try { deviceManager.setDeviceProperty('VIBE_DEVICE', { power: 0 }); } catch (_) {}
      return;
    }
    rt.vibeActive = false;
    if (rt.vibeTimer) clearTimeout(rt.vibeTimer);
    rt.vibeTimer = null;
    try { deviceManager.setDeviceProperty('VIBE_DEVICE', { power: 0 }); } catch (_) {}
    deviceManager.emitState({ vibeActive: false, vibePower: 0 });
  },

  _tiptoeOk() {
    const rt = this._runtime;
    if (!rt.qtzMapped) return true;
    return this._isTruthy(rt.button0) && this._isTruthy(rt.button1);
  },

  _pressureOk() {
    const rt = this._runtime;
    if (!rt.qiyaMapped) return true;
    const th = Number(rt.config.pressureThreshold) || 0;
    return Number(rt.pressure) >= th;
  },

  _isMapped(deviceManager, logicalId) {
    const ids = deviceManager?.deviceMap?.[logicalId];
    return Array.isArray(ids) ? ids.length > 0 : !!ids;
  },

  _isTruthy(v) {
    if (v === true || v === 1) return true;
    if (v === false || v === 0 || v === null || v === undefined) return false;
    const s = String(v).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'on' || s === 'pressed';
  },

  _calcMinMax(arr) {
    const xs = Array.isArray(arr) ? arr : [];
    let min = null;
    let max = null;
    let count = 0;
    for (const it of xs) {
      const w = Number(it?.weight);
      if (Number.isNaN(w)) continue;
      min = min === null ? w : Math.min(min, w);
      max = max === null ? w : Math.max(max, w);
      count += 1;
    }
    return { min, max, count };
  },

  _clearWeightWindow() {
    const rt = this._runtime;
    rt.weightHistory = [];
    rt.weightMin = null;
    rt.weightMax = null;
    rt.lastWeightEvalTs = 0;
  },

  _remainingSec(nowTs) {
    const rt = this._runtime;
    return Math.max(0, Math.ceil((rt.endTs - nowTs) / 1000));
  },

  _round1(n) {
    return Math.round((Number(n) || 0) * 10) / 10;
  },

  _snapshotState() {
    const rt = this._runtime;
    const now = Date.now();
    return {
      title: this.title,
      running: rt.running,
      state: rt.state,
      mode: rt.config.mode,
      startTime: rt.startTs ? new Date(rt.startTs).toLocaleString() : '-',
      remainingSec: this._remainingSec(now),
      progress: this._round1(rt.progress),
      targetWeight: Number(rt.config.targetWeight) || 0,
      changeThreshold: Number(rt.config.changeThreshold) || 0,
      stableWindowSec: Number(rt.config.stableWindowSec) || 0,
      punishCooldownSec: Number(rt.config.punishCooldownSec) || 0,
      initialWeight: rt.initialWeight,
      weight: rt.weight,
      weightTs: rt.weightTs,
      weightMin: rt.weightMin,
      weightMax: rt.weightMax,
      weightCount: Array.isArray(rt.weightHistory) ? rt.weightHistory.length : 0,
      pressure: rt.pressure,
      pressureMin: rt.pressureMin,
      pressureMax: rt.pressureMax,
      button0: rt.button0,
      button1: rt.button1,
      tiptoeOk: this._tiptoeOk(),
      pressureOk: this._pressureOk(),
      lastPunishReason: rt.lastPunishReason,
      shockCount: rt.shockCount,
      vibeActive: rt.vibeActive,
      cooldownRemainingSec: rt.state === 'Cooldown' ? Math.max(0, Math.ceil((rt.cooldownUntil - now) / 1000)) : 0,
    };
  },

  getHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>喝水/憋尿解锁玩法</title>
    <style>
      :root {
        --bg: #050505;
        --panel-bg: rgba(20, 20, 25, 0.9);
        --panel-border: #333;
        --primary: #00f0ff;
        --primary-dim: rgba(0, 240, 255, 0.2);
        --warn: #ffcc00;
        --danger: #ff003c;
        --ok: #00ff9d;
        --text: #e0e0e0;
        --text-muted: #666;
        --font-mono: "Consolas", "Monaco", "Courier New", monospace;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 20px;
        background: var(--bg);
        color: var(--text);
        font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
      }
      
      /* HUD Layout */
      .hud-container {
        max-width: 1200px;
        margin: 0 auto;
        width: 100%;
        display: grid;
        grid-template-columns: 1fr;
        gap: 20px;
      }

      /* Header */
      .hud-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 2px solid var(--panel-border);
        padding-bottom: 15px;
        margin-bottom: 10px;
      }
      .hud-title {
        margin: 0;
        font-size: 24px;
        font-weight: 700;
        letter-spacing: 1px;
        color: var(--primary);
        text-transform: uppercase;
        text-shadow: 0 0 10px var(--primary-dim);
      }
      .hud-status-bar {
        display: flex;
        gap: 15px;
      }
      .status-tag {
        background: var(--panel-border);
        padding: 4px 12px;
        border-radius: 4px;
        font-size: 12px;
        font-family: var(--font-mono);
        border: 1px solid #444;
      }
      .status-tag b { color: #fff; }

      /* Main Dashboard Grid */
      .dashboard-grid {
        display: grid;
        grid-template-columns: repeat(12, 1fr);
        grid-template-rows: auto auto;
        gap: 20px;
      }

      /* Panels */
      .panel {
        background: var(--panel-bg);
        border: 1px solid var(--panel-border);
        border-radius: 8px;
        padding: 20px;
        position: relative;
        box-shadow: 0 0 20px rgba(0,0,0,0.5);
      }
      .panel::before {
        content: '';
        position: absolute;
        top: 0; left: 0; width: 100%; height: 2px;
        background: linear-gradient(90deg, transparent, var(--primary), transparent);
        opacity: 0.5;
      }
      .panel-label {
        font-size: 12px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 10px;
        display: block;
      }

      /* Progress Section (Hero) */
      .panel-hero {
        grid-column: span 12;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }
      .progress-display {
        position: relative;
        height: 40px;
        background: #111;
        border: 1px solid #333;
        border-radius: 4px;
        overflow: hidden;
        margin: 10px 0;
      }
      .progress-fill {
        height: 100%;
        background: repeating-linear-gradient(
          45deg,
          var(--primary),
          var(--primary) 10px,
          var(--primary-dim) 10px,
          var(--primary-dim) 20px
        );
        width: 0%;
        transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: 0 0 15px var(--primary);
      }
      .progress-text {
        position: absolute;
        top: 0; left: 0; width: 100%; height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: var(--font-mono);
        font-weight: bold;
        text-shadow: 0 1px 2px #000;
        z-index: 2;
        mix-blend-mode: exclusion;
      }
      .hero-stats {
        display: flex;
        justify-content: space-between;
        margin-top: 10px;
        font-family: var(--font-mono);
        font-size: 14px;
      }
      .hero-stat-item {
        color: var(--text-muted);
      }
      .hero-stat-item b {
        color: var(--text);
        margin-left: 5px;
      }

      /* Big Metrics */
      .panel-metric {
        grid-column: span 6;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
      }
      @media (min-width: 768px) {
        .panel-metric { grid-column: span 3; }
      }
      .metric-value {
        font-family: var(--font-mono);
        font-size: 36px;
        font-weight: 700;
        color: #fff;
        text-shadow: 0 0 10px rgba(255,255,255,0.3);
      }
      .metric-unit {
        font-size: 14px;
        color: var(--text-muted);
        margin-top: -5px;
      }

      /* Tiptoe Status */
      .tiptoe-indicator {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        font-size: 20px;
        font-weight: bold;
        background: #111;
        border-radius: 4px;
        padding: 10px;
      }
      .tiptoe-indicator.ok { color: var(--ok); border: 1px solid var(--ok); box-shadow: inset 0 0 10px var(--ok); }
      .tiptoe-indicator.warn { color: var(--danger); border: 1px solid var(--danger); box-shadow: inset 0 0 10px var(--danger); animation: pulse 1s infinite; }



      /* Footer / Terminal */
      .panel-terminal {
        grid-column: span 12;
        font-family: var(--font-mono);
        background: #000;
        border: 1px solid #333;
      }
      .terminal-logs {
        list-style: none;
        padding: 0;
        margin: 0;
        height: 150px;
        overflow-y: auto;
        font-size: 12px;
      }
      .terminal-logs li {
        padding: 4px 8px;
        border-bottom: 1px solid #111;
        display: flex;
        gap: 10px;
      }
      .terminal-logs li:before { content: '>'; color: var(--text-muted); }
      .l-info { color: #aaa; }
      .l-warn { color: var(--warn); }
      .l-error { color: var(--danger); }

      /* Utilities */
      .text-warn { color: var(--warn) !important; }
      .text-danger { color: var(--danger) !important; }
      .blink { animation: blink 1s infinite; }
      @keyframes blink { 50% { opacity: 0.5; } }
      @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.7; } 100% { opacity: 1; } }
      
      /* Responsive adjustments */
      @media (max-width: 600px) {
        .hud-header { flex-direction: column; align-items: flex-start; gap: 10px; }
        .panel-metric { grid-column: span 6; }
      }
    </style>
  </head>
  <body>
    <div class="hud-container">
      <!-- Header -->
      <header class="hud-header">
        <h1 class="hud-title" data-bind="title">系统在线</h1>
        <div class="hud-status-bar">
           <div class="status-tag">状态: <b data-bind="statusText">初始化</b></div>
           <div class="status-tag">剩余: <b data-bind="remainingSec">-</b>s</div>
        </div>
      </header>

      <!-- Dashboard -->
      <main class="dashboard-grid">
        
        <!-- Hero: Progress & Main Status -->
        <div class="panel panel-hero">
          <span class="panel-label">任务进度 (初始: <span data-bind="initialWeight">-</span>g)</span>
          <div class="progress-display">
            <div class="progress-fill" id="progressBar" style="width: 0%"></div>
            <div class="progress-text">
              <span data-bind="progress">0</span> / <span data-bind="targetWeight">500</span> g
            </div>
          </div>
          <div class="hero-stats">
            <div class="hero-stat-item">惩罚次数: <b data-bind="shockCount" class="text-danger">0</b></div>
            <div class="hero-stat-item">冷却时间: <b data-bind="cooldownRemainingSec">0</b>s</div>
            <div class="hero-stat-item" style="color:var(--warn);"><b data-bind="lastPunishReason"></b></div>
          </div>
        </div>

        <!-- Metric: Weight -->
        <div class="panel panel-metric">
          <span class="panel-label">当前重量</span>
          <div class="metric-value"><span data-bind="weight">-</span></div>
          <div class="metric-unit">克 (g)</div>
        </div>

        <!-- Metric: Pressure -->
        <div class="panel panel-metric">
          <span class="panel-label">气压值</span>
          <div class="metric-value"><span data-bind="pressure">-</span></div>
          <div class="metric-unit">帕斯卡 (Pa)</div>
        </div>

        <!-- Metric: Tiptoe -->
        <div class="panel panel-metric">
          <span class="panel-label">踮脚状态</span>
          <div class="tiptoe-indicator" id="tiptoeVal">
            <span data-bind="tiptoeOk">检查</span>
          </div>
        </div>

        <!-- Metric: Punish Countdown -->
        <div class="panel panel-metric">
          <span class="panel-label">惩罚倒计时</span>
          <div class="metric-value" style="color:var(--warn);"><span data-bind="punishCountdown">-</span></div>
          <div class="metric-unit">秒 (s)</div>
        </div>

        <!-- Details / Stats -->
        <div class="panel" style="grid-column: span 12;">
           <details>
             <summary style="cursor:pointer; color:var(--primary);">系统指标 >></summary>
             <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-top:10px; font-family:var(--font-mono); font-size:12px;">
                <div>模式: <b data-bind="modeCN">-</b></div>
                <div>最小重: <b data-bind="weightMin">-</b></div>
                <div>最大重: <b data-bind="weightMax">-</b></div>
                <div>最小压: <b data-bind="pressureMin">-</b></div>
                <div>最大压: <b data-bind="pressureMax">-</b></div>
                <div>采样数: <b data-bind="weightCount">0</b></div>
                <div>历史窗口: <b data-bind="stableWindowSec">0</b>s</div>
                <div>惩罚冷却: <b data-bind="punishCooldownSec">0</b>s</div>
             </div>
           </details>
        </div>

        <!-- Logs -->
        <div class="panel panel-terminal">
          <span class="panel-label">系统日志</span>
          <ul class="terminal-logs" id="logs"></ul>
        </div>

      </main>
    </div>

    <script>
      (function(){
        const state = {};
        const uiFields = {};
        const $all = (sel) => Array.from(document.querySelectorAll(sel));
        function merge(obj, patch){ Object.assign(obj, patch || {}); }
        function formatStartTime(v) {
          if (v === undefined || v === null) return '-';
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
            return new Date(v).toLocaleTimeString('zh-CN', { hour12: false });
          }
          const s = String(v);
          const n = Number(s);
          if (!Number.isNaN(n) && n > 0) return new Date(n).toLocaleTimeString('zh-CN', { hour12: false });
          const t = Date.parse(s);
          if (!Number.isNaN(t)) return new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
          return s || '-';
        }
        function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
        function render(){
          $all('[data-bind]').forEach(el => {
            const key = el.getAttribute('data-bind');
            let val = (key in uiFields) ? uiFields[key] : (key in state ? state[key] : el.textContent);
            if (key === 'startTime') val = formatStartTime(val);
            // Special handling for boolean text in HUD
            if (key === 'tiptoeOk') {
                 // The text content is handled by class toggle below, but we can update text if needed
                 el.textContent = val ? '正常' : '异常';
                 return;
            }
            if (key === 'modeCN') {
                 el.textContent = state.mode === 'pee' ? '排泄' : '喝水';
                 return;
            }
            el.textContent = (val === undefined || val === null) ? '' : String(val);
          });

          const p = Number(state.progress) || 0;
          const t = Number(state.targetWeight) || 0;
          const pct = t > 0 ? clamp(p / t, 0, 1) : 0;
          const bar = document.getElementById('progressBar');
          if (bar) bar.style.width = (pct * 100).toFixed(1) + '%';

          const tiptoeEl = document.getElementById('tiptoeVal');
          if (tiptoeEl) {
            const ok = !!state.tiptoeOk;
            tiptoeEl.classList.toggle('ok', ok);
            tiptoeEl.classList.toggle('warn', !ok);
          }
        }
        function addLog(item){
          const li = document.createElement('li');
          li.className = 'l-' + (item.level||'info');
          li.textContent = '[' + new Date(item.ts).toLocaleTimeString() + '] ' + (item.level||'info') + ' :: ' + (item.message||'');
          const ul = document.getElementById('logs');
          ul.insertBefore(li, ul.firstChild);
          while (ul.children.length > 10) ul.removeChild(ul.lastChild);
        }
        function postAction(name, payload){
          return fetch('/api/games/current/actions', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ action:name, payload }) }).catch(()=>{});
        }
        $all('[data-action]').forEach(el => {
          const name = el.getAttribute('data-action');
          const raw = el.getAttribute('data-payload');
          let payload = undefined;
          try { if (raw) payload = JSON.parse(raw); } catch(_) {}
          el.addEventListener('click', () => postAction(name, payload));
        });
        const es = new EventSource('/api/games/current/stream');
        es.addEventListener('hello', (e) => {
          try {
            const data = JSON.parse(e.data);
            merge(state, data.snapshot || {});
            render();
          } catch(_) {}
        });
        es.addEventListener('state', (e) => { try { const d = JSON.parse(e.data); merge(state, d); render(); } catch(_){} });
        es.addEventListener('ui', (e) => { try { const d = JSON.parse(e.data); merge(uiFields, d.fields || {}); render(); } catch(_){} });
        es.addEventListener('log', (e) => { try { addLog(JSON.parse(e.data)); } catch(_){} });
      })();
    </script>
  </body>
</html>`;
  },
};

module.exports = drinkPeeUnlock;
