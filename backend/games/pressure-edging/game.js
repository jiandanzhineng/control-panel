// 气压寸止玩法 — 页面自驱动逻辑（新架构：DeviceAPI Bridge）
// 业务逻辑对齐老版 pressureEdgingEmbedded.js，UI 完全一致，仅后台接入改为 DeviceAPI。
(function () {
  'use strict';
  function L() { return (typeof GameI18n !== 'undefined' && GameI18n.t) ? GameI18n.t : function (zh) { return zh; }; }
  function t(zh, vars) { return L()(zh, vars); }

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
    // 语音边缘检测：mid 区间是水平触发，用 _inMidBand 记录是否已在区间内，只在跨入时播报一次
    _inMidBand: false,
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
    statusText: t('准备就绪'),
    btnText: t('暂停'),
    currentPressure: 0,
    averagePressure: 0,
    currentIntensity: 0,
    targetIntensity: 0,
    edgingCount: 0,
    totalStimulationTime: 0,
  };

  const $ = (sel) => Array.from(document.querySelectorAll(sel));
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // 语音播放器后续会迁移到 GameCommon；本轮在游戏内保持相同的调度契约。
  function createVoicePlayer(basePath) {
    var enabled = true;
    var current = null;
    var queuedState = null;
    var pendingGesture = null;
    var gestureHandler = null;

    function isValid(event) {
      if (!event || typeof event.isValid !== 'function') return true;
      try { return !!event.isValid(); } catch (_) { return false; }
    }
    function logFailure(event, error) {
      var detail = error && error.message ? ': ' + error.message : '';
      try { DeviceAPI.log('warn', '语音播放失败 ' + event.key + ' (' + event.url + ')' + detail); } catch (_) {}
    }
    function unbindGesture() {
      if (!gestureHandler) return;
      document.removeEventListener('pointerdown', gestureHandler);
      document.removeEventListener('keydown', gestureHandler);
      gestureHandler = null;
    }
    function stopEntry(entry) {
      if (!entry) return;
      entry.audio.removeEventListener('ended', entry.onEnded);
      entry.audio.removeEventListener('error', entry.onError);
      try { entry.audio.pause(); entry.audio.currentTime = 0; } catch (_) {}
    }
    function playQueuedState() {
      var event = queuedState;
      queuedState = null;
      if (event && isValid(event)) startEvent(event);
    }
    function finishEntry(entry, failed) {
      if (current !== entry) return;
      entry.audio.removeEventListener('ended', entry.onEnded);
      entry.audio.removeEventListener('error', entry.onError);
      current = null;
      if (failed) logFailure(entry.event);
      playQueuedState();
    }
    function bindGesture() {
      if (gestureHandler) return;
      gestureHandler = function () {
        var event = pendingGesture;
        pendingGesture = null;
        unbindGesture();
        if (event && isValid(event)) startEvent(event);
        else playQueuedState();
      };
      document.addEventListener('pointerdown', gestureHandler);
      document.addEventListener('keydown', gestureHandler);
    }
    function handlePlayRejection(event, entry, error) {
      if (current !== entry) return;
      stopEntry(entry);
      current = null;
      logFailure(event, error);
      if (error && error.name === 'NotAllowedError') {
        pendingGesture = event.kind !== 'critical' && queuedState && isValid(queuedState) ? queuedState : event;
        queuedState = null;
        bindGesture();
      } else {
        playQueuedState();
      }
    }
    function startEvent(event) {
      if (!enabled || !isValid(event)) return false;
      try {
        var audio = new Audio(event.url);
        var entry = { audio: audio, event: event };
        entry.onEnded = function () { finishEntry(entry, false); };
        entry.onError = function () { finishEntry(entry, true); };
        audio.volume = 1.0;
        audio.addEventListener('ended', entry.onEnded);
        audio.addEventListener('error', entry.onError);
        current = entry;
        var result = audio.play();
        if (result && typeof result.catch === 'function') {
          result.catch(function (error) { handlePlayRejection(event, entry, error); });
        }
        return true;
      } catch (error) {
        if (entry && current === entry) {
          stopEntry(entry);
          current = null;
        }
        logFailure(event, error);
        playQueuedState();
        return false;
      }
    }
    function play(key, options) {
      if (!enabled || !key) return false;
      var opts = options || {};
      var event = {
        key: key,
        kind: opts.kind || 'info',
        isValid: opts.isValid,
        url: basePath + '/' + key + '.mp3',
      };
      if (pendingGesture && !isValid(pendingGesture)) {
        pendingGesture = null;
        unbindGesture();
      }
      if (pendingGesture) {
        if (event.kind === 'critical') {
          pendingGesture = null;
          queuedState = null;
          unbindGesture();
        } else {
          if (event.kind === 'state' && pendingGesture.kind !== 'critical') {
            pendingGesture = event;
            queuedState = null;
          }
          return false;
        }
      }
      if (!current) return startEvent(event);
      if (current.event.key === key) return false;
      if (event.kind === 'critical') {
        queuedState = null;
        stopEntry(current);
        current = null;
        return startEvent(event);
      }
      if (event.kind === 'state') {
        if (current.event.kind === 'intro' || current.event.kind === 'critical') {
          queuedState = event;
          return false;
        }
        stopEntry(current);
        current = null;
        return startEvent(event);
      }
      return false;
    }
    function stop() {
      if (current) stopEntry(current);
      current = null;
      queuedState = null;
      pendingGesture = null;
      unbindGesture();
    }
    function setEnabled(nextEnabled) {
      enabled = !!nextEnabled;
      if (!enabled) stop();
    }
    return { play: play, stop: stop, setEnabled: setEnabled };
  }
  var voicePlayer = createVoicePlayer('voices');
  function playVoice(key, kind, isValid) {
    return voicePlayer.play(key, { kind: kind, isValid: isValid });
  }

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
    // 进入 mid 区间（临界值 * 0.85 ~ 临界值）时播 mid 语音，每次跨入都播
    var midThreshold = cfg.criticalPressure * 0.85;
    var inMidBand = pressure > midThreshold && pressure < cfg.criticalPressure;
    var enteredMidBand = inMidBand && !rt._inMidBand;
    rt._inMidBand = inMidBand;
    if (enteredMidBand) playVoice('edging_middle', 'state', function () { return rt.running && rt._inMidBand; });
    if (pressure >= cfg.criticalPressure) {
      // 超压：停止刺激并触发电击；一次连续超压只计一次寸止
      if (!rt.wasOverPressure) {
        rt.edgingCount += 1;
        view.edgingCount = rt.edgingCount;
        playVoice('edging_peak', 'critical', function () { return rt.running && rt.currentPressure >= cfg.criticalPressure; });
      }
      rt.wasOverPressure = true;
      rt.targetIntensity = 0;
      rt.isInDelayPeriod = false;
      rt.baseIntensity = 0;
      rt.intensityIncreaseStartTime = 0;
      triggerShock(false);
    } else {
      var recoveredFromOverPressure = rt.wasOverPressure;
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
        view.statusText = t('延迟期中({n}s)…').replace('{n}', cfg.lowPressureDelay);
        if (recoveredFromOverPressure) {
          playVoice('edging_delay', 'state', function () { return rt.running && rt.isInDelayPeriod && rt.currentPressure < cfg.criticalPressure; });
        }
      } else {
        const delayElapsed = (now - rt.delayStartTime) / 1000;
        if (delayElapsed >= cfg.lowPressureDelay) {
          const baseTarget = normalizedDiff * cfg.maxMotorIntensity * cfg.sensitivity;
          if (rt.intensityIncreaseStartTime === 0) {
            rt.baseIntensity = baseTarget;
            rt.intensityIncreaseStartTime = now;
            addLog('info', `延迟结束，基础强度: ${baseTarget.toFixed(1)}，开始逐步提升`);
            view.statusText = t('强度逐步提升中…');
            playVoice('edging_calm', 'state', function () { return rt.running && rt.isInDelayPeriod && rt.intensityIncreaseStartTime !== 0; });
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
    voicePlayer.stop();
    rt.running = true;
    rt.paused = false;
    rt.startTime = now;
    rt.endTime = now + cfg.duration * 60 * 1000;
    rt.lastUpdateTs = now;
    rt.edgingCount = 0;
    rt.wasOverPressure = false;
    rt._inMidBand = false;
    view.edgingCount = 0;
    view.running = true;
    view.startTime = now;
    view.statusText = t('准备就绪');

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
    playVoice('edging_start', 'intro', function () { return rt.running; });
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
    view.statusText = t('已结束');
    view.btnText = t('暂停');
    addLog('info', `气压寸止玩法结束（寸止 ${rt.edgingCount} 次）`);
    playVoice('edging_end', 'critical', function () { return !rt.running; });
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
          view.statusText = rt.paused ? t('已暂停') : t('运行中');
          view.btnText = rt.paused ? t('继续') : t('暂停');
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
    if (typeof GameI18n !== 'undefined' && GameI18n.apply) GameI18n.apply();
    render();
    try {
      await DeviceAPI.ready;
    } catch (_) {}
    // 合并启动参数
    const p = DeviceAPI.params || {};
    Object.keys(cfg).forEach((k) => { if (p[k] !== undefined && p[k] !== null) cfg[k] = p[k]; });
    voicePlayer.setEnabled(p.voiceEnabled === undefined ? true : !!p.voiceEnabled);
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
