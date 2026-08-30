// 俯卧撑检测训练 — 页面自驱动（DeviceAPI），逻辑/UI 对齐老版 pushupDetectionEmbedded.js
(function () {
  'use strict';
  function L() { return (typeof GameI18n !== 'undefined' && GameI18n.t) ? GameI18n.t : function (zh) { return zh; }; }
  function t(zh, en) { return L()(zh, en); }
  const QTZ = 'qtz';        // 老版 distance_sensor
  const LOCK = 'lock';      // 老版 auto_lock
  const SHOCK = 'shock';    // 老版 shock_device
  const VIBE = 'vibrator';  // 老版 vibrator_device
  // 老版 pj01_device 在新 manifest 无对应设备，保留 UI 状态但下发自动跳过（isMapped 为 false）

  const cfg = {
    duration: 15, targetCount: 30, downThreshold: 15, upThreshold: 35, idleTimeLimit: 15,
    shockIntensity: 15, shockDuration: 3, randomIntensityRange: 10, randomDurationRange: 1,
    rewardTriggerCount: 3, rewardTriggerProbability: 100, vibratorIntensity: 100, vibratorDuration: 15,
    pj01Duration: 5, enableVoice: true,
  };
  const rt = {
    startTime: 0, running: false, paused: false, isLocked: false,
    completedCount: 0, consecutiveCount: 0, currentDistance: 0, phase: 'up',
    lastActionTs: 0, lastIdleWarnTs: 0, shocking: false, vibratorOn: false, pj01On: false,
    punishmentCount: 0, rewardCount: 0,
    shockTimer: null, vibratorTimer: null, pj01Timer: null,
  };
  const view = {
    running: false, startTime: 0, remainText: '-', completedCount: 0, targetCount: 30,
    completionRate: 0, phase: '-', currentDistance: 0, idleSec: 0, btnText: t('暂停', 'Pause'),
    isLocked: false, shocking: false, vibratorOn: false, pj01On: false,
    punishmentCount: 0, rewardCount: 0, statusText: '-',
    isLockedText: t('未锁', 'Unlocked'), shockingText: t('空闲', 'Idle'), vibratorOnText: t('待机', 'Standby'), pj01OnText: t('关闭', 'Off'),
  };

  const $ = (s) => Array.from(document.querySelectorAll(s));
  function render() {
    view.isLockedText = rt.isLocked ? t('已锁', 'Locked') : t('未锁', 'Unlocked');
    view.shockingText = rt.shocking ? t('进行中', 'Active') : t('空闲', 'Idle');
    view.vibratorOnText = rt.vibratorOn ? t('工作中', 'On') : t('待机', 'Standby');
    view.pj01OnText = rt.pj01On ? t('工作中', 'On') : t('关闭', 'Off');
    $('[data-bind]').forEach((el) => {
      const k = el.getAttribute('data-bind');
      let v = (k in view) ? view[k] : el.textContent;
      if (k === 'startTime') { const n = Number(v); v = (!Number.isNaN(n) && n > 0) ? new Date(n).toLocaleString() : '-'; }
      el.textContent = (v === undefined || v === null) ? '' : String(v);
    });
    $('[data-class]').forEach((el) => {
      const m = (el.getAttribute('data-class') || '').match(/\s*([^:]+)\s*:\s*(.+)\s*/);
      if (!m) return;
      el.classList.toggle(m[2], !!view[m[1]]);
    });
    const cr = Math.max(0, Math.min(100, Number(view.completionRate) || 0));
    const cb = document.getElementById('countBar'); if (cb) cb.style.width = cr + '%';
    const cib = document.getElementById('countInlineBar'); if (cib) cib.style.width = cr + '%';
  }
  function addLog(level, message) {
    const li = document.createElement('li');
    const lvl = String(level || 'info').toLowerCase();
    li.className = lvl;
    li.textContent = '[' + new Date().toLocaleTimeString() + '] ' + lvl + ' — ' + message;
    const ul = document.getElementById('logs');
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 10) ul.removeChild(ul.lastChild);
    try { DeviceAPI.log(lvl === 'success' ? 'info' : lvl, message); } catch (_) {}
  }

  // 浏览器语音提示（speechSynthesis 原生，无需库）
  function speak(text) {
    if (!cfg.enableVoice) return;
    try {
      if (!('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = (typeof GameI18n !== 'undefined' && GameI18n.isEn && GameI18n.isEn()) ? 'en-US' : 'zh-CN';
      u.rate = 1.1;
      speechSynthesis.speak(u);
    } catch (_) {}
  }

  function setStrength(dev, v) { if (DeviceAPI.device(dev).isMapped()) DeviceAPI.device(dev).invoke('strength', 'set', { value: Math.round(v) }); }
  function startShock(voltage) { if (DeviceAPI.device(SHOCK).isMapped()) DeviceAPI.device(SHOCK).invoke('shock', 'start', { voltage }); }
  function stopShockDev() { if (DeviceAPI.device(SHOCK).isMapped()) DeviceAPI.device(SHOCK).invoke('shock', 'stop', {}); }
  function setLockOpen(open) { if (DeviceAPI.device(LOCK).isMapped()) DeviceAPI.device(LOCK).invoke('lock', 'setOpen', { open: !!open }); }

  function setLock(open) {
    setLockOpen(open);
    rt.isLocked = !open;
    view.isLocked = rt.isLocked;
  }
  function onComplete() {
    rt.completedCount += 1;
    rt.consecutiveCount += 1;
    view.completedCount = rt.completedCount;
    view.phase = rt.phase;
    addLog('info', `完成 ${rt.completedCount}/${cfg.targetCount}`);
    speak(String(rt.completedCount));
    if (rt.completedCount >= cfg.targetCount) { end(); addLog('success', '目标完成，训练结束'); speak(t('目标完成，训练结束', 'Target reached. Training over')); return; }
    if (rt.consecutiveCount >= cfg.rewardTriggerCount) {
      if (Math.random() * 100 < cfg.rewardTriggerProbability) triggerReward();
    }
  }
  function triggerReward() {
    if (rt.vibratorOn) return;
    rt.vibratorOn = true; rt.rewardCount += 1;
    view.vibratorOn = true; view.rewardCount = rt.rewardCount;
    addLog('warn', `奖励干扰 开始 强度=${cfg.vibratorIntensity} 时长=${cfg.vibratorDuration}s`);
    speak(t('奖励', 'Reward'));
    setStrength(VIBE, cfg.vibratorIntensity);
    rt.vibratorTimer = setTimeout(stopVibrator, Math.max(1, cfg.vibratorDuration) * 1000);
  }
  function stopVibrator() {
    if (!rt.vibratorOn) return;
    rt.vibratorOn = false; view.vibratorOn = false;
    setStrength(VIBE, 0);
    if (rt.vibratorTimer) { clearTimeout(rt.vibratorTimer); rt.vibratorTimer = null; }
    addLog('info', '奖励干扰停止');
  }
  function triggerPunishment() {
    if (rt.shocking) return;
    rt.consecutiveCount = 0; rt.punishmentCount += 1;
    view.punishmentCount = rt.punishmentCount;
    const iv = (Math.random() - 0.5) * 2 * cfg.randomIntensityRange;
    const dv = (Math.random() - 0.5) * 2 * cfg.randomDurationRange;
    const intensity = Math.max(10, Math.min(100, cfg.shockIntensity + iv));
    const duration = Math.max(1, Math.min(10, cfg.shockDuration + dv));
    rt.shocking = true; rt.lastActionTs = Date.now();
    view.shocking = true;
    addLog('error', `惩罚 电压=${intensity.toFixed(1)}V 时长=${duration.toFixed(1)}s`);
    speak(t('惩罚', 'Punish'));
    startShock(Math.round(intensity));
    rt.shockTimer = setTimeout(stopShockSeq, Math.round(duration * 1000));
    startPJ01();
  }
  function startPJ01() {
    if (rt.pj01On) return;
    rt.pj01On = true; view.pj01On = true;
    setStrength('pj01', 255); // 无映射则自动跳过
    rt.pj01Timer = setTimeout(stopPJ01, Math.max(1, cfg.pj01Duration) * 1000);
  }
  function stopPJ01() {
    if (!rt.pj01On) return;
    rt.pj01On = false; view.pj01On = false;
    setStrength('pj01', 0);
    if (rt.pj01Timer) { clearTimeout(rt.pj01Timer); rt.pj01Timer = null; }
  }
  function stopShockSeq() {
    if (!rt.shocking) return;
    rt.shocking = false; view.shocking = false;
    stopShockDev();
    if (rt.shockTimer) { clearTimeout(rt.shockTimer); rt.shockTimer = null; }
    addLog('info', '惩罚停止');
  }

  function loop() {
    if (!rt.running) return;
    const elapsedMs = Date.now() - rt.startTime;
    const totalMs = cfg.duration * 60 * 1000;
    const remainMs = Math.max(0, totalMs - elapsedMs);
    if (remainMs <= 0) { end(); return; }
    const mm = Math.floor(remainMs / 60000);
    const ss = Math.floor((remainMs % 60000) / 1000);
    const idleSec = Math.floor((Date.now() - rt.lastActionTs) / 1000);
    view.remainText = `${mm}:${String(ss).padStart(2, '0')}`;
    view.idleSec = idleSec;
    view.completedCount = rt.completedCount;
    view.targetCount = cfg.targetCount;
    view.completionRate = cfg.targetCount > 0 ? Number(((rt.completedCount / cfg.targetCount) * 100).toFixed(1)) : 0;
    view.phase = rt.phase;
    if (!rt.paused && !rt.shocking && idleSec >= cfg.idleTimeLimit) {
      triggerPunishment();
    } else if (!rt.shocking && idleSec >= cfg.idleTimeLimit - 5) {
      const now = Date.now();
      if (now - rt.lastIdleWarnTs > 5000) {
        rt.lastIdleWarnTs = now;
        addLog('warn', `还有 ${Math.max(0, cfg.idleTimeLimit - idleSec)} 秒将触发惩罚`);
        view.statusText = t('警告：快动起来！', 'Warning: move!');
        speak(t('快动起来', 'Move'));
      }
    }
    render();
  }
  function start() {
    rt.startTime = Date.now();
    rt.running = true; rt.paused = false;
    rt.completedCount = 0; rt.consecutiveCount = 0; rt.phase = 'up';
    rt.lastActionTs = Date.now(); rt.lastIdleWarnTs = 0;
    rt.shocking = false; rt.vibratorOn = false; rt.pj01On = false;
    rt.punishmentCount = 0; rt.rewardCount = 0;
    view.running = true; view.startTime = rt.startTime; view.statusText = t('准备就绪', 'Ready');
    view.targetCount = cfg.targetCount;
    addLog('info', '俯卧撑检测启动');
    if (DeviceAPI.device(QTZ).isMapped()) {
      DeviceAPI.device(QTZ).invoke('distance', 'configure', {
        lowBand: Math.round(cfg.downThreshold * 10),
        highBand: Math.round(cfg.upThreshold * 10),
        reportDelayMs: 500,
      });
    }
    DeviceAPI.device(QTZ).onMessage((payload) => {
      if (!rt.running || rt.paused) return;
      const now = Date.now();
      if (payload && payload.method === 'low') {
        if (rt.phase === 'up') { rt.phase = 'down'; rt.lastActionTs = now; addLog('info', '下降阶段'); }
      } else if (payload && payload.method === 'high') {
        if (rt.phase === 'down') { rt.phase = 'up'; rt.lastActionTs = now; onComplete(); }
      }
    });
    const qtzDevice = DeviceAPI.device(QTZ);
    const applyDistance = (val) => {
      rt.currentDistance = Number(val) ? (Number(val) / 10).toFixed(1) : 0;
      view.currentDistance = rt.currentDistance;
    };
    qtzDevice.onValue('distance', applyDistance);
    qtzDevice.readValue('distance').then((values) => {
      if (!rt.running) return;
      const current = Array.isArray(values) ? values.find((value) => value !== null && value !== undefined) : values;
      if (current !== null && current !== undefined) applyDistance(current);
    }).catch((error) => addLog('warn', `读取当前距离失败: ${error && error.message || error}`));
    setLock(false);
    render();
  }
  function end() {
    if (!rt.running) return;
    rt.running = false;
    [rt.shockTimer, rt.vibratorTimer, rt.pj01Timer].forEach((t) => { if (t) clearTimeout(t); });
    rt.shockTimer = rt.vibratorTimer = rt.pj01Timer = null;
    stopShockDev();
    setStrength(VIBE, 0);
    setStrength('pj01', 0);
    if (DeviceAPI.device(QTZ).isMapped()) DeviceAPI.device(QTZ).invoke('distance', 'configure', { reportDelayMs: 10000 });
    setLock(true);
    view.running = false; view.statusText = t('训练结束', 'Training over');
    addLog('info', `完成 ${rt.completedCount}/${cfg.targetCount}，惩罚 ${rt.punishmentCount}，奖励 ${rt.rewardCount}`);
    render();
  }

  function bindActions() {
    $('[data-action]').forEach((el) => {
      const name = el.getAttribute('data-action');
      el.addEventListener('click', () => {
        if (name === 'pause') {
          rt.paused = !rt.paused;
          view.statusText = rt.paused ? t('已暂停', 'Paused') : t('运行中', 'Running');
          view.btnText = rt.paused ? t('继续', 'Resume') : t('暂停', 'Pause');
          addLog('info', rt.paused ? '已暂停' : '已继续');
          render();
        }
      });
    });
  }
  let loopTimer = null;
  async function boot() {
    bindActions();
    if (typeof GameI18n !== 'undefined' && GameI18n.apply) GameI18n.apply();
    render();
    try { await DeviceAPI.ready; } catch (_) {}
    const p = DeviceAPI.params || {};
    Object.keys(cfg).forEach((k) => { if (p[k] !== undefined && p[k] !== null) cfg[k] = p[k]; });
    addLog('info', '设备通道就绪，开始游戏');
    start();
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = setInterval(loop, 500);
  }

  window.__game = { start, loop, end, rt, cfg, view };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
