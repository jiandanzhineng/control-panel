// 气压突变寸止 — 页面自驱动（DeviceAPI）
// 参考 pressure-edging-v2 五态状态机，但取消绝对临界压：
//  - 边缘期由「双窗口比较」突变检测触发：本窗口[-τ,0]最大值 − 前一窗口[-2τ,-τ]平均值 ≥ surgeRiseKpa（默认1kPa）
//  - 中间压力自适应：初始 50kPa，每次进入边缘期更新为「本次触发峰值 − midOffsetKpa」
//  - 强度下发：平静期/中期每 sendIntervalMs（默认2000ms）发一次最新设计值；边缘期触发立即发停止命令（归零不受限速）；显示逻辑不变
(function () {
  'use strict';
  const SENSOR = 'sensor', MOTOR = 'motor', PUNISH = 'punish', LOCK = 'lock';
  const S = { INITIAL_CALM: 'INITIAL_CALM', MIDDLE: 'MIDDLE', EDGING: 'EDGING', DELAY: 'DELAY', SUB_CALM: 'SUB_CALM' };
  const STATE_CN = {
    INITIAL_CALM: '平静期', MIDDLE: '中期刺激', EDGING: '边缘寸止',
    DELAY: '冷却延迟', SUB_CALM: '平静期',
  };

  // 配置（来自 manifest 默认值，启动时被 DeviceAPI.params 覆盖）
  const cfg = {
    duration: 20, endCalmLock: 60, surgeWindowMs: 500, surgeRiseKpa: 1.0, midOffsetKpa: 1.0,
    maxMotorIntensity: 50, lowPressureDelay: 5, rampRate: 2, gradualIncrease: 2,
    randomPercent: 0, minSurgeMs: 100, sendIntervalMs: 2000,
    midIntensityMin: 5, midIntensityMax: 20, shockVoltage: 20, shockDuration: 3,
  };

  // 运行态
  const rt = {
    running: false, paused: false, startTime: 0, endTime: 0,
    state: S.INITIAL_CALM, stateTimer: 0, endCalmLocked: false,
    currentPressure: 0, averagePressure: 0, pressureHistory: [],
    // 突变检测（双窗口：本窗口[-τ,0]最大值 − 前一窗口[-2τ,-τ]平均值）
    windowSamples: [], rawOn: false, rawSince: 0, surgeActive: false,
    surgeReleased: false, delayMin: null, lastDelayMin: 0,
    edgePeak: 0, lastEdgePeak: 0, midPressure: 50,
    unRandomIntensity: 0, targetIntensity: 0, currentIntensity: 0,
    midLimits: { dmin: 5, dmax: 20 },
    lastSentStrength: 0, lastSendTs: 0,
    lastUpdateTs: 0, lastIntensityUpdateTs: 0,
    isShocking: false, shockCount: 0, shockTimer: null,
    edgingCount: 0, totalStimulationTime: 0,
  };

  // UI 合并状态
  const view = {
    title: '气压突变寸止', startTime: 0, statusText: '准备就绪', btnText: '暂停',
    currentPressure: 0, averagePressure: 0, currentIntensity: 0, targetIntensity: 0,
    midPressure: 50, edgePeak: 0, lastEdgePeak: 0,
    edgingCount: 0, shockCount: 0, totalStimulationTime: 0,
  };

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
    const m = Number(cfg.maxMotorIntensity) || 50;
    const pRef = Math.max(1, Number(rt.midPressure) || 1);
    const pBar = document.getElementById('pBar');
    const iBar = document.getElementById('iBar');
    if (pBar) pBar.style.width = (clamp((Number(view.currentPressure) || 0) / pRef, 0, 1) * 100).toFixed(1) + '%';
    if (iBar) iBar.style.width = (clamp((Number(view.currentIntensity) || 0) / m, 0, 1) * 100).toFixed(1) + '%';
    drawChart();
  }

  function addLog(level, message) {
    const li = document.createElement('li');
    li.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
    const ul = document.getElementById('logs');
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 20) ul.removeChild(ul.lastChild);
    try { DeviceAPI.log(level, message); } catch (_) {}
  }
