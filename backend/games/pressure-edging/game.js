// 气压寸止玩法 — 页面自驱动逻辑（新架构：DeviceAPI Bridge）
// 业务逻辑对齐老版 pressureEdgingEmbedded.js，UI 完全一致，仅后台接入改为 DeviceAPI。
(function () {
  'use strict';

  // 设备逻辑 ID（对齐 manifest）
  const SENSOR = 'sensor';   // 气压传感器 (QIYA)  -> 老版 QIYA_DEVICE
  const MOTOR = 'motor';     // 偏轴电机 (TD01)    -> 老版 TD_DEVICE
  const PUNISH = 'punish';   // 电击设备 (DIANJI)  -> 老版 DIANJI_DEVICE
  const LOCK = 'lock';       // 自动锁            -> 老版 ZIDONGSUO_DEVICE

  // 配置（从 DeviceAPI.params 合并，含默认值）
  const cfg = {
    duration: 20,
    criticalPressure: 20,
    maxMotorIntensity: 50,
    lowPressureDelay: 5,
    rampRate: 2,
    sensitivity: 1.0,
    randomPercent: 0,
    gradualIncrease: 2,
    shockVoltage: 20,
    shockDuration: 3,
  };

  // 运行态
  const rt = {
    running: false,
    paused: false,
    startTime: 0,
    endTime: 0,
    lastUpdateTs: 0,
    currentPressure: 0,
    maxPressure: 0,
    minPressure: 999,
    averagePressure: 0,
    pressureHistory: [],
    targetIntensity: 0,
    currentIntensity: 0,
    isInDelayPeriod: false,
    delayStartTime: 0,
    baseIntensity: 0,
    intensityIncreaseStartTime: 0,
    isShocking: false,
    edgingCount: 0,
    wasOverPressure: false,
    shockTimer: null,
    totalStimulationTime: 0,
  };

  // UI 渲染用的合并状态
  const view = {
    running: false,
    paused: false,
    startTime: 0,
    statusText: '准备就绪',
    btnText: '暂停',
    currentPressure: 0,
    averagePressure: 0,
    currentIntensity: 0,
    targetIntensity: 0,
    edgingCount: 0,
    totalStimulationTime: 0,
  };

  const $ = (sel) => Array.from(document.querySelectorAll(sel));
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function render() {
    $('[data-bind]').forEach((el) => {
      const key = el.getAttribute('data-bind');
      let val = (key in view) ? view[key] : el.textContent;
      if (key === 'startTime') {
        const num = Number(val);
        val = (!Number.isNaN(num) && num > 0) ? new Date(num).toLocaleString() : '-';
      }
      if (el.tagName === 'STRONG') {
        const num = Number(val);
        if (!Number.isNaN(num)) val = num.toFixed(2);
      }
      el.textContent = (val === undefined || val === null) ? '' : String(val);
    });
    $('[data-show]').forEach((el) => {
      const key = el.getAttribute('data-show');
      el.classList.toggle('hidden', !view[key]);
    });
    const c = Number(cfg.criticalPressure) || 20;
    const m = Number(cfg.maxMotorIntensity) || 50;
    const pBar = document.getElementById('pBar');
    const iBar = document.getElementById('iBar');
    const tBar = document.getElementById('tBar');
    if (pBar) pBar.style.width = (clamp((Number(view.currentPressure) || 0) / c, 0, 1) * 100).toFixed(1) + '%';
    if (iBar) iBar.style.width = (clamp((Number(view.currentIntensity) || 0) / m, 0, 1) * 100).toFixed(1) + '%';
    if (tBar) tBar.style.width = (clamp((Number(view.targetIntensity) || 0) / m, 0, 1) * 100).toFixed(1) + '%';
  }

  function addLog(level, message) {
    const li = document.createElement('li');
    li.className = 'l-' + (level || 'info');
    li.textContent = '[' + new Date().toLocaleTimeString() + '] ' + level + ' — ' + message;
    const ul = document.getElementById('logs');
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 10) ul.removeChild(ul.lastChild);
    try { DeviceAPI.log(level, message); } catch (_) {}
  }

  // ---- 设备操作封装（DeviceAPI） ----
  function setStrength(v) {
    const rounded = Math.round(v);
    if (!Number.isNaN(rounded) && DeviceAPI.device(MOTOR).isMapped()) {
      DeviceAPI.device(MOTOR).invoke('strength', 'set', { value: rounded });
    }
  }
  function startShock(voltage) {
    if (DeviceAPI.device(PUNISH).isMapped()) DeviceAPI.device(PUNISH).invoke('shock', 'start', { voltage });
  }
  function stopShock() {
    if (DeviceAPI.device(PUNISH).isMapped()) DeviceAPI.device(PUNISH).invoke('shock', 'stop', {});
  }
  function setLockOpen(open) {
    if (DeviceAPI.device(LOCK).isMapped()) DeviceAPI.device(LOCK).invoke('lock', 'setOpen', { open: !!open });
  }

  // 占位：在后续 edit 中填充
  function triggerShock(force) {
    if (!force && rt.isShocking) return;
    try {
      rt.isShocking = true;
      addLog('warn', `触发电击 — ${cfg.shockVoltage}V / ${cfg.shockDuration}s`);
      startShock(cfg.shockVoltage);
      if (rt.shockTimer) clearTimeout(rt.shockTimer);
      rt.shockTimer = setTimeout(() => {
        stopShock();
        rt.isShocking = false;
        addLog('info', '电击结束');
      }, Math.max(100, cfg.shockDuration * 1000));
    } catch (e) {
      rt.isShocking = false;
      addLog('error', '触发电击失败: ' + (e && e.message || e));
    }
  }

  function loop() {
    if (!rt.running) return;
    if (rt.paused) { render(); return; }
    const now = Date.now();
    const dtSec = Math.max(0, (now - rt.lastUpdateTs) / 1000);
    rt.lastUpdateTs = now;

    if (now >= rt.endTime) { end(); return; }

    const pressure = rt.currentPressure;
    if (pressure >= cfg.criticalPressure) {
      // 超压：停止刺激并触发电击；一次连续超压只计一次寸止
      if (!rt.wasOverPressure) {
        rt.edgingCount += 1;
        view.edgingCount = rt.edgingCount;
      }
      rt.wasOverPressure = true;
      rt.targetIntensity = 0;
      rt.isInDelayPeriod = false;
      rt.baseIntensity = 0;
      rt.intensityIncreaseStartTime = 0;
      triggerShock(false);
    } else {
      rt.wasOverPressure = false;
      const pressureDiff = cfg.criticalPressure - pressure;
      const normalizedDiff = pressureDiff / Math.max(1e-6, cfg.criticalPressure);
      if (!rt.isInDelayPeriod) {
        rt.isInDelayPeriod = true;
        rt.delayStartTime = now;
        rt.targetIntensity = 0;
        rt.baseIntensity = 0;
        rt.intensityIncreaseStartTime = 0;
        addLog('info', `压力低于临界值，开始延迟 ${cfg.lowPressureDelay}s`);
        view.statusText = `延迟期中(${cfg.lowPressureDelay}s)…`;
      } else {
        const delayElapsed = (now - rt.delayStartTime) / 1000;
        if (delayElapsed >= cfg.lowPressureDelay) {
          const baseTarget = normalizedDiff * cfg.maxMotorIntensity * cfg.sensitivity;
          if (rt.intensityIncreaseStartTime === 0) {
            rt.baseIntensity = baseTarget;
            rt.intensityIncreaseStartTime = now;
            addLog('info', `延迟结束，基础强度: ${baseTarget.toFixed(1)}，开始逐步提升`);
            view.statusText = '强度逐步提升中…';
          }
          const incElapsed = (now - rt.intensityIncreaseStartTime) / 1000;
          let target = (rt.baseIntensity || 0) + incElapsed * (cfg.gradualIncrease || 0);
          if (cfg.randomPercent > 0) {
            const rnd = 1 + (Math.random() - 0.5) * 2 * (cfg.randomPercent / 100);
            target *= rnd;
          }
          rt.targetIntensity = Math.min(Math.max(target, 0), cfg.maxMotorIntensity);
        }
      }
    }

    // 速率限制并下发
    const maxChange = Math.max(0, cfg.rampRate) * dtSec;
    const cur = rt.currentIntensity;
    const tgt = rt.targetIntensity;
    let next = (tgt > cur) ? Math.min(cur + maxChange, tgt) : tgt;
    const appliedIntensity = Math.round(next);
    setStrength(appliedIntensity);
    rt.currentIntensity = next;
    if (appliedIntensity > 0) rt.totalStimulationTime += dtSec;

    view.currentPressure = rt.currentPressure;
    view.averagePressure = rt.averagePressure;
    view.currentIntensity = appliedIntensity;
    view.targetIntensity = rt.targetIntensity;
    view.edgingCount = rt.edgingCount;
    view.totalStimulationTime = Number(rt.totalStimulationTime.toFixed(1));
    render();
  }

  function start() {
    const now = Date.now();
    rt.running = true;
    rt.paused = false;
    rt.startTime = now;
    rt.endTime = now + cfg.duration * 60 * 1000;
    rt.lastUpdateTs = now;
    rt.edgingCount = 0;
    rt.wasOverPressure = false;
    view.edgingCount = 0;
    view.running = true;
    view.startTime = now;
    view.statusText = '准备就绪';

    // 初始化设备
    try {
      if (DeviceAPI.device(SENSOR).isMapped()) DeviceAPI.device(SENSOR).invoke('reporting', 'setReportDelay', { ms: 100 });
      setStrength(0);
      setLockOpen(false);
      stopShock();
    } catch (e) { addLog('warn', '初始化设备失败: ' + (e && e.message || e)); }

    // 监听压力
    const sensorDevice = DeviceAPI.device(SENSOR);
    const applyPressure = (newVal) => {
      const p = Number(newVal) || 0;
      rt.currentPressure = p;
      rt.maxPressure = Math.max(rt.maxPressure, p);
      rt.minPressure = Math.min(rt.minPressure, p);
      rt.pressureHistory.push({ ts: Date.now(), pressure: p });
      const recent = rt.pressureHistory.slice(-60);
      const sum = recent.reduce((a, it) => a + (Number(it.pressure) || 0), 0);
      rt.averagePressure = recent.length ? sum / recent.length : p;
      view.currentPressure = p;
      view.averagePressure = rt.averagePressure;
    };
    sensorDevice.onValue('sphincterPressure', applyPressure);
    sensorDevice.readValue('sphincterPressure').then((values) => {
      if (!rt.running) return;
      const current = Array.isArray(values) ? values.find((value) => value !== null && value !== undefined) : values;
      if (current !== null && current !== undefined) applyPressure(current);
    }).catch((error) => addLog('warn', `读取当前气压失败: ${error && error.message || error}`));
    addLog('info', '气压寸止玩法已启动');
    render();
  }

  function end() {
    try { setStrength(0); } catch (_) {}
    try { stopShock(); } catch (_) {}
    try { setLockOpen(true); } catch (_) {}
    try { if (DeviceAPI.device(SENSOR).isMapped()) DeviceAPI.device(SENSOR).invoke('reporting', 'setReportDelay', { ms: 5000 }); } catch (_) {}
    rt.running = false;
    rt.paused = false;
    if (rt.shockTimer) { clearTimeout(rt.shockTimer); rt.shockTimer = null; }
    view.running = false;
    view.statusText = '已结束';
    view.btnText = '暂停';
    addLog('info', `气压寸止玩法结束（寸止 ${rt.edgingCount} 次）`);
    render();
  }

  // 暴露给底部启动
  window.__pe = { start, loop, end, triggerShock, render, addLog, rt, cfg, view };

  // ---- 按钮交互（页面本地，直接操作，不回传宿主） ----
  function bindActions() {
    $('[data-action]').forEach((el) => {
      const name = el.getAttribute('data-action');
      el.addEventListener('click', () => {
        if (name === 'pause') {
          rt.paused = !rt.paused;
          view.paused = rt.paused;
          view.statusText = rt.paused ? '已暂停' : '运行中';
          view.btnText = rt.paused ? '继续' : '暂停';
          if (rt.paused) setStrength(0);
          addLog('info', rt.paused ? '已暂停' : '已继续');
          render();
        } else if (name === 'addIntensity') {
          rt.targetIntensity = Math.min(cfg.maxMotorIntensity, Math.max(0, rt.targetIntensity + 10));
          view.targetIntensity = rt.targetIntensity;
          addLog('info', `手动调整目标强度 +10 → ${rt.targetIntensity.toFixed(1)}`);
          render();
        } else if (name === 'shockOnce') {
          triggerShock(true);
        }
      });
    });
  }

  // ---- 启动 ----
  let loopTimer = null;
  async function boot() {
    bindActions();
    render();
    try {
      await DeviceAPI.ready;
    } catch (_) {}
    // 合并启动参数
    const p = DeviceAPI.params || {};
    Object.keys(cfg).forEach((k) => { if (p[k] !== undefined && p[k] !== null) cfg[k] = p[k]; });
    addLog('info', '设备通道就绪，开始游戏');
    start();
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = setInterval(loop, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
