// 女仆偷懒惩罚 — 页面自驱动（DeviceAPI），逻辑/UI 对齐老版 maidPunishmentEmbedded.js
(function () {
  'use strict';
  const QTZ = 'qtz';      // 老版 qtz_sensor
  const SHOCK = 'shock';  // 老版 shock_device
  const MOTOR = 'motor';  // 老版 td01_device
  const LOCK = 'lock';    // 老版 auto_lock

  const cfg = {
    duration: 10, shockIntensity: 24, progressiveIntensity: false, maxIntensityIncrease: 10,
    allowUnsafeIntensity: false, td01DelaySeconds: 5, td01IntensityIncrease: 50,
    manualStart: false, td01ShockProbability: 0,
  };
  const rt = {
    startTime: 0, isActive: false, paused: false, isLocked: false, waitingForManualStart: false,
    button0Pressed: false, button1Pressed: false, isShocking: false, shockCount: 0,
    lastNoShockTs: 0, td01Active: false, td01Intensity: 0, lastTd01IncreaseTs: 0, hasTd01: false,
  };
  const view = {
    running: false, startTime: 0, isLocked: false, lockedText: '', remainingSec: '-',
    statusText: '-', btnText: '暂停', button0Pressed: false, button1Pressed: false,
    isShocking: false, shockCount: 0, td01Active: false, td01Intensity: 0,
  };

  const $ = (s) => Array.from(document.querySelectorAll(s));
  function render() {
    $('[data-bind]').forEach((el) => {
      const k = el.getAttribute('data-bind');
      let v = (k in view) ? view[k] : el.textContent;
      if (k === 'startTime') { const n = Number(v); v = (!Number.isNaN(n) && n > 0) ? new Date(n).toLocaleString() : '-'; }
      el.textContent = (v === undefined || v === null) ? '' : String(v);
    });
  }
  function addLog(level, message) {
    const li = document.createElement('li');
    li.textContent = '[' + new Date().toLocaleTimeString() + '] ' + level + ' — ' + message;
    const ul = document.getElementById('logs');
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 10) ul.removeChild(ul.lastChild);
    try { DeviceAPI.log(level, message); } catch (_) {}
  }

  // 设备操作
  function setStrength(v) { if (DeviceAPI.device(MOTOR).isMapped()) DeviceAPI.device(MOTOR).invoke('strength', 'set', { value: Math.round(v) }); }
  function startShock(voltage) { if (DeviceAPI.device(SHOCK).isMapped()) DeviceAPI.device(SHOCK).invoke('shock', 'start', { voltage }); }
  function stopShockDev() { if (DeviceAPI.device(SHOCK).isMapped()) DeviceAPI.device(SHOCK).invoke('shock', 'stop', {}); }
  function setLockOpen(open) { if (DeviceAPI.device(LOCK).isMapped()) DeviceAPI.device(LOCK).invoke('lock', 'setOpen', { open: !!open }); }

  // 占位
  function setLock(isOpen) {
    setLockOpen(isOpen);
    rt.isLocked = !isOpen;
    view.isLocked = rt.isLocked;
    view.lockedText = isOpen ? '已解锁' : '已加锁';
    render();
  }
  function calcShockVoltage() {
    let v = cfg.shockIntensity || 24;
    if (cfg.progressiveIntensity) {
      const inc = Math.min(rt.shockCount * 5, cfg.maxIntensityIncrease || 0);
      v = Math.min(v + inc, 100);
    }
    if (!cfg.allowUnsafeIntensity) v = Math.min(v, 30);
    return v;
  }
  function startShockSeq() {
    if (rt.isShocking) return;
    const voltage = calcShockVoltage();
    rt.isShocking = true;
    rt.shockCount += 1;
    startShock(voltage);
    view.isShocking = true; view.shockCount = rt.shockCount; view.statusText = `电击中(${voltage}V)`;
    addLog('warn', `电击 ${voltage}V（第 ${rt.shockCount} 次）`);
    render();
  }
  function stopShockSeq() {
    if (!rt.isShocking) return;
    stopShockDev();
    rt.isShocking = false;
    view.isShocking = false; view.statusText = '运行中';
    render();
  }
  function startTd01() {
    if (!rt.hasTd01 || rt.td01Active) return;
    rt.td01Active = true; rt.td01Intensity = 10; rt.lastTd01IncreaseTs = Date.now();
    setStrength(rt.td01Intensity);
    view.td01Active = true; view.td01Intensity = rt.td01Intensity;
    addLog('info', 'TD01 启动');
    const prob = Math.max(0, Math.min(100, Number(cfg.td01ShockProbability) || 0));
    if (prob > 0 && Math.random() * 100 < prob) {
      const v = calcShockVoltage();
      startShock(v); rt.isShocking = true; rt.shockCount += 1;
      view.isShocking = true; view.shockCount = rt.shockCount;
    }
    render();
  }
  function stopTd01() {
    if (!rt.td01Active) return;
    setStrength(0);
    rt.td01Active = false; rt.td01Intensity = 0;
    view.td01Active = false; view.td01Intensity = 0;
    render();
  }
  function resetTd01() { stopTd01(); rt.lastNoShockTs = Date.now(); }
  function onButtonsChanged() {
    const anyPressed = rt.button0Pressed || rt.button1Pressed;
    view.button0Pressed = rt.button0Pressed; view.button1Pressed = rt.button1Pressed;
    if (anyPressed && !rt.isShocking) { startShockSeq(); resetTd01(); }
    else if (!anyPressed && rt.isShocking) { stopShockSeq(); rt.lastNoShockTs = Date.now(); }
    render();
  }
  function forceStart() {
    if (rt.isActive) return;
    rt.waitingForManualStart = false; rt.isActive = true;
    rt.startTime = Date.now(); rt.lastNoShockTs = Date.now();
    setLock(false);
    view.statusText = '运行中'; view.running = true;
    render();
  }
  function loop() {
    if (rt.waitingForManualStart) return;
    if (!rt.isActive) return;
    if (rt.paused) return;
    const elapsed = Date.now() - rt.startTime;
    const total = Math.max(1, Math.floor(cfg.duration)) * 60 * 1000;
    view.remainingSec = Math.max(0, Math.ceil((total - elapsed) / 1000));
    if (elapsed >= total) { end(); return; }
    if (rt.hasTd01 && !rt.isShocking) {
      const sinceNoShock = Date.now() - rt.lastNoShockTs;
      const needDelay = (cfg.td01DelaySeconds || 5) * 1000;
      if (!rt.td01Active && sinceNoShock >= needDelay) startTd01();
      if (rt.td01Active) {
        const now = Date.now();
        if (now - (rt.lastTd01IncreaseTs || 0) >= 5000) {
          rt.td01Intensity = Math.min(rt.td01Intensity + (cfg.td01IntensityIncrease || 50), 255);
          setStrength(rt.td01Intensity);
          rt.lastTd01IncreaseTs = now;
          view.td01Active = true; view.td01Intensity = rt.td01Intensity;
        }
      }
    }
    render();
  }
  function start() {
    rt.startTime = Date.now();
    rt.isActive = !cfg.manualStart;
    rt.waitingForManualStart = !!cfg.manualStart;
    rt.lastNoShockTs = Date.now();
    rt.hasTd01 = DeviceAPI.device(MOTOR).isMapped();
    view.running = true; view.startTime = rt.startTime;
    view.statusText = rt.waitingForManualStart ? '等待手动开启' : '运行中';
    addLog('info', '女仆惩罚启动');
    // 监听 QTZ 按钮（button0/button1 属性）
    DeviceAPI.device(QTZ).onProperty('button0', (nv) => { rt.button0Pressed = (Number(nv) === 1); onButtonsChanged(); });
    DeviceAPI.device(QTZ).onProperty('button1', (nv) => { rt.button1Pressed = (Number(nv) === 1); onButtonsChanged(); });
    // 手动开启：监听锁按键
    if (cfg.manualStart) {
      DeviceAPI.device(LOCK).onMessage((payload) => {
        if (payload && payload.method === 'action' && payload.action === 'key_clicked') forceStart();
      });
      setLock(true);
    } else {
      setLock(false);
    }
    render();
  }
  function end() {
    stopShockSeq(); stopTd01(); setLock(true);
    rt.isActive = false;
    view.running = false; view.statusText = '已结束';
    addLog('info', `女仆惩罚结束（电击 ${rt.shockCount} 次）`);
    render();
  }

  window.__game = { start, loop, end, rt, cfg, view };

  function bindActions() {
    $('[data-action]').forEach((el) => {
      const name = el.getAttribute('data-action');
      el.addEventListener('click', () => {
        if (name === 'pause') {
          rt.paused = !rt.paused;
          view.statusText = rt.paused ? '已暂停' : '运行中';
          view.btnText = rt.paused ? '继续' : '暂停';
          if (rt.paused) { stopShockSeq(); stopTd01(); }
          addLog('info', rt.paused ? '已暂停' : '已继续');
          render();
        } else if (name === 'forceStart') {
          forceStart();
        } else if (name === 'unlock') {
          setLock(true);
          addLog('info', '手动解锁');
        }
      });
    });
  }

  let loopTimer = null;
  async function boot() {
    bindActions();
    render();
    try { await DeviceAPI.ready; } catch (_) {}
    const p = DeviceAPI.params || {};
    Object.keys(cfg).forEach((k) => { if (p[k] !== undefined && p[k] !== null) cfg[k] = p[k]; });
    addLog('info', '设备通道就绪，开始游戏');
    start();
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = setInterval(loop, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