// 语音播放器（与 v2 相同的调度契约：intro/critical/state 优先级 + 手势解锁兜底）
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

  // ---- 设备操作封装（DeviceAPI） ----
  function setStrength(v) { if (DeviceAPI.device(MOTOR).isMapped()) DeviceAPI.device(MOTOR).invoke('strength', 'set', { value: Math.round(v) }); }
  function startShock(voltage) { if (DeviceAPI.device(PUNISH).isMapped()) DeviceAPI.device(PUNISH).invoke('shock', 'start', { voltage: Math.round(voltage) }); }
  function stopShockDev() { if (DeviceAPI.device(PUNISH).isMapped()) DeviceAPI.device(PUNISH).invoke('shock', 'stop', {}); }
  function setLockOpen(open) { if (DeviceAPI.device(LOCK).isMapped()) DeviceAPI.device(LOCK).invoke('lock', 'setOpen', { open: !!open }); }

  // ---- 突变检测：双窗口比较，不用绝对临界压 ----
  //  W1 = [-τ, 0]（本窗口）取最大值，W2 = [-2τ, -τ]（前一窗口）取平均值；
  //  surgeActive = W1max − W2avg ≥ surgeRiseKpa，且连续保持 ≥ minSurgeMs 后触发（上升沿）；
  //  无滞回（不需要 releaseRatio）：条件消失即释放；进入 DELAY 后不再判定突变。
  function updateSurge(now, p) {
    const winMs = Math.max(50, Number(cfg.surgeWindowMs) || 500);
    rt.windowSamples.push({ ts: now, p: p });
    const cutoff = now - 2 * winMs;
    while (rt.windowSamples.length && rt.windowSamples[0].ts < cutoff) rt.windowSamples.shift();
    if (rt.state === S.DELAY) return; // 延迟期内不监测突变
    const t0 = now - winMs;
    let w1Max = -Infinity;
    let w2Sum = 0, w2Count = 0;
    for (const s of rt.windowSamples) {
      if (s.ts > t0) w1Max = Math.max(w1Max, s.p);
      else { w2Sum += s.p; w2Count += 1; }
    }
    if (w2Count === 0 || w1Max === -Infinity) { rt.rawOn = false; rt.surgeActive = false; rt.surgeReleased = false; return; }
    const w2Avg = w2Sum / w2Count;
    const rise = Math.max(0.1, Number(cfg.surgeRiseKpa) || 1.0);
    const on = (w1Max - w2Avg) >= rise;
    if (on) {
      if (!rt.rawOn) { rt.rawSince = now; rt.edgePeak = w1Max; } // 新一轮突变开始，重置峰值
      rt.rawOn = true;
      rt.edgePeak = Math.max(rt.edgePeak, w1Max);
      if (!rt.surgeActive && (now - rt.rawSince) >= (Number(cfg.minSurgeMs) || 100)) rt.surgeActive = true;
    } else {
      rt.rawOn = false;
      rt.surgeActive = false; // 无滞回：条件消失即释放
    }
    // 边缘期结束判据：气压回落到前一个窗口平均值 + 0.2kPa 之下
    rt.surgeReleased = (p < w2Avg + 0.2);
  }

  function triggerShock(force) {
    if (!force && rt.isShocking) return;
    try {
      rt.isShocking = true; rt.shockCount += 1; view.shockCount = rt.shockCount;
      addLog('warn', '突发电击 ' + cfg.shockVoltage + 'V / ' + cfg.shockDuration + 's');
      startShock(cfg.shockVoltage);
      if (rt.shockTimer) clearTimeout(rt.shockTimer);
      rt.shockTimer = setTimeout(() => { stopShockDev(); rt.isShocking = false; addLog('info', '电击结束'); }, Math.max(100, cfg.shockDuration * 1000));
    } catch (_) { rt.isShocking = false; }
  }

  function adjustMid(delta) {
    rt.midPressure = Math.max(1, Number((rt.midPressure + delta).toFixed(1)));
    view.midPressure = rt.midPressure;
    addLog('info', '手动微调中间压力 → ' + rt.midPressure.toFixed(1));
  }
  // 中期强度上下限：dmax 有效范围 [10, Dmax]，越界自动替换为 min(20, Dmax)；dmin 限 [0,10] 且 ≤ dmax
  function updateMidLimits() {
    const inputMax = Number(cfg.midIntensityMax);
    const Dmax = Math.max(1, Number(cfg.maxMotorIntensity) || 50);
    const dmax = (inputMax >= 10 && inputMax <= Dmax) ? inputMax : Math.min(20, Dmax);
    const dmin = Math.min(clamp(Number(cfg.midIntensityMin) || 5, 0, 10), dmax);
    return { dmin: dmin, dmax: dmax };
  }
