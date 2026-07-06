// 喝水/憋尿解锁玩法 — 页面自驱动（DeviceAPI），逻辑/UI 对齐老版 drinkPeeUnlockEmbedded.js
(function () {
  'use strict';
  const SCALE = 'scale';   // 老版 SCALE_DEVICE
  const SENSOR = 'sensor'; // 老版 QIYA_DEVICE
  const QTZ = 'qtz';       // 老版 QTZ_DEVICE
  const PUNISH = 'punish'; // 老版 DIANJI_DEVICE
  const VIBE = 'vibe';     // 老版 VIBE_DEVICE
  const LOCK = 'lock';     // 老版 ZIDONGSUO_DEVICE

  const cfg = {
    mode: 'drink', durationSec: 1800, targetWeight: 500, changeThreshold: 1,
    stableWindowSec: 30, punishCooldownSec: 10, shockIntensity: 24, shockDuration: 2,
    pressureThreshold: 20, vibeStartProb: 0.05, vibeIntensity: 255, vibeDuration: 3,
  };
  const rt = {
    running: false, state: 'End', startTs: 0, endTs: 0, cooldownUntil: 0, forceStop: false,
    pressure: 0, pressureMin: null, pressureMax: null, button0: 0, button1: 0,
    qiyaMapped: false, qtzMapped: false,
    weight: null, weightTs: 0, weightHistory: [], weightMin: null, weightMax: null, initialWeight: 0,
    progress: 0, lastPunishReason: '无', shockCount: 0, shockTimer: null,
    vibeActive: false, vibeTimer: null, lastProgressLogTs: 0,
  };
  const view = {
    title: '喝水/憋尿解锁玩法', statusText: '初始化', remainingSec: '-', initialWeight: '-',
    progress: 0, targetWeight: 500, shockCount: 0, cooldownRemainingSec: 0, lastPunishReason: '',
    weight: '-', pressure: '-', tiptoeOk: false, punishCountdown: '-', mode: 'drink',
    weightMin: '-', weightMax: '-', pressureMin: '-', pressureMax: '-', weightCount: 0,
    stableWindowSec: 0, punishCooldownSec: 0,
  };

  const $ = (s) => Array.from(document.querySelectorAll(s));
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }
  function render() {
    $('[data-bind]').forEach((el) => {
      const k = el.getAttribute('data-bind');
      if (k === 'tiptoeOk') { el.textContent = view.tiptoeOk ? '正常' : '异常'; return; }
      if (k === 'modeCN') { el.textContent = view.mode === 'pee' ? '排泄' : '喝水'; return; }
      let v = (k in view) ? view[k] : el.textContent;
      el.textContent = (v === undefined || v === null) ? '' : String(v);
    });
    const p = Number(view.progress) || 0;
    const t = Number(view.targetWeight) || 0;
    const bar = document.getElementById('progressBar');
    if (bar) bar.style.width = (clamp(t > 0 ? p / t : 0, 0, 1) * 100).toFixed(1) + '%';
    const tip = document.getElementById('tiptoeVal');
    if (tip) { tip.classList.toggle('ok', !!view.tiptoeOk); tip.classList.toggle('warn', !view.tiptoeOk); }
  }
  function addLog(level, message) {
    const li = document.createElement('li');
    li.className = 'l-' + (level || 'info');
    li.textContent = '[' + new Date().toLocaleTimeString() + '] ' + (level || 'info') + ' :: ' + message;
    const ul = document.getElementById('logs');
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 10) ul.removeChild(ul.lastChild);
    try { DeviceAPI.log(level, message); } catch (_) {}
  }

  function setStrength(dev, v) { if (DeviceAPI.device(dev).isMapped()) DeviceAPI.device(dev).invoke('strength', 'set', { value: Math.round(v) }); }
  function startShock(voltage) { if (DeviceAPI.device(PUNISH).isMapped()) DeviceAPI.device(PUNISH).invoke('shock', 'start', { voltage }); }
  function stopShockDev() { if (DeviceAPI.device(PUNISH).isMapped()) DeviceAPI.device(PUNISH).invoke('shock', 'stop', {}); }
  function setLockOpen(open) { if (DeviceAPI.device(LOCK).isMapped()) DeviceAPI.device(LOCK).invoke('lock', 'setOpen', { open: !!open }); }
  function isTruthy(v) {
    if (v === true || v === 1) return true;
    if (v === false || v === 0 || v === null || v === undefined) return false;
    const s = String(v).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'on' || s === 'pressed';
  }
  function tiptoeOk() { if (!rt.qtzMapped) return true; return isTruthy(rt.button0) && isTruthy(rt.button1); }
  function pressureOk() { if (!rt.qiyaMapped) return true; return Number(rt.pressure) >= (Number(cfg.pressureThreshold) || 0); }
  function remainingSec(now) { return Math.max(0, Math.ceil((rt.endTs - now) / 1000)); }
  function calcMinMax(arr) {
    let min = null, max = null;
    for (const it of (arr || [])) { const w = Number(it && it.weight); if (Number.isNaN(w)) continue; min = min === null ? w : Math.min(min, w); max = max === null ? w : Math.max(max, w); }
    return { min, max };
  }

  function syncView() {
    const now = Date.now();
    view.statusText = stateText();
    view.remainingSec = remainingSec(now);
    view.initialWeight = rt.initialWeight || '-';
    view.progress = round1(rt.progress);
    view.targetWeight = Number(cfg.targetWeight) || 0;
    view.shockCount = rt.shockCount;
    view.cooldownRemainingSec = rt.state === 'Cooldown' ? Math.max(0, Math.ceil((rt.cooldownUntil - now) / 1000)) : 0;
    view.lastPunishReason = rt.lastPunishReason;
    view.weight = rt.weight === null ? '-' : round1(rt.weight);
    view.pressure = rt.qiyaMapped ? round1(rt.pressure) : '-';
    view.tiptoeOk = tiptoeOk();
    view.mode = cfg.mode;
    view.weightMin = rt.weightMin === null ? '-' : round1(rt.weightMin);
    view.weightMax = rt.weightMax === null ? '-' : round1(rt.weightMax);
    view.pressureMin = rt.pressureMin === null ? '-' : round1(rt.pressureMin);
    view.pressureMax = rt.pressureMax === null ? '-' : round1(rt.pressureMax);
    view.weightCount = rt.weightHistory.length;
    view.stableWindowSec = Number(cfg.stableWindowSec) || 0;
    view.punishCooldownSec = Number(cfg.punishCooldownSec) || 0;
  }
  function stateText() {
    switch (rt.state) {
      case 'Running': return '运行中';
      case 'Cooldown': return '冷却中';
      case 'Punish': return '惩罚：' + rt.lastPunishReason;
      case 'Unlocked': return '已解锁：' + rt.lastPunishReason;
      default: return rt.running ? '运行中' : '已结束';
    }
  }

  function startVibe() {
    if (rt.vibeActive) return;
    rt.vibeActive = true;
    const intensity = Math.max(0, Math.min(100, Number(cfg.vibeIntensity) || 0));
    // 老版按 0-100 映射到 0-255；若用户填 0-255 也兼容
    const power = cfg.vibeIntensity > 100 ? Math.round(cfg.vibeIntensity) : Math.round((intensity / 100) * 255);
    const durationMs = Math.max(100, (Number(cfg.vibeDuration) || 0) * 1000);
    setStrength(VIBE, power);
    addLog('info', `触发随机振动干扰 power=${power} ${durationMs / 1000}s`);
    if (rt.vibeTimer) clearTimeout(rt.vibeTimer);
    rt.vibeTimer = setTimeout(stopVibe, durationMs);
  }
  function stopVibe() {
    if (!rt.vibeActive) { setStrength(VIBE, 0); return; }
    rt.vibeActive = false;
    if (rt.vibeTimer) { clearTimeout(rt.vibeTimer); rt.vibeTimer = null; }
    setStrength(VIBE, 0);
  }
  function enterPunish(reason) {
    if (rt.state === 'Punish' || rt.state === 'Cooldown' || rt.state === 'Unlocked') return;
    rt.state = 'Punish';
    rt.lastPunishReason = String(reason || '惩罚');
    stopVibe();
    const shockDurationMs = Math.max(100, (Number(cfg.shockDuration) || 0) * 1000);
    const voltage = Number(cfg.shockIntensity) || 0;
    startShock(voltage);
    rt.shockCount += 1;
    addLog('warn', `触发惩罚: ${rt.lastPunishReason}（${voltage}V）`);
    syncView(); render();
    if (rt.shockTimer) clearTimeout(rt.shockTimer);
    rt.shockTimer = setTimeout(() => { stopShockDev(); enterCooldown(); }, shockDurationMs);
  }
  function enterCooldown() {
    rt.state = 'Cooldown';
    rt.cooldownUntil = Date.now() + Math.max(1, Number(cfg.punishCooldownSec) || 0) * 1000;
    addLog('info', `进入冷却 (${Number(cfg.punishCooldownSec)}s)`);
    syncView(); render();
  }
  function enterUnlocked(reason) {
    rt.state = 'Unlocked';
    rt.lastPunishReason = String(reason || '已解锁');
    stopVibe();
    stopShockDev();
    setLockOpen(true);
    addLog('info', `解锁成功: ${rt.lastPunishReason}`);
    syncView(); render();
  }
  function onWeightSample(weight, ts) {
    const windowMs = Math.max(1, Number(cfg.stableWindowSec) || 0) * 1000;
    const cutoff = ts - windowMs;
    rt.weight = weight; rt.weightTs = ts;
    if (!rt.initialWeight && weight > 0) rt.initialWeight = weight;
    rt.weightHistory = rt.weightHistory.filter((it) => it && typeof it.ts === 'number' && it.ts >= cutoff);
    rt.weightHistory.push({ ts, weight });
    const mm = calcMinMax(rt.weightHistory);
    rt.weightMin = mm.min; rt.weightMax = mm.max;
    const oldProgress = rt.progress;
    const mode = cfg.mode === 'pee' ? 'pee' : 'drink';
    if (rt.initialWeight) {
      rt.progress = mode === 'drink' ? Math.max(0, rt.initialWeight - weight) : Math.max(0, weight - rt.initialWeight);
    } else rt.progress = 0;
    if (rt.progress - oldProgress > 0.5) {
      const now = Date.now();
      if (now - (rt.lastProgressLogTs || 0) >= 2000) { rt.lastProgressLogTs = now; addLog('info', `进度更新: ${round1(rt.progress)}g`); }
    }
    const historyDuration = rt.weightHistory.length > 0 ? (ts - rt.weightHistory[0].ts) : 0;
    const isFullCycle = historyDuration >= windowMs;
    if (rt.progress >= Math.max(1, Number(cfg.targetWeight) || 0)) { enterUnlocked('达成目标'); end({ reason: '达成目标' }); return; }
    let punishCountdown = windowMs / 1000;
    const thresholdG = Math.max(0, Number(cfg.changeThreshold) || 0);
    let lastValidTs = -1;
    for (let i = rt.weightHistory.length - 1; i >= 0; i--) {
      const item = rt.weightHistory[i];
      if (mode === 'drink') { if (item.weight > weight + thresholdG) { lastValidTs = item.ts; break; } }
      else { if (item.weight < weight - thresholdG) { lastValidTs = item.ts; break; } }
    }
    if (lastValidTs > 0) punishCountdown = Math.max(0, (windowMs - (ts - lastValidTs)) / 1000);
    else punishCountdown = isFullCycle ? 0 : Math.max(0, (windowMs - historyDuration) / 1000);
    view.punishCountdown = Math.ceil(punishCountdown);
    syncView(); render();
    if (rt.state === 'Running' && isFullCycle && punishCountdown <= 0) enterPunish('长时间未变化');
  }
  function loop() {
    if (!rt.running) return;
    if (rt.forceStop) { end({ reason: '手动结束' }); return; }
    const now = Date.now();
    if (now >= rt.endTs) { enterUnlocked('超时自动解锁'); end({ reason: '超时自动解锁' }); return; }
    if (rt.state === 'Cooldown') {
      if (now >= rt.cooldownUntil) { rt.state = 'Running'; rt.lastPunishReason = '无'; addLog('info', '冷却结束，恢复运行'); }
      syncView(); render(); return;
    }
    if (rt.state === 'Running') {
      if (!pressureOk()) { enterPunish('气压不足'); return; }
      if (!tiptoeOk()) { enterPunish('未踮脚'); return; }
      if (!rt.vibeActive && Math.random() < clamp(Number(cfg.vibeStartProb) || 0, 0, 1)) startVibe();
      syncView(); render(); return;
    }
    if (rt.state === 'Unlocked') { end({ reason: '已解锁' }); return; }
  }
  function start() {
    const now = Date.now();
    rt.running = true; rt.state = 'Running'; rt.startTs = now;
    rt.endTs = now + Math.max(1, Number(cfg.durationSec) || 0) * 1000;
    rt.cooldownUntil = 0; rt.forceStop = false;
    rt.pressureMin = null; rt.pressureMax = null; rt.button0 = 0; rt.button1 = 0;
    rt.qiyaMapped = DeviceAPI.device(SENSOR).isMapped();
    rt.qtzMapped = DeviceAPI.device(QTZ).isMapped();
    rt.weight = null; rt.weightTs = 0; rt.weightHistory = []; rt.weightMin = null; rt.weightMax = null; rt.initialWeight = 0;
    rt.progress = 0; rt.lastPunishReason = '无'; rt.shockCount = 0;
    rt.vibeActive = false;
    try {
      if (DeviceAPI.device(SCALE).isMapped()) DeviceAPI.device(SCALE).invoke('reporting', 'setReportDelay', { ms: 1000 });
      setLockOpen(false); stopShockDev(); setStrength(VIBE, 0);
    } catch (_) {}
    DeviceAPI.device(SCALE).onProperty('weight', (nv) => { const w = Number(nv); if (!Number.isNaN(w)) onWeightSample(w, Date.now()); });
    if (rt.qiyaMapped) DeviceAPI.device(SENSOR).onProperty('pressure', (nv) => {
      const p = Number(nv); if (Number.isNaN(p)) return;
      rt.pressure = p; rt.pressureMin = rt.pressureMin === null ? p : Math.min(rt.pressureMin, p); rt.pressureMax = rt.pressureMax === null ? p : Math.max(rt.pressureMax, p);
    });
    if (rt.qtzMapped) {
      DeviceAPI.device(QTZ).onProperty('button0', (nv) => { rt.button0 = nv; });
      DeviceAPI.device(QTZ).onProperty('button1', (nv) => { rt.button1 = nv; });
    }
    addLog('info', `游戏启动 mode=${cfg.mode} target=${cfg.targetWeight}g`);
    syncView(); render();
  }
  function end(extra) {
    rt.running = false;
    if (rt.shockTimer) { clearTimeout(rt.shockTimer); rt.shockTimer = null; }
    if (rt.vibeTimer) { clearTimeout(rt.vibeTimer); rt.vibeTimer = null; }
    setStrength(VIBE, 0); stopShockDev(); setLockOpen(true);
    try { if (DeviceAPI.device(SCALE).isMapped()) DeviceAPI.device(SCALE).invoke('reporting', 'setReportDelay', { ms: 5000 }); } catch (_) {}
    if (rt.state !== 'Unlocked') rt.state = 'End';
    addLog('info', `结束: ${extra && extra.reason || ''}（进度 ${round1(rt.progress)}g）`);
    syncView(); render();
  }

  let loopTimer = null;
  async function boot() {
    render();
    try { await DeviceAPI.ready; } catch (_) {}
    const p = DeviceAPI.params || {};
    Object.keys(cfg).forEach((k) => { if (p[k] !== undefined && p[k] !== null) cfg[k] = p[k]; });
    addLog('info', '设备通道就绪，开始游戏');
    start();
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = setInterval(loop, 1000);
  }

  window.__game = { start, loop, end, rt, cfg, view };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
