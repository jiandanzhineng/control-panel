// 女仆偷懒惩罚 — 页面自驱动（DeviceAPI），逻辑/UI 对齐老版 maidPunishmentEmbedded.js
(function () {
  'use strict';
  function L() { return (typeof GameI18n !== 'undefined' && GameI18n.t) ? GameI18n.t : function (zh) { return zh; }; }
  function t(zh, vars) { return L()(zh, vars); }
  const QTZ = 'qtz';      // 老版 qtz_sensor
  const TIPTOE = 'tiptoeSensor'; // 踮脚压力传感器（tiptoePressure）
  const SHOCK = 'shock';  // 老版 shock_device
  const MOTOR = 'motor';  // 老版 td01_device
  const LOCK = 'lock';    // 老版 auto_lock

  const cfg = {
    duration: 10, shockIntensity: 24, progressiveIntensity: false, maxIntensityIncrease: 10,
    allowUnsafeIntensity: false, td01DelaySeconds: 5, td01IntensityIncrease: 50,
    manualStart: false, td01ShockProbability: 0,
    tiptoePressureThreshold: 100, tiptoeDebounceMs: 300,
  };
  const rt = {
    startTime: 0, isActive: false, paused: false, isLocked: false, waitingForManualStart: false,
    button0Pressed: false, button1Pressed: false, isShocking: false, shockCount: 0,
    lastNoShockTs: 0, td01Active: false, td01Intensity: 0, lastTd01IncreaseTs: 0, hasTd01: false,
    hasPressure: false, pressure1: 0, pressureViolated: false, pressureViolatedSince: 0,
  };
  const view = {
    running: false, startTime: 0, isLocked: false, lockedText: '', remainingSec: '-',
    statusText: '-', btnText: t('暂停'), button0Pressed: false, button1Pressed: false,
    isShocking: false, shockCount: 0, td01Active: false, td01Intensity: 0,
    hasPressure: false, pressure1: '-', pressureViolated: false,
  };

  const $ = (s) => Array.from(document.querySelectorAll(s));
  function render() {
    $('[data-bind]').forEach((el) => {
      const k = el.getAttribute('data-bind');
      let v = (k in view) ? view[k] : el.textContent;
      if (k === 'startTime') { const n = Number(v); v = (!Number.isNaN(n) && n > 0) ? new Date(n).toLocaleString() : '-'; }
      el.textContent = (v === undefined || v === null) ? '' : String(v);
    });
    $('[data-show]').forEach((el) => { el.style.display = view[el.getAttribute('data-show')] ? '' : 'none'; });
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
    view.lockedText = isOpen ? t('已解锁') : t('已加锁');
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
    view.isShocking = true; view.shockCount = rt.shockCount; view.statusText = t('电击中({v}V)').replace('{v}', voltage);
    addLog('warn', `电击 ${voltage}V（第 ${rt.shockCount} 次）`);
    render();
  }
  function stopShockSeq() {
    if (!rt.isShocking) return;
    stopShockDev();
    rt.isShocking = false;
    view.isShocking = false; view.statusText = t('运行中');
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
  // 统一的“是否没踮脚”判定：按钮线或踮脚压力能力值持续超阈值
  function applyTiptoeState() {
    if (rt.paused) return; // 暂停期间不因传感器触发电击；恢复时会重新评估
    const buttonLost = rt.button0Pressed || rt.button1Pressed;
    const pressureLost = rt.hasPressure && rt.pressureViolated;
    const lost = buttonLost || pressureLost;
    if (lost && !rt.isShocking) { startShockSeq(); resetTd01(); }
    else if (!lost && rt.isShocking) { stopShockSeq(); rt.lastNoShockTs = Date.now(); }
    render();
  }
  function onButtonsChanged() {
    view.button0Pressed = rt.button0Pressed; view.button1Pressed = rt.button1Pressed;
    applyTiptoeState();
  }
  // 压力线：压力大=踩住=违规；持续超阈值达防抖时长才判违规，避免抖动误触
  function evalPressure(p) {
    rt.pressure1 = p;
    view.pressure1 = Number.isFinite(p) ? Number(p.toFixed(1)) : '-';
    const over = p > (Number(cfg.tiptoePressureThreshold) || 0);
    const now = Date.now();
    if (over) {
      if (!rt.pressureViolatedSince) rt.pressureViolatedSince = now;
      if (!rt.pressureViolated && (now - rt.pressureViolatedSince) >= (Number(cfg.tiptoeDebounceMs) || 0)) {
        rt.pressureViolated = true;
      }
    } else if (rt.pressureViolated || rt.pressureViolatedSince) {
      rt.pressureViolated = false;
      rt.pressureViolatedSince = 0;
    }
    view.pressureViolated = rt.pressureViolated;
    applyTiptoeState();
  }
  function forceStart() {
    if (rt.isActive) return;
    rt.waitingForManualStart = false; rt.isActive = true;
    rt.startTime = Date.now(); rt.lastNoShockTs = Date.now();
    setLock(false);
    view.statusText = t('运行中'); view.running = true;
    render();
  }
  function loop() {
    if (rt.waitingForManualStart) return;
    if (!rt.isActive) return;
    if (rt.paused) return;
    if (rt.hasPressure && rt.pressureViolatedSince && !rt.pressureViolated) {
      evalPressure(rt.pressure1);
    }
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
    view.statusText = rt.waitingForManualStart ? t('等待手动开启') : t('运行中');
    addLog('info', '女仆惩罚启动');
    // 监听 QTZ 按钮（button0/button1 属性）
    DeviceAPI.device(QTZ).onProperty('button0', (nv) => { rt.button0Pressed = (Number(nv) === 1); onButtonsChanged(); });
    DeviceAPI.device(QTZ).onProperty('button1', (nv) => { rt.button1Pressed = (Number(nv) === 1); onButtonsChanged(); });
    // 监听踮脚压力（pressure1）——压力大于阈值视为踩住（违规）
    rt.hasPressure = DeviceAPI.device(TIPTOE).isMapped();
    view.hasPressure = rt.hasPressure;
    if (rt.hasPressure) {
      const tiptoeDevice = DeviceAPI.device(TIPTOE);
      try { tiptoeDevice.invoke('reporting', 'setReportDelay', { ms: 100 }); } catch (_) {}
      tiptoeDevice.onValue('tiptoePressure', (nv) => { evalPressure(Number(nv) || 0); });
      tiptoeDevice.readValue('tiptoePressure').then((values) => {
        if (!rt.isActive && !rt.waitingForManualStart) return;
        const current = Array.isArray(values) ? values.find((value) => value !== null && value !== undefined) : values;
        if (current !== null && current !== undefined) evalPressure(Number(current) || 0);
      }).catch((error) => addLog('warn', `读取当前踮脚压力失败: ${error && error.message || error}`));
      addLog('info', `踮脚压力监测已启用（阈值 ${cfg.tiptoePressureThreshold}，防抖 ${cfg.tiptoeDebounceMs}ms）`);
    }
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
    if (rt.hasPressure) { try { DeviceAPI.device(TIPTOE).invoke('reporting', 'setReportDelay', { ms: 5000 }); } catch (_) {} }
    rt.pressureViolated = false; rt.pressureViolatedSince = 0;
    rt.isActive = false;
    view.running = false; view.statusText = t('已结束');
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
          view.statusText = rt.paused ? t('已暂停') : t('运行中');
          view.btnText = rt.paused ? t('继续') : t('暂停');
          if (rt.paused) { stopShockSeq(); stopTd01(); }
          addLog('info', rt.paused ? '已暂停' : '已继续');
          render();
          if (!rt.paused) applyTiptoeState(); // 恢复后按当前传感器状态重新评估
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
  // ---- 托管渲染模式（?runtime=host|remote）：逻辑在宿主 Core 执行，本页面只渲染快照、发送命令 ----
  // 设备事件由宿主侧（本机后端 / 被控端后端）直接喂给 core，页面不再监听设备。
  const hostBridge = (typeof window !== 'undefined' && window.GameRuntimeBridge) ? window.GameRuntimeBridge : null;
  const hostUi = { authorized: hostBridge ? hostBridge.mode === 'host' : true, startedAtMs: -1, lastLogKey: '' };

  function hostSyncParams(params) {
    if (!params) return;
    Object.keys(cfg).forEach((k) => { if (params[k] !== undefined && params[k] !== null) cfg[k] = params[k]; });
  }

  function hostSetControlsEnabled(enabled) {
    $('[data-action]').forEach((el) => { el.disabled = !enabled; });
  }

  function hostBindActions() {
    $('[data-action]').forEach((el) => {
      const name = el.getAttribute('data-action');
      el.addEventListener('click', () => {
        if (!hostUi.authorized) return;
        if (name === 'pause') hostBridge.sendAction(rt.paused ? 'resume' : 'pause').catch(() => {});
        else hostBridge.sendAction(name).catch(() => {});
      });
    });
  }

  function hostRenderLogs(logs) {
    const ul = document.getElementById('logs');
    if (!ul || !Array.isArray(logs)) return;
    const key = logs.length + ':' + (logs[0] ? String(logs[0].atMs || '') + logs[0].message : '');
    if (key === hostUi.lastLogKey) return;
    hostUi.lastLogKey = key;
    ul.innerHTML = '';
    logs.slice(0, 10).forEach((entry) => {
      const li = document.createElement('li');
      const at = Number(entry && entry.atMs) || 0;
      li.textContent = (at ? '[' + new Date(at).toLocaleTimeString() + '] ' : '') + String((entry && entry.level) || 'info') + ' — ' + String((entry && entry.message) || '');
      ul.appendChild(li);
    });
  }

  function hostOnSnapshot(status, snapshot) {
    if (!snapshot) { view.statusText = t('连接中断，正在重连'); render(); return; }
    if (hostBridge.mode === 'remote') {
      const authorized = !status || status.authorized !== false;
      if (authorized !== hostUi.authorized) { hostUi.authorized = authorized; hostSetControlsEnabled(authorized); }
    }
    const startedAtMs = Number(snapshot.startedAtMs) || 0;
    if (startedAtMs !== hostUi.startedAtMs) { hostUi.startedAtMs = startedAtMs; hostUi.lastLogKey = ''; }
    hostSyncParams(snapshot.params);
    rt.paused = !!snapshot.paused;
    rt.isShocking = !!snapshot.isShocking;
    rt.shockCount = Number(snapshot.shockCount) || 0;
    rt.td01Active = !!snapshot.td01Active;
    rt.td01Intensity = Number(snapshot.td01Intensity) || 0;
    rt.pressureViolated = !!snapshot.pressureViolated;
    rt.isLocked = !!snapshot.isLocked;
    view.running = !!snapshot.running;
    view.startTime = startedAtMs;
    view.isLocked = !!snapshot.isLocked;
    view.lockedText = snapshot.lockedText || '';
    view.statusText = snapshot.statusText || '-';
    view.btnText = rt.paused ? t('继续') : t('暂停');
    view.remainingSec = snapshot.remainingSec == null ? '-' : Number(snapshot.remainingSec);
    view.button0Pressed = !!snapshot.button0Pressed;
    view.button1Pressed = !!snapshot.button1Pressed;
    view.isShocking = rt.isShocking;
    view.shockCount = rt.shockCount;
    view.td01Active = rt.td01Active;
    view.td01Intensity = rt.td01Intensity;
    view.hasPressure = !!snapshot.hasPressure;
    view.pressure1 = snapshot.pressure1 == null ? '-' : Number(snapshot.pressure1);
    view.pressureViolated = rt.pressureViolated;
    hostRenderLogs(snapshot.logs);
    render();
  }

  function hostBoot() {
    hostBindActions();
    if (typeof GameI18n !== 'undefined' && GameI18n.apply) GameI18n.apply();
    if (hostBridge.mode === 'remote') hostSetControlsEnabled(false);
    render();
    hostBridge.onSnapshot(hostOnSnapshot);
    hostBridge.start();
  }

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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => (hostBridge ? hostBoot() : boot()));
  else (hostBridge ? hostBoot() : boot());
})();