// ---- 状态机 ----
  function enterMid() {
    rt.state = S.MIDDLE;
    view.statusText = '进入中期刺激';
    addLog('info', '进入中期刺激（P1=' + rt.midPressure.toFixed(1) + '，ΔP=' + cfg.midOffsetKpa + '）');
    playVoice('edging_middle', 'state', function () { return rt.running && rt.state === S.MIDDLE; });
  }
  function enterEdging() {
    rt.lastEdgePeak = Number(((rt.edgePeak > 0 ? rt.edgePeak : rt.currentPressure)).toFixed(1));
    // 中间值 = max(峰值 − 偏移, 上个延迟期最小值 + 1)；后者优先级更高
    const peakMid = rt.lastEdgePeak - (Number(cfg.midOffsetKpa) || 1.0);
    const delayFloor = (Number(rt.lastDelayMin) || 0) + 1;
    rt.midPressure = Number(Math.max(1, Math.max(peakMid, delayFloor)).toFixed(1));
    rt.edgePeak = 0; // 峰值已记录，重置等待下一轮突变
    rt.state = S.EDGING;
    rt.edgingCount += 1;
    view.edgingCount = rt.edgingCount;
    view.midPressure = rt.midPressure;
    view.lastEdgePeak = rt.lastEdgePeak;
    view.statusText = '突变！边缘寸止中…(#' + rt.edgingCount + ')';
    addLog('info', '进入边缘期 #' + rt.edgingCount + '，触发峰值 ' + rt.lastEdgePeak + '，中间压 → ' + rt.midPressure);
    playVoice('edging_peak', 'critical', function () { return rt.running && rt.state === S.EDGING; });
    triggerShock(false);
  }
  function calculateStateLogic() {
    if (!rt.running || rt.paused) return;
    const now = Date.now();
    const dtSec = Math.max(0, (now - rt.lastUpdateTs) / 1000);
    rt.lastUpdateTs = now;
    const p = rt.currentPressure;
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

    const surge = rt.surgeActive;
    switch (rt.state) {
      case S.INITIAL_CALM:
      case S.SUB_CALM: {
        rt.unRandomIntensity += dtSec * (Number(cfg.gradualIncrease) || 0);
        const rnd = 1 + (Math.random() - 0.5) * 2 * ((Number(cfg.randomPercent) || 0) / 100);
        rt.targetIntensity = clamp(rt.unRandomIntensity * rnd, 0, cfg.maxMotorIntensity);
        if (!inTakeoff && surge && rt.edgePeak) { rt.unRandomIntensity = rt.currentIntensity; enterEdging(); break; }
        if (!inTakeoff && p >= rt.midPressure) { rt.unRandomIntensity = rt.currentIntensity; enterMid(); break; }
        break;
      }
      case S.MIDDLE: {
        // 中期强度：P∈[P1,P1+ΔP] 时 d = dmax − (dmax−dmin)·(P−P1)/ΔP；P≥P1+ΔP 时 d = dmin
        const P1 = rt.midPressure;
        const dP = Math.max(0.01, Number(cfg.midOffsetKpa) || 1.0);
        const lim = rt.midLimits || { dmin: 5, dmax: 20 };
        let d;
        if (p >= P1 + dP) d = lim.dmin;
        else d = lim.dmax - (lim.dmax - lim.dmin) * ((p - P1) / dP);
        rt.targetIntensity = clamp(d, 0, cfg.maxMotorIntensity);
        if (surge && rt.edgePeak) { rt.unRandomIntensity = rt.currentIntensity; enterEdging(); break; }
        if (p < rt.midPressure) {
          rt.unRandomIntensity = rt.currentIntensity; rt.state = S.SUB_CALM;
          view.statusText = '压力回落，进入平静期';
          playVoice('edging_calm', 'state', function () { return rt.running && rt.state === S.SUB_CALM; });
        }
        break;
      }
      case S.EDGING: {
        rt.targetIntensity = 0;
        // 气压回落到前一个窗口平均值+0.2 之下才结束边缘期，进入延迟期
        if (rt.surgeReleased) {
          rt.delayMin = null; // 进入延迟期，重置最小值跟踪
          rt.state = S.DELAY; rt.stateTimer = now;
          view.statusText = '冷却延迟(' + cfg.lowPressureDelay + 's)…';
          playVoice('edging_delay', 'state', function () { return rt.running && rt.state === S.DELAY; });
        }
        break;
      }
      case S.DELAY: {
        rt.targetIntensity = 0;
        // 记录本次延迟期内的最小压力（用作下一次中间值的下限基准）
        rt.delayMin = (rt.delayMin == null) ? p : Math.min(rt.delayMin, p);
        // 延迟期内不监测突变：冷却结束后按压力与中间压决定回中期或平静
        if (now - rt.stateTimer > (Number(cfg.lowPressureDelay) || 0) * 1000) {
          rt.lastDelayMin = (rt.delayMin == null) ? p : rt.delayMin;
          if (p > rt.midPressure) {
            rt.unRandomIntensity = rt.currentIntensity; rt.state = S.MIDDLE;
            view.statusText = '冷却结束，高压保持';
            playVoice('edging_middle', 'state', function () { return rt.running && rt.state === S.MIDDLE; });
          } else {
            const denom = Math.max(1, rt.midPressure);
            rt.unRandomIntensity = Math.max(0, cfg.maxMotorIntensity * (rt.midPressure - p) / denom);
            rt.state = S.SUB_CALM; view.statusText = '冷却结束，重新积累';
            playVoice('edging_calm', 'state', function () { return rt.running && rt.state === S.SUB_CALM; });
          }
        }
        break;
      }
    }
  }

  function updateIntensity() {
    if (!rt.running || rt.paused) return;
    const now = Date.now();
    if (!rt.lastIntensityUpdateTs) rt.lastIntensityUpdateTs = now;
    const dtSec = Math.max(0, (now - rt.lastIntensityUpdateTs) / 1000);
    rt.lastIntensityUpdateTs = now;
    const cur = rt.currentIntensity, tgt = rt.targetIntensity;
    let next = tgt < cur ? tgt : Math.min(cur + Math.max(0, cfg.rampRate) * dtSec, tgt);
    const rounded = Math.round(next);
    // 限速合并（latest-wins）：平静期/中期每 sendIntervalMs（默认2000ms，0.5条/s）发一次
    // 当前最新设计值，速率远低于 MQTT 设备消费速率（≈1.8-2条/s），链路队列恒空、滞后不增长；
    // 边缘期触发时 target 归零 → emergencyZero 立即发送停止命令，保证安全。
    const interval = Math.max(200, Number(cfg.sendIntervalMs) || 2000);
    const due = (now - (rt.lastSendTs || 0)) >= interval;
    const emergencyZero = rounded === 0 && rt.lastSentStrength > 0;
    if (!Number.isNaN(rounded) && (due || emergencyZero)) {
      setStrength(rounded);
      rt.lastSentStrength = rounded;
      rt.lastSendTs = now;
      rt.currentIntensity = rounded;
      if (rounded > 0) rt.totalStimulationTime += dtSec;
    } else {
      rt.currentIntensity = next;
    }
    view.currentIntensity = rt.currentIntensity;
    view.targetIntensity = rt.targetIntensity;
    view.totalStimulationTime = Number(rt.totalStimulationTime.toFixed(1));
  }

  // 时间序列图：横轴最近 1 分钟，纵轴锁定 0~最大强度；压力(蓝实线)+电机强度(红虚线)+边缘标记
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
    const now = Date.now();
    const winMs = 60000;
    const hist = rt.pressureHistory.filter((it) => now - it.ts <= winMs);
    const pad = 20;
    const gw = cssW - pad * 2;
    const gh = cssH - pad * 2;
    if (hist.length < 2) {
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad, pad + gh); ctx.lineTo(pad + gw, pad + gh);
      ctx.moveTo(pad, pad); ctx.lineTo(pad, pad + gh);
      ctx.stroke();
      return;
    }
    // 纵轴锁定 0 ~ 最大强度（压力与电机强度共用同一刻度）
    const lo = 0;
    const hi = Math.max(1, Number(cfg.maxMotorIntensity) || 50);
    const t0 = hist[0].ts, t1 = hist[hist.length - 1].ts;
    const xOf = (it) => pad + ((it.ts - t0) / Math.max(1, t1 - t0)) * gw;
    const yOf = (pr) => pad + gh * (1 - clamp((pr - lo) / Math.max(1e-6, hi - lo), 0, 1));
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, pad + gh); ctx.lineTo(pad + gw, pad + gh);
    ctx.moveTo(pad, pad); ctx.lineTo(pad, pad + gh);
    ctx.stroke();
    // 中间压线仅在可视纵轴范围内绘制（初始 50 远超刻度时不显示）
    if (rt.midPressure >= lo && rt.midPressure <= hi) {
      ctx.strokeStyle = '#f97316';
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      const yMid = yOf(rt.midPressure);
      ctx.moveTo(pad, yMid); ctx.lineTo(pad + gw, yMid);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f97316';
      ctx.font = '10px sans-serif';
      ctx.fillText('中间 ' + Number(rt.midPressure).toFixed(1), pad + 4, Math.max(10, yMid - 4));
    }
    // 压力曲线（蓝实线）
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    hist.forEach((it, i) => {
      const x = xOf(it); const y = yOf(it.pressure);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // 电机强度曲线（红虚线）
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    let firstPoint = true;
    hist.forEach((it) => {
      const x = xOf(it); const y = yOf(it.strength);
      if (firstPoint) { ctx.moveTo(x, y); firstPoint = false; }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    // 边缘触发（绿点，标在峰值顶点）；边缘期激活区间（红点，反映释放条件生效）
    hist.forEach((it) => {
      const x = xOf(it); const y = yOf(it.pressure);
      if (it.edgeTrigger) {
        ctx.fillStyle = '#22c55e';
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      } else if (it.edgeActive) {
        ctx.fillStyle = '#ef4444';
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      }
    });
    ctx.fillStyle = '#64748b';
    ctx.font = '10px sans-serif';
    ctx.fillText(String(hi.toFixed(0)), pad - 4, pad + 8);
    ctx.fillText('0', pad - 4, pad + gh);
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
    view.midPressure = rt.midPressure;
    view.edgePeak = rt.edgePeak;
    view.lastEdgePeak = rt.lastEdgePeak;
    render();
  }
  function start() {
    const now = Date.now();
    voicePlayer.stop();
    rt.running = true; rt.paused = false; rt.startTime = now;
    rt.endTime = now + (Number(cfg.duration) || 20) * 60 * 1000;
    rt.state = S.INITIAL_CALM; rt.stateTimer = 0; rt.endCalmLocked = false;
    rt.unRandomIntensity = 0; rt.targetIntensity = 0; rt.currentIntensity = 0;
    rt.midLimits = updateMidLimits();
    rt.windowSamples = []; rt.rawOn = false; rt.rawSince = 0; rt.surgeActive = false;
    rt.surgeReleased = false; rt.delayMin = null; rt.lastDelayMin = 0;
    rt.edgePeak = 0; rt.lastEdgePeak = 0; rt.midPressure = 50;
    rt.lastSentStrength = 0; rt.lastSendTs = 0;
    rt.pressureHistory = [];
    rt.edgingCount = 0; rt.shockCount = 0; rt.totalStimulationTime = 0;
    rt.lastUpdateTs = now; rt.lastIntensityUpdateTs = now;
    view.startTime = now; view.statusText = '准备就绪';
    view.midPressure = 50; view.edgePeak = 0; view.lastEdgePeak = 0;
    view.edgingCount = 0; view.shockCount = 0; view.totalStimulationTime = 0;
    try {
      if (DeviceAPI.device(SENSOR).isMapped()) DeviceAPI.device(SENSOR).invoke('reporting', 'setReportDelay', { ms: 100 });
      setStrength(0); setLockOpen(false); stopShockDev();
    } catch (_) {}
    const sensorDevice = DeviceAPI.device(SENSOR);
    const applyPressure = (nv) => {
      const p = Number(nv) || 0;
      if (!rt.running) return; // 结束后不再驱动状态机/设备（修复“停止后电机持续增强”）
      const ts = Date.now();
      rt.currentPressure = p;
      if (rt.paused) { view.currentPressure = p; return; } // 暂停只更新读数，不下发
      updateSurge(ts, p);
      const prevCount = rt.edgingCount;
      calculateStateLogic();
      updateIntensity();
      rt.pressureHistory.push({ ts: ts, pressure: p, strength: rt.currentIntensity, edgeActive: rt.state === S.EDGING, edgeTrigger: false });
      if (rt.pressureHistory.length > 3600) rt.pressureHistory.shift();
      const recent = rt.pressureHistory.slice(-60);
      rt.averagePressure = recent.length ? recent.reduce((a, it) => a + (Number(it.pressure) || 0), 0) / recent.length : p;
      if (rt.edgingCount > prevCount && rt.pressureHistory.length) {
        // 绿点标在本次突变峰值的顶点：回溯最近 2τ 窗口内压力最大处的采样点，而非计数那一刻
        const winMs = Math.max(50, Number(cfg.surgeWindowMs) || 500);
        const cutoff = ts - 2 * winMs;
        let peakIdx = rt.pressureHistory.length - 1;
        let peakVal = -Infinity;
        for (let i = rt.pressureHistory.length - 1; i >= 0; i--) {
          const s = rt.pressureHistory[i];
          if (s.ts < cutoff) break;
          const pv = Number(s.pressure) || 0;
          if (pv >= peakVal) { peakVal = pv; peakIdx = i; }
        }
        rt.pressureHistory[peakIdx].edgeTrigger = true;
      }
      view.currentPressure = p;
      view.averagePressure = Number(rt.averagePressure.toFixed(1));
    };
    sensorDevice.onValue('sphincterPressure', applyPressure);
    sensorDevice.readValue('sphincterPressure').then((values) => {
      if (!rt.running) return;
      const current = Array.isArray(values) ? values.find((value) => value !== null && value !== undefined) : values;
      if (current !== null && current !== undefined) applyPressure(current);
    }).catch((error) => addLog('warn', '读取当前气压失败: ' + (error && error.message || error)));
    addLog('info', '气压突变寸止已启动（窗口 ' + cfg.surgeWindowMs + 'ms / 抬升 ' + cfg.surgeRiseKpa + 'kPa）');
    playVoice('edging_start', 'intro', function () { return rt.running; });
    render();
  }
  function end() {
    rt.running = false; rt.paused = false;
    rt.targetIntensity = 0; rt.currentIntensity = 0; rt.unRandomIntensity = 0;
    rt.lastSentStrength = 0; rt.lastSendTs = 0;
    try { setStrength(0); } catch (_) {}
    try { stopShockDev(); } catch (_) {}
    try { setLockOpen(true); } catch (_) {}
    try { if (DeviceAPI.device(SENSOR).isMapped()) DeviceAPI.device(SENSOR).invoke('reporting', 'setReportDelay', { ms: 5000 }); } catch (_) {}
    if (rt.shockTimer) { clearTimeout(rt.shockTimer); rt.shockTimer = null; rt.isShocking = false; }
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
    view.statusText = '已结束';
    addLog('info', '结束（边缘 ' + rt.edgingCount + ' 次，电击 ' + rt.shockCount + ' 次）');
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
          if (rt.paused) { setStrength(0); rt.lastSentStrength = 0; }
          else rt.windowSamples = []; // 恢复后清空突变窗口，避免用暂停前的旧基准误判
          addLog('info', rt.paused ? '已暂停' : '已继续');
          render();
        } else if (name === 'addIntensity') {
          rt.targetIntensity = clamp(rt.targetIntensity + 10, 0, cfg.maxMotorIntensity);
          addLog('info', '手动 +10 强度 → ' + rt.targetIntensity.toFixed(1));
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
        if (which === 'mid') adjustMid(val);
        render();
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
    rt.midLimits = updateMidLimits();
    voicePlayer.setEnabled(p.voiceEnabled === undefined ? true : !!p.voiceEnabled);
    addLog('info', '设备通道就绪，开始游戏');
    start();
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = setInterval(loop, 200);
  }

  window.__game = { start, loop, end, rt, cfg, view };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);