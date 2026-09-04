// 提肛训练玩法 — 页面自驱动（DeviceAPI），逻辑/UI 对齐老版 pelvicTrainingEmbedded.js
(function () {
  'use strict';
  function L() { return (typeof GameI18n !== 'undefined' && GameI18n.t) ? GameI18n.t : function (zh) { return zh; }; }
  function t(zh, vars) { return L()(zh, vars); }
  const SENSOR = 'sensor';
  const PUNISH = 'punish';
  const LOCK = 'lock';

  const cfg = { duration: 20, targetCount: 50, pressureDelta: 0.3, shockVoltage: 20, shockDuration: 3, cycleTime: 10 };
  const rt = {
    running: false, paused: false, startTime: 0, endTime: 0, lastUpdateTs: 0,
    currentPressure: 0, phase: 'relax', phaseStartTs: 0, relaxMinPressure: 0,
    clenchTargetPressure: 0, clenchSuccess: false, clenchFailed: false,
    successCount: 0, shockCount: 0, isShocking: false, shockTimer: null,
  };
  const view = {
    running: false, startTime: 0, currentPressure: 0, phase: 'relax', phaseRemaining: 0,
    relaxMinPressure: 0, clenchTargetPressure: 0, clenchSuccess: false, clenchFailed: false,
    successCount: 0, shockCount: 0, statusText: '-', btnText: t('暂停'),
    countProgressPercent: 0, timeProgressPercent: 0,
  };

  const $ = (s) => Array.from(document.querySelectorAll(s));
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function render() {
    $('[data-bind]').forEach((el) => {
      const k = el.getAttribute('data-bind');
      let v = (k in view) ? view[k] : el.textContent;
      if (k === 'startTime') { const n = Number(v); v = (!Number.isNaN(n) && n > 0) ? new Date(n).toLocaleString() : '-'; }
      if (el.tagName === 'STRONG') { const n = Number(v); if (!Number.isNaN(n)) v = n.toFixed(2); }
      el.textContent = (v === undefined || v === null) ? '' : String(v);
    });
    const phaseMap = { relax: t('放松阶段'), clench: t('提肛阶段') };
    const stageEl = document.getElementById('stageText');
    const remainEl = document.getElementById('remainText');
    if (stageEl) stageEl.textContent = t('当前阶段：') + (phaseMap[view.phase] || '-');
    if (remainEl) remainEl.textContent = String(view.phaseRemaining || 0);
    const cBar = document.getElementById('countBar');
    const tBar = document.getElementById('timeBar');
    if (cBar) cBar.style.width = clamp(Number(view.countProgressPercent) || 0, 0, 100).toFixed(1) + '%';
    if (tBar) tBar.style.width = clamp(Number(view.timeProgressPercent) || 0, 0, 100).toFixed(1) + '%';
    $('[data-show]').forEach((el) => { el.style.display = view[el.getAttribute('data-show')] ? '' : 'none'; });
  }
  function addLog(level, message) {
    const li = document.createElement('li');
    li.className = level;
    li.textContent = '[' + new Date().toLocaleTimeString() + '] ' + level + ' — ' + message;
    const ul = document.getElementById('logs');
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 10) ul.removeChild(ul.lastChild);
    try { DeviceAPI.log(level, message); } catch (_) {}
  }

  function startShock(voltage) { if (DeviceAPI.device(PUNISH).isMapped()) DeviceAPI.device(PUNISH).invoke('shock', 'start', { voltage }); }
  function stopShockDev() { if (DeviceAPI.device(PUNISH).isMapped()) DeviceAPI.device(PUNISH).invoke('shock', 'stop', {}); }
  function setLockOpen(open) { if (DeviceAPI.device(LOCK).isMapped()) DeviceAPI.device(LOCK).invoke('lock', 'setOpen', { open: !!open }); }

  function triggerShock(force) {
    if (!force && rt.isShocking) return;
    try {
      rt.isShocking = true;
      rt.shockCount += 1;
      view.shockCount = rt.shockCount;
      startShock(cfg.shockVoltage);
      addLog('warn', `电击 ${cfg.shockVoltage}V / ${cfg.shockDuration}s`);
      if (rt.shockTimer) clearTimeout(rt.shockTimer);
      rt.shockTimer = setTimeout(() => { stopShockDev(); rt.isShocking = false; }, Math.max(100, cfg.shockDuration * 1000));
    } catch (_) { rt.isShocking = false; }
  }
  function loop() {
    if (!rt.running) return;
    if (rt.paused) return;
    const now = Date.now();
    rt.lastUpdateTs = now;
    if (now >= rt.endTime) { end(); return; }
    const p = rt.currentPressure;
    const elapsed = (now - rt.phaseStartTs) / 1000;
    if (rt.phase === 'relax') {
      if (elapsed >= cfg.cycleTime) {
        rt.phase = 'clench';
        rt.phaseStartTs = now;
        const base = rt.relaxMinPressure || p;
        rt.clenchTargetPressure = base + cfg.pressureDelta;
        rt.clenchSuccess = false;
        rt.clenchFailed = false;
        view.statusText = t('提肛阶段…');
        addLog('info', `进入提肛阶段，目标 ${rt.clenchTargetPressure.toFixed(2)} kPa`);
      }
    } else {
      if (!rt.clenchSuccess && p >= rt.clenchTargetPressure) rt.clenchSuccess = true;
      if (elapsed >= cfg.cycleTime) {
        if (rt.clenchSuccess) {
          rt.successCount += 1;
          addLog('info', `提肛成功（第 ${rt.successCount} 次）`);
        } else {
          rt.clenchFailed = true;
          triggerShock(false);
        }
        rt.phase = 'relax';
        rt.phaseStartTs = now;
        rt.relaxMinPressure = p;
        rt.clenchSuccess = false;
        view.statusText = t('放松阶段…');
      }
    }
    if (rt.successCount >= (cfg.targetCount || 0)) { end(); return; }
    const totalDur = Math.max(1, (rt.endTime - rt.startTime) / 1000);
    const elapsedTotal = Math.max(0, (now - rt.startTime) / 1000);
    view.currentPressure = rt.currentPressure;
    view.phase = rt.phase;
    view.successCount = rt.successCount;
    view.shockCount = rt.shockCount;
    view.relaxMinPressure = Number((rt.relaxMinPressure || 0).toFixed(2));
    view.clenchTargetPressure = Number((rt.clenchTargetPressure || 0).toFixed(2));
    view.phaseRemaining = Math.max(0, Number((cfg.cycleTime - elapsed).toFixed(1)));
    view.clenchSuccess = !!rt.clenchSuccess;
    view.clenchFailed = !!rt.clenchFailed;
    view.countProgressPercent = Number(clamp((rt.successCount / Math.max(1, cfg.targetCount)) * 100, 0, 100).toFixed(1));
    view.timeProgressPercent = Number(clamp((elapsedTotal / totalDur) * 100, 0, 100).toFixed(1));
    render();
  }
  function start() {
    const now = Date.now();
    rt.running = true; rt.paused = false;
    rt.startTime = now; rt.endTime = now + cfg.duration * 60 * 1000;
    rt.lastUpdateTs = now; rt.phase = 'relax'; rt.phaseStartTs = now;
    rt.successCount = 0; rt.shockCount = 0; rt.relaxMinPressure = 0;
    view.running = true; view.startTime = now; view.statusText = t('放松阶段…');
    try {
      if (DeviceAPI.device(SENSOR).isMapped()) DeviceAPI.device(SENSOR).invoke('reporting', 'setReportDelay', { ms: 100 });
      setLockOpen(false);
      stopShockDev();
    } catch (_) {}
    const sensorDevice = DeviceAPI.device(SENSOR);
    const applyPressure = (nv) => {
      const p = Number(nv) || 0;
      rt.currentPressure = p;
      if (rt.phase === 'relax') {
        if (rt.relaxMinPressure === 0) rt.relaxMinPressure = p;
        rt.relaxMinPressure = Math.min(rt.relaxMinPressure, p);
      }
      view.currentPressure = p;
    };
    sensorDevice.onValue('sphincterPressure', applyPressure);
    sensorDevice.readValue('sphincterPressure').then((values) => {
      if (!rt.running) return;
      const current = Array.isArray(values) ? values.find((value) => value !== null && value !== undefined) : values;
      if (current !== null && current !== undefined) applyPressure(current);
    }).catch((error) => addLog('warn', `读取当前气压失败: ${error && error.message || error}`));
    addLog('info', '提肛训练已启动');
    render();
  }
  function end() {
    try { stopShockDev(); } catch (_) {}
    try { setLockOpen(true); } catch (_) {}
    try { if (DeviceAPI.device(SENSOR).isMapped()) DeviceAPI.device(SENSOR).invoke('reporting', 'setReportDelay', { ms: 5000 }); } catch (_) {}
    rt.running = false; rt.paused = false;
    if (rt.shockTimer) { clearTimeout(rt.shockTimer); rt.shockTimer = null; }
    view.running = false; view.statusText = t('已结束');
    addLog('info', `提肛训练结束（成功 ${rt.successCount}，电击 ${rt.shockCount}）`);
    render();
  }

  window.__game = { start, loop, end, rt, cfg, view };

  function bindActions() {
    $('[data-action]').forEach((el) => {
      const name = el.getAttribute('data-action');
      el.addEventListener('click', () => {
        if (name === 'pause') {
          rt.paused = !rt.paused;
          view.statusText = rt.paused ? t('已暂停') : (rt.phase === 'relax' ? t('放松阶段…') : t('提肛阶段…'));
          view.btnText = rt.paused ? t('继续') : t('暂停');
          addLog('info', rt.paused ? '已暂停' : '已继续');
          render();
        } else if (name === 'shockOnce') {
          triggerShock(true);
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
    loopTimer = setInterval(loop, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
