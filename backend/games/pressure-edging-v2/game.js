// 气压寸止3阶段升级版 — 页面自驱动（DeviceAPI），逻辑/UI 对齐老版 寸止游戏2.js
(function () {
  'use strict';
  const SENSOR = 'sensor', MOTOR = 'motor', PUNISH = 'punish', LOCK = 'lock';
  const S = { INITIAL_CALM: 'INITIAL_CALM', MIDDLE: 'MIDDLE', EDGING: 'EDGING', DELAY: 'DELAY', SUB_CALM: 'SUB_CALM' };
  const STATE_CN = {
    INITIAL_CALM: '平静期', MIDDLE: '中期刺激', EDGING: '边缘寸止',
    DELAY: '冷却延迟', SUB_CALM: '平静期',
  };

  const cfg = {
    duration: 20, endCalmLock: 60, criticalPressure: 20, midPressure: 19.2,
    maxMotorIntensity: 255, lowPressureDelay: 5, rampRate: 2, sensitivity: 15,
    randomPercent: 0, gradualIncrease: 2, shockVoltage: 20, shockDuration: 3,
  };
  const rt = {
    running: false, paused: false, startTime: 0, endTime: 0,
    state: S.INITIAL_CALM, stateTimer: 0, recordedMidIntensity: 0, endCalmLocked: false,
    currentPressure: 0, averagePressure: 0, pressureHistory: [],
    unRandomIntensity: 0, targetIntensity: 0, currentIntensity: 0, midIntensity: 0,
    lastUpdateTs: 0, lastIntensityUpdateTs: 0,
    isShocking: false, shockCount: 0, shockTimer: null,
    edgingCount: 0, totalStimulationTime: 0,
  };
  const view = {
    title: '气压寸止3阶段升级版', startTime: 0, statusText: '准备就绪', btnText: '暂停',
    currentPressure: 0, averagePressure: 0, currentIntensity: 0, targetIntensity: 0,
    midPressure: 19.2, criticalPressure: 20, edgingCount: 0, shockCount: 0, totalStimulationTime: 0,
  };
  let chartXMin = 17;
  let chartXMax = 24;
  let chartYMax = 10;
  let chartDrag = null;

  const $ = (s) => Array.from(document.querySelectorAll(s));
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function render() {
    $('[data-bind]').forEach((el) => {
      const k = el.getAttribute('data-bind');
      let v = (k in view) ? view[k] : el.textContent;
      if (k === 'startTime') { const n = Number(v); v = (!Number.isNaN(n) && n > 0) ? new Date(n).toLocaleString() : '-'; }
      if (typeof v === 'number') v = (Math.abs(v) >= 100 || Number.isInteger(v)) ? Math.round(v) : v.toFixed(1);
      el.textContent = (v === undefined || v === null) ? '' : String(v);
    });
    const c = Number(cfg.criticalPressure) || 20;
    const m = Number(cfg.maxMotorIntensity) || 255;
    const pBar = document.getElementById('pBar');
    const iBar = document.getElementById('iBar');
    if (pBar) pBar.style.width = (clamp((Number(view.currentPressure) || 0) / c, 0, 1) * 100).toFixed(1) + '%';
    if (iBar) iBar.style.width = (clamp((Number(view.currentIntensity) || 0) / m, 0, 1) * 100).toFixed(1) + '%';
    drawChart();
  }
  function drawChart() {
    const cv = document.getElementById('chart');
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || 560;
    const cssH = cv.clientHeight || 200;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const pad = 20;
    const gw = cssW - pad * 2;
    const gh = cssH - pad * 2;
    const cp = Number(rt.currentPressure) || 0;
    const ci = Number(rt.currentIntensity) || 0;
    const crit = Number(cfg.criticalPressure) || 20;
    const mid = Number(cfg.midPressure) || (crit * 0.9);
    const midI = Number(rt.midIntensity || rt.recordedMidIntensity || 0);

    chartXMax = Math.max(chartXMax, crit + 2);
    chartXMin = Math.min(chartXMin, mid - 2);
    if (chartYMax < ci + 10) chartYMax = ci + 10;
    if (chartYMax < midI + 10) chartYMax = midI + 10;

    const xOf = (p) => pad + gw * ((p - chartXMin) / Math.max(1e-6, chartXMax - chartXMin));
    const yOf = (i) => pad + gh * (1 - i / Math.max(1e-6, chartYMax));

    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(pad, pad + gh);
    ctx.lineTo(pad + gw, pad + gh);
    ctx.moveTo(pad, pad);
    ctx.lineTo(pad, pad + gh);
    ctx.stroke();

    const xM = xOf(mid);
    const xC = xOf(crit);
    const yM = yOf(midI);
    const y0 = pad + gh;

    ctx.fillStyle = 'rgba(59,130,246,0.1)';
    ctx.beginPath();
    ctx.moveTo(xM, y0);
    ctx.lineTo(xC, y0);
    ctx.lineTo(xM, yM);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xM, y0);
    ctx.lineTo(xM, yM);
    ctx.lineTo(xC, y0);
    ctx.stroke();

    const dot = (x, y, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    };
    dot(xM, y0, '#3b82f6');
    dot(xC, y0, '#f97316');
    dot(xOf(cp), yOf(ci), '#22c55e');

    ctx.fillStyle = '#64748b';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(chartXMin.toFixed(0), pad, cssH - 5);
    ctx.fillText(chartXMax.toFixed(0), cssW - 20, cssH - 5);
    ctx.textAlign = 'right';
    ctx.fillText(chartYMax.toFixed(0), pad - 4, pad + 8);
    ctx.fillText('0', pad - 4, pad + gh);
    ctx.textAlign = 'left';
  }
  function addLog(level, message) {
    const li = document.createElement('li');
    li.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
    const ul = document.getElementById('logs');
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 20) ul.removeChild(ul.lastChild);
    try { DeviceAPI.log(level, message); } catch (_) {}
  }

  function setStrength(v) { if (DeviceAPI.device(MOTOR).isMapped()) DeviceAPI.device(MOTOR).invoke('strength', 'set', { value: Math.round(v) }); }
  function startShock(voltage) { if (DeviceAPI.device(PUNISH).isMapped()) DeviceAPI.device(PUNISH).invoke('shock', 'start', { voltage }); }
  function stopShockDev() { if (DeviceAPI.device(PUNISH).isMapped()) DeviceAPI.device(PUNISH).invoke('shock', 'stop', {}); }
  function setLockOpen(open) { if (DeviceAPI.device(LOCK).isMapped()) DeviceAPI.device(LOCK).invoke('lock', 'setOpen', { open: !!open }); }

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

  function normalizeThresholds() {
    const crit = Number(cfg.criticalPressure) || 20;
    cfg.midPressure = Number((clamp(Number(cfg.midPressure) || 0, chartXMin, crit - 0.1)).toFixed(1));
    cfg.criticalPressure = Number((Math.max(cfg.midPressure + 0.1, crit)).toFixed(1));
    view.midPressure = cfg.midPressure;
    view.criticalPressure = cfg.criticalPressure;
  }

  function adjustThreshold(which, delta) {
    const c = Number(cfg.criticalPressure) || 20;
    const m = Number(cfg.midPressure) || (c * 0.9);
    if (which === 'mid') {
      cfg.midPressure = Math.max(0, Math.min(c - 0.1, m + delta));
    } else if (which === 'crit') {
      cfg.criticalPressure = Math.max(m + 0.1, c + delta);
    }
    normalizeThresholds();
  }

  function pointClientX(evt) {
    if (evt.touches && evt.touches[0]) return evt.touches[0].clientX;
    if (evt.changedTouches && evt.changedTouches[0]) return evt.changedTouches[0].clientX;
    return evt.clientX;
  }

  function pressureFromClientX(clientX) {
    const cv = document.getElementById('chart');
    const rect = cv.getBoundingClientRect();
    return chartXMin + ((clientX - rect.left) / Math.max(1, rect.width)) * (chartXMax - chartXMin);
  }

  function startChartDrag(evt) {
    const cv = document.getElementById('chart');
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const x = pointClientX(evt) - rect.left;
    const xM = ((Number(cfg.midPressure) - chartXMin) / Math.max(1e-6, chartXMax - chartXMin)) * rect.width;
    const xC = ((Number(cfg.criticalPressure) - chartXMin) / Math.max(1e-6, chartXMax - chartXMin)) * rect.width;
    chartDrag = Math.abs(x - xM) < Math.abs(x - xC) ? 'mid' : 'crit';
    evt.preventDefault();
  }

  function moveChartDrag(evt) {
    if (!chartDrag) return;
    const p = pressureFromClientX(pointClientX(evt));
    const c = Number(cfg.criticalPressure) || 20;
    const m = Number(cfg.midPressure) || (c * 0.9);
    if (chartDrag === 'mid') cfg.midPressure = Math.max(chartXMin, Math.min(c - 0.1, p));
    else cfg.criticalPressure = Math.max(m + 0.1, p);
    normalizeThresholds();
    render();
    evt.preventDefault();
  }

  function endChartDrag() {
    if (!chartDrag) return;
    normalizeThresholds();
    addLog('info', `更新阈值 中间=${cfg.midPressure.toFixed(1)} 临界=${cfg.criticalPressure.toFixed(1)}`);
    chartDrag = null;
    render();
  }

  function triggerShock(force) {
    if (!force && rt.isShocking) return;
    try {
      rt.isShocking = true; rt.shockCount += 1; view.shockCount = rt.shockCount;
      addLog('warn', `触发电击 ${cfg.shockVoltage}V / ${cfg.shockDuration}s`);
      startShock(cfg.shockVoltage);
      if (rt.shockTimer) clearTimeout(rt.shockTimer);
      rt.shockTimer = setTimeout(() => { stopShockDev(); rt.isShocking = false; addLog('info', '电击结束'); }, Math.max(100, cfg.shockDuration * 1000));
    } catch (_) { rt.isShocking = false; }
  }
  function calculateStateLogic() {
    const now = Date.now();
    const dtSec = Math.max(0, (now - rt.lastUpdateTs) / 1000);
    rt.lastUpdateTs = now;
    const pressure = rt.currentPressure;
    const remainMs = rt.endTime - now;
    const takeoffMs = Math.max(0, (Number(cfg.endCalmLock) || 0) * 1000);
    const inTakeoff = takeoffMs > 0 && remainMs <= takeoffMs;
    if (inTakeoff) {
      if (rt.state !== S.SUB_CALM) rt.state = S.SUB_CALM;
      if (!rt.endCalmLocked) {
        rt.endCalmLocked = true;
        view.statusText = '进入结束前起飞期';
        playVoice('edging_takeoff', 'state', function () { return rt.running && rt.endCalmLocked; });
      }
    } else if (rt.endCalmLocked) rt.endCalmLocked = false;

    switch (rt.state) {
      case S.INITIAL_CALM:
      case S.SUB_CALM: {
        rt.unRandomIntensity += dtSec * (cfg.gradualIncrease || 0);
        const rnd = 1 + (Math.random() - 0.5) * 2 * ((cfg.randomPercent || 0) / 100);
        rt.targetIntensity = clamp(rt.unRandomIntensity * rnd, 0, cfg.maxMotorIntensity);
        if ((rt.state === S.INITIAL_CALM || !inTakeoff) && pressure > cfg.midPressure) {
          rt.recordedMidIntensity = rt.currentIntensity;
          if (rt.recordedMidIntensity < 1) rt.recordedMidIntensity = rt.targetIntensity;
          if (rt.recordedMidIntensity < 1) rt.recordedMidIntensity = cfg.maxMotorIntensity * 0.5;
          rt.state = S.MIDDLE;
          view.statusText = '进入中期刺激';
          addLog('info', `进入中期，基准强度 ${rt.recordedMidIntensity.toFixed(1)}`);
          playVoice('edging_middle', 'state', function () { return rt.running && rt.state === S.MIDDLE; });
        }
        break;
      }
      case S.MIDDLE: {
        rt.midIntensity = rt.recordedMidIntensity;
        const denom = Math.max(0.01, cfg.criticalPressure - cfg.midPressure);
        const factor = (cfg.criticalPressure - pressure) / denom;
        rt.targetIntensity = clamp(rt.recordedMidIntensity * Math.max(0, factor), 0, cfg.maxMotorIntensity);
        if (pressure >= cfg.criticalPressure) {
          rt.state = S.EDGING; triggerShock(false); rt.edgingCount++;
          view.edgingCount = rt.edgingCount; view.statusText = '过载！边缘寸止中…';
          playVoice('edging_peak', 'critical', function () { return rt.running && rt.state === S.EDGING; });
        } else if (pressure < cfg.midPressure) {
          rt.unRandomIntensity = rt.currentIntensity; rt.state = S.SUB_CALM;
          view.statusText = '压力回落，进入平静期';
          playVoice('edging_calm', 'state', function () { return rt.running && rt.state === S.SUB_CALM; });
        }
        break;
      }
      case S.EDGING: {
        rt.targetIntensity = 0;
        if (pressure < cfg.criticalPressure) {
          rt.state = S.DELAY;
          rt.stateTimer = now;
          view.statusText = `冷却延迟(${cfg.lowPressureDelay}s)…`;
          playVoice('edging_delay', 'state', function () { return rt.running && rt.state === S.DELAY; });
        }
        break;
      }
      case S.DELAY: {
        rt.targetIntensity = 0;
        if (pressure >= cfg.criticalPressure) {
          rt.state = S.EDGING;
          view.statusText = '过载！边缘寸止中…';
          playVoice('edging_peak', 'critical', function () { return rt.running && rt.state === S.EDGING; });
        }
        else if (now - rt.stateTimer > cfg.lowPressureDelay * 1000) {
          if (pressure > cfg.midPressure) {
            rt.state = S.MIDDLE;
            view.statusText = '延迟结束，高压保持';
            playVoice('edging_middle', 'state', function () { return rt.running && rt.state === S.MIDDLE; });
          }
          else {
            const denom = Math.max(1e-6, cfg.criticalPressure - cfg.sensitivity);
            rt.unRandomIntensity = Math.max(0, cfg.maxMotorIntensity * (cfg.criticalPressure - pressure) / denom);
            rt.state = S.SUB_CALM; view.statusText = '延迟结束，重新积累';
            playVoice('edging_calm', 'state', function () { return rt.running && rt.state === S.SUB_CALM; });
          }
        }
        break;
      }
    }
  }
  function updateIntensity() {
    const now = Date.now();
    if (!rt.lastIntensityUpdateTs) rt.lastIntensityUpdateTs = now;
    const dtSec = Math.max(0, (now - rt.lastIntensityUpdateTs) / 1000);
    rt.lastIntensityUpdateTs = now;
    const cur = rt.currentIntensity, tgt = rt.targetIntensity;
    let next = tgt < cur ? tgt : Math.min(cur + Math.max(0, cfg.rampRate) * dtSec, tgt);
    const rounded = Math.round(next);
    if (rounded !== Math.round(cur)) {
      if (!Number.isNaN(rounded)) { setStrength(rounded); rt.currentIntensity = rounded; if (rounded > 0) rt.totalStimulationTime += dtSec; }
    } else rt.currentIntensity = next;
    view.currentIntensity = rt.currentIntensity;
    view.targetIntensity = rt.targetIntensity;
    view.totalStimulationTime = Number(rt.totalStimulationTime.toFixed(1));
  }
  function loop() {
    if (!rt.running) return;
    if (rt.paused) return;
    const now = Date.now();
    if (now >= rt.endTime) { end(); return; }
    calculateStateLogic();
    updateIntensity();
    view.currentPressure = rt.currentPressure;
    view.averagePressure = Number(rt.averagePressure.toFixed(1));
    view.midPressure = cfg.midPressure;
    view.criticalPressure = cfg.criticalPressure;
    render();
  }
  function start() {
    const now = Date.now();
    voicePlayer.stop();
    rt.running = true; rt.paused = false; rt.startTime = now;
    rt.endTime = now + cfg.duration * 60 * 1000;
    rt.state = S.INITIAL_CALM; rt.stateTimer = 0; rt.recordedMidIntensity = 0; rt.endCalmLocked = false;
    rt.unRandomIntensity = 0; rt.targetIntensity = 0; rt.currentIntensity = 0;
    rt.midIntensity = 0.5 * cfg.maxMotorIntensity; rt.lastUpdateTs = now; rt.lastIntensityUpdateTs = now;
    rt.edgingCount = 0; rt.totalStimulationTime = 0;
    view.startTime = now; view.statusText = '准备就绪';
    view.midPressure = cfg.midPressure; view.criticalPressure = cfg.criticalPressure;
    try {
      if (DeviceAPI.device(SENSOR).isMapped()) DeviceAPI.device(SENSOR).invoke('reporting', 'setReportDelay', { ms: 100 });
      setStrength(0); setLockOpen(false); stopShockDev();
    } catch (_) {}
    DeviceAPI.device(SENSOR).onProperty('pressure', (nv) => {
      const p = Number(nv) || 0;
      rt.currentPressure = p;
      rt.pressureHistory.push({ ts: Date.now(), pressure: p });
      const recent = rt.pressureHistory.slice(-60);
      rt.averagePressure = recent.length ? recent.reduce((a, it) => a + (Number(it.pressure) || 0), 0) / recent.length : p;
      // 高频即时响应
      calculateStateLogic(); updateIntensity();
      view.currentPressure = p; view.averagePressure = Number(rt.averagePressure.toFixed(1));
    });
    addLog('info', '气压寸止3阶段已启动');
    playVoice('edging_start', 'intro', function () { return rt.running; });
    render();
  }
  function end() {
    try { setStrength(0); } catch (_) {}
    try { stopShockDev(); } catch (_) {}
    try { setLockOpen(true); } catch (_) {}
    try { if (DeviceAPI.device(SENSOR).isMapped()) DeviceAPI.device(SENSOR).invoke('reporting', 'setReportDelay', { ms: 5000 }); } catch (_) {}
    rt.running = false; rt.paused = false;
    if (rt.shockTimer) { clearTimeout(rt.shockTimer); rt.shockTimer = null; }
    view.statusText = '已结束';
    addLog('info', `结束（边缘 ${rt.edgingCount}，电击 ${rt.shockCount}）`);
    playVoice('edging_end', 'critical', function () { return !rt.running; });
    render();
  }

  function bindActions() {
    $('[data-action]').forEach((el) => {
      const name = el.getAttribute('data-action');
      el.addEventListener('click', () => {
        if (name === 'pause') {
          rt.paused = !rt.paused;
          view.statusText = rt.paused ? '已暂停' : '运行中';
          view.btnText = rt.paused ? '继续' : '暂停';
          if (rt.paused) setStrength(0);
          addLog('info', rt.paused ? '已暂停' : '已继续');
          render();
        } else if (name === 'addIntensity') {
          rt.targetIntensity = clamp(rt.targetIntensity + 10, 0, cfg.maxMotorIntensity);
          addLog('info', `手动 +10 强度 → ${rt.targetIntensity.toFixed(1)}`);
          render();
        } else if (name === 'shockOnce') {
          triggerShock(true);
        }
      });
    });
    $('[data-adjust]').forEach((el) => {
      el.addEventListener('click', () => {
        const which = el.getAttribute('data-adjust');
        const val = Number(el.getAttribute('data-val')) || 0;
        adjustThreshold(which, val);
        render();
      });
    });
    const chart = document.getElementById('chart');
    if (chart) {
      chart.addEventListener('mousedown', startChartDrag);
      window.addEventListener('mousemove', moveChartDrag);
      window.addEventListener('mouseup', endChartDrag);
      chart.addEventListener('touchstart', startChartDrag, { passive: false });
      window.addEventListener('touchmove', moveChartDrag, { passive: false });
      window.addEventListener('touchend', endChartDrag);
      window.addEventListener('touchcancel', endChartDrag);
    }
  }
  let loopTimer = null;
  async function boot() {
    bindActions();
    render();
    try { await DeviceAPI.ready; } catch (_) {}
    const p = DeviceAPI.params || {};
    Object.keys(cfg).forEach((k) => { if (p[k] !== undefined && p[k] !== null) cfg[k] = p[k]; });
    voicePlayer.setEnabled(p.voiceEnabled === undefined ? true : !!p.voiceEnabled);
    addLog('info', '设备通道就绪，开始游戏');
    start();
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = setInterval(loop, 200);
  }

  window.__game = { start, loop, end, rt, cfg, view };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
