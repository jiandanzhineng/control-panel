// 运动心率电击提醒 — 页面渲染与自驱动回退
// 托管模式（window.GameRuntimeBridge 存在时）：只渲染宿主快照并转发动作，逻辑在后台宿主核心运行。
// 页面自驱动回退（无 GameRuntimeBridge 时）：复用同一份 HeartRateTrainerCore，经 DeviceAPI 读写设备。
(function () {
  'use strict';

  function L() {
    return (typeof GameI18n !== 'undefined' && GameI18n.t)
      ? GameI18n.t
      : function (zh, vars) {
          if (!vars || typeof vars !== 'object') return zh;
          return String(zh).replace(/\{(\w+)\}/g, function (_, k) {
            return vars[k] !== undefined ? String(vars[k]) : '{' + k + '}';
          });
        };
  }
  function t(zh, vars) { return L()(zh, vars); }

  var ROLE_HRM = 'hrm';
  var ROLE_SHOCK = 'shock';
  var ROLE_MOTOR = 'motor';
  var ROLE_LOCK = 'lock';

  var hostBridge = (typeof window !== 'undefined' && window.GameRuntimeBridge)
    ? window.GameRuntimeBridge
    : null;

  var uiState = {
    authorized: hostBridge ? hostBridge.mode === 'host' : true,
    hasLock: null,
    hostError: '',
    paused: false,
    running: false,
    ended: false,
    phase: 'IDLE',
    startedAtMs: -1,
    lastLogKey: '',
    snapshot: null,
  };

  function byId(id) {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
  }

  function queryAll(sel) {
    return typeof document !== 'undefined' && document.querySelectorAll
      ? Array.from(document.querySelectorAll(sel))
      : [];
  }

  function formatClock(totalSec) {
    var sec = Math.max(0, Math.floor(Number(totalSec) || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var mm = String(m).padStart(2, '0');
    var ss = String(s).padStart(2, '0');
    return h > 0 ? (h + ':' + mm + ':' + ss) : (mm + ':' + ss);
  }

  function translatePhase(phase) {
    switch (phase) {
      case 'WARMUP': return t('热身阶段');
      case 'ACTIVE_OK': return t('达标巡航');
      case 'WARNING': return t('低心率预警');
      case 'SHOCKING': return t('⚡ 电击提醒中');
      case 'COOLDOWN': return t('冷却恢复期');
      case 'SIGNAL_WAIT': return t('信号等待中');
      case 'SIGNAL_LOST': return t('信号已中断');
      case 'PAUSED': return t('暂停休息');
      case 'ENDED': return t('训练结束');
      default: return t('准备就绪');
    }
  }

  function translateStatus(snap) {
    if (!snap) return t('连接中断，正在重连…');
    if (snap.ended) return snap.endReason === 'duration' ? t('训练已完成') : t('训练已结束');
    if (!snap.running) return t('准备就绪');
    if (snap.paused) return t('已暂停');
    if (snap.phase === 'SHOCKING') return t('低心率电击提醒中（{v}V）', { v: snap.lastShockVoltage || snap.nextShockVoltage || 0 });
    if (snap.phase === 'WARMUP') return t('热身缓冲中（{n}s）', { n: snap.warmupRemainingSec || 0 });
    if (snap.phase === 'COOLDOWN') return t('电击冷却恢复期（{n}s）', { n: snap.cooldownRemainingSec || 0 });
    if (snap.phase === 'WARNING') {
      return snap.graceRemainingSec > 0
        ? t('心率偏低预警（{n}s 后电击）', { n: snap.graceRemainingSec })
        : t('心率偏低预警');
    }
    if (snap.phase === 'SIGNAL_WAIT') return t('等待心率传感器数据…');
    if (snap.phase === 'SIGNAL_LOST') return t('心率信号中断，请检查佩戴');
    return t('心率达标，保持节奏！');
  }

  function translateHrSensorBadge(snap) {
    if (!snap) return t('等待连接');
    if (snap.hrStatus === 'disconnected' || snap.hrStatus === 'offline') return t('设备已断开');
    if (snap.hrStatus === 'no_contact' || snap.hrContact === 0) return t('未贴合皮肤');
    if (snap.hrStatus === 'stale') return t('信号超时');
    if (snap.sensorConnected) return t('佩戴正常');
    return t('等待连接');
  }

  function phaseSubHint(snap) {
    if (!snap || !snap.running || snap.paused) return '';
    if (snap.phase === 'WARMUP' && snap.warmupRemainingSec > 0) {
      return t('热身剩余 {n} 秒', { n: snap.warmupRemainingSec });
    }
    if (snap.phase === 'WARNING' && snap.graceRemainingSec > 0) {
      return t('距电击还有 {n} 秒', { n: snap.graceRemainingSec });
    }
    if (snap.phase === 'COOLDOWN' && snap.cooldownRemainingSec > 0) {
      return t('冷却剩余 {n} 秒', { n: snap.cooldownRemainingSec });
    }
    if ((snap.phase === 'SIGNAL_WAIT' || snap.phase === 'SIGNAL_LOST') && snap.signalLossRemainingSec > 0) {
      return t('宽限剩余 {n} 秒', { n: snap.signalLossRemainingSec });
    }
    return '';
  }

  function setText(id, text) {
    var el = byId(id);
    if (el) el.textContent = text == null ? '' : String(text);
  }

  function setControlsEnabled(enabled) {
    queryAll('[data-action]').forEach(function (btn) {
      var act = btn.getAttribute('data-action');
      var disabled = !enabled;
      if (!disabled && (!uiState.running || uiState.ended) && act !== 'unlock') disabled = true;
      if (!disabled && act === 'skipWarmup' && (uiState.paused || uiState.phase !== 'WARMUP')) disabled = true;
      btn.disabled = disabled;
    });
  }

  function renderLogs(logs) {
    var ul = byId('logs');
    if (!ul || !Array.isArray(logs)) return;
    var key = logs.length + ':' + (logs[0] ? String(logs[0].atMs || '') + logs[0].message : '');
    if (key === uiState.lastLogKey) return;
    uiState.lastLogKey = key;
    ul.innerHTML = '';
    logs.slice(0, 15).forEach(function (entry) {
      var li = document.createElement('li');
      li.className = 'log-item log-' + String((entry && entry.level) || 'info');
      var at = Number(entry && entry.atMs) || 0;
      var timeStr = at > 0 ? '[' + new Date(at).toLocaleTimeString() + '] ' : '';
      li.textContent = timeStr + String((entry && entry.message) || '');
      ul.appendChild(li);
    });
  }

  function drawChart(snap) {
    var canvas = byId('hrChart');
    if (!canvas || typeof canvas.getContext !== 'function') return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? Math.min(window.devicePixelRatio, 2) : 1;
    var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 600, height: 150 };
    var w = Math.max(260, Math.floor(rect.width || canvas.width || 600));
    var h = Math.max(120, Math.floor(rect.height || canvas.height || 150));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    var padL = 38, padR = 14, padT = 16, padB = 22;
    var plotW = w - padL - padR;
    var plotH = h - padT - padB;

    var pts = (snap && Array.isArray(snap.history)) ? snap.history : [];
    var minTarget = Number(snap && snap.minHeartRate) || 120;
    var lo = Math.min(60, minTarget - 25);
    var hi = Math.max(170, minTarget + 35);
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].valid && pts[i].bpm > 0) {
        if (pts[i].bpm - 10 < lo) lo = Math.max(30, pts[i].bpm - 10);
        if (pts[i].bpm + 12 > hi) hi = Math.min(230, pts[i].bpm + 12);
      }
    }
    var span = Math.max(20, hi - lo);
    function yOf(bpm) {
      return padT + plotH - ((bpm - lo) / span) * plotH;
    }

    // 背景安全区间（下限以上淡绿，下限以下淡红）
    var targetY = Math.max(padT, Math.min(padT + plotH, yOf(minTarget)));
    ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
    ctx.fillRect(padL, padT, plotW, Math.max(0, targetY - padT));
    ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
    ctx.fillRect(padL, targetY, plotW, Math.max(0, padT + plotH - targetY));

    // 水平网格线
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'right';
    [lo, Math.round((lo + hi) / 2), hi].forEach(function (val) {
      var y = yOf(val);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(String(val), padL - 6, y + 4);
    });

    // 目标心率下限虚线
    ctx.save();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, targetY);
    ctx.lineTo(padL + plotW, targetY);
    ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'left';
    ctx.fillText('≥' + minTarget + ' bpm', padL + 6, Math.max(padT + 11, targetY - 5));
    ctx.restore();

    // 绘制心率折线与电击闪电标记
    if (pts.length > 0) {
      var stepX = pts.length > 1 ? plotW / Math.max(30, pts.length - 1) : plotW;
      ctx.lineWidth = 2.4;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      var startedSeg = false;
      ctx.beginPath();
      ctx.strokeStyle = '#38bdf8';
      for (var j = 0; j < pts.length; j++) {
        var x = padL + (pts.length > 30 ? (j / (pts.length - 1)) * plotW : j * stepX);
        if (pts[j].valid && pts[j].bpm > 0) {
          var y = yOf(pts[j].bpm);
          if (!startedSeg) {
            ctx.moveTo(x, y);
            startedSeg = true;
          } else {
            ctx.lineTo(x, y);
          }
        } else {
          startedSeg = false;
        }
      }
      ctx.stroke();

      for (var k = 0; k < pts.length; k++) {
        if (!pts[k].shocked) continue;
        var sx = padL + (pts.length > 30 ? (k / (pts.length - 1)) * plotW : k * stepX);
        var sy = pts[k].valid && pts[k].bpm > 0 ? yOf(pts[k].bpm) : targetY + 12;
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  function renderSnapshot(snap) {
    uiState.snapshot = snap;
    var rootEl = byId('appRoot');

    if (!snap) {
      setText('statusText', t('连接中断，正在重连…'));
      if (rootEl) rootEl.setAttribute('data-phase', 'DISCONNECTED');
      return;
    }

    var startedAtMs = Number(snap.startedAtMs) || 0;
    if (startedAtMs !== uiState.startedAtMs) {
      uiState.startedAtMs = startedAtMs;
      uiState.lastLogKey = '';
    }

    uiState.running = !!snap.running;
    uiState.paused = !!snap.paused;
    uiState.ended = !!snap.ended;
    uiState.phase = String(snap.phase || 'IDLE');

    if (rootEl) {
      rootEl.setAttribute('data-phase', uiState.phase);
      rootEl.classList.toggle('is-shocking', !!snap.isShocking);
    }

    setText('phaseBadge', translatePhase(uiState.phase));
    setText('statusText', translateStatus(snap));
    setText('phaseHint', phaseSubHint(snap));
    setText('sensorBadge', translateHrSensorBadge(snap));
    setText('batteryBadge', snap.battery != null ? t('电量为 {n}%', { n: snap.battery }) : t('电量 --'));
    setText('lockBadge', snap.isLocked ? t('已加锁') : t('已解锁'));
    var showLock = uiState.hasLock !== false;
    var lockBadgeEl = byId('lockBadge');
    if (lockBadgeEl) lockBadgeEl.style.display = showLock ? '' : 'none';
    var unlockBtnEl = byId('unlockBtn');
    if (unlockBtnEl) unlockBtnEl.style.display = showLock ? '' : 'none';

    var hr = snap.heartRate;
    setText('hrValue', hr != null && hr > 0 ? String(Math.round(hr)) : '--');
    setText('minHrValue', String(snap.minHeartRate || 120));

    var deltaEl = byId('hrDeltaText');
    if (deltaEl) {
      if (hr == null || hr <= 0) {
        deltaEl.textContent = snap.lastValidHeartRate > 0
          ? t('信号中断（上次 {n} bpm）', { n: snap.lastValidHeartRate })
          : t('暂无有效读数');
        deltaEl.className = 'hr-delta muted';
      } else if (snap.hrDelta > 0) {
        deltaEl.textContent = t('高于下限 +{n} bpm', { n: snap.hrDelta });
        deltaEl.className = 'hr-delta ok';
      } else if (snap.hrDelta === 0) {
        deltaEl.textContent = t('刚好达标');
        deltaEl.className = 'hr-delta ok';
      } else {
        deltaEl.textContent = t('低于下限 {n} bpm', { n: snap.hrDelta });
        deltaEl.className = 'hr-delta danger';
      }
    }

    // 进度条：将当前心率映射在 [50 .. minHeartRate + 40] 区间
    var gaugeFill = byId('hrGaugeFill');
    var gaugeMarker = byId('hrGaugeMarker');
    var minHr = Number(snap.minHeartRate) || 120;
    var maxScale = Math.max(180, minHr + 40);
    var minScale = 40;
    var markerPct = Math.max(5, Math.min(95, ((minHr - minScale) / (maxScale - minScale)) * 100));
    var fillPct = hr != null && hr > 0
      ? Math.max(2, Math.min(100, ((hr - minScale) / (maxScale - minScale)) * 100))
      : 0;
    if (gaugeMarker) gaugeMarker.style.left = markerPct.toFixed(1) + '%';
    if (gaugeFill) {
      gaugeFill.style.width = fillPct.toFixed(1) + '%';
      gaugeFill.className = 'gauge-fill ' + (hr != null && hr >= minHr ? 'ok' : 'low');
    }

    // 电击闪电横幅
    var shockBanner = byId('shockFlashBanner');
    if (shockBanner) {
      shockBanner.style.display = snap.isShocking ? 'flex' : 'none';
      setText('shockFlashText', t('低心率电击提醒中（{v}V）', { v: snap.lastShockVoltage || snap.nextShockVoltage || 0 }));
    }

    // 核心指标卡片
    setText('remainingClock', formatClock(snap.remainingSec));
    setText('complianceRate', String(snap.compliancePercent != null ? snap.compliancePercent : 100) + '%');
    setText('shockCountValue', String(snap.shockCount || 0));
    var reqV = Number(snap.requestedShockVoltage || (snap.params && snap.params.shockVoltage) || 0);
    var nextV = Number(snap.nextShockVoltage || 0);
    setText(
      'nextVoltageHint',
      reqV > nextV && nextV > 0
        ? t('下次电击 {v}V（请求 {r}V）', { v: nextV, r: reqV })
        : t('下次电击 {v}V', { v: nextV }),
    );
    setText('avgMaxHr', (snap.avgHeartRate || '--') + ' / ' + (snap.maxHeartRate || '--'));

    var params = snap.params || {};
    var effectiveV = nextV || params.shockVoltage || 18;
    setText(
      'cfgSummaryVoltage',
      reqV > effectiveV ? t('{v}V（上限钳制）', { v: effectiveV }) : (effectiveV + 'V'),
    );
    setText('cfgSummaryDuration', (params.shockDurationSeconds || 2) + 's');
    setText('cfgSummaryCooldown', (params.cooldownSeconds || 15) + 's');
    setText('cfgSummaryGrace', (params.belowThresholdGraceSeconds != null ? params.belowThresholdGraceSeconds : 5) + 's');
    if (uiState.hostError) {
      setText('phaseHint', uiState.hostError);
    }

    setText('pauseBtnLabel', uiState.paused ? t('继续') : t('暂停'));
    var skipWrap = byId('skipWarmupBtn');
    if (skipWrap) {
      skipWrap.style.display = uiState.phase === 'WARMUP' ? '' : 'none';
    }

    setControlsEnabled(uiState.authorized);
    renderLogs(snap.logs);
    drawChart(snap);
  }

  // ---- 托管模式（PC / 手机 HostRuntime & 远程同步） ----

  function sendHostAction(action, payload) {
    if (!hostBridge || !uiState.authorized) return;
    if (action === 'togglePause') {
      hostBridge.sendAction(uiState.paused ? 'resume' : 'pause', {}).catch(function () {});
      return;
    }
    hostBridge.sendAction(action, payload || {}).catch(function () {});
  }

  function bindActionButtons(dispatch) {
    queryAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-action');
        var deltaAttr = btn.getAttribute('data-delta');
        var payload = deltaAttr !== null ? { delta: Number(deltaAttr) } : {};
        dispatch(act, payload);
      });
    });
  }

  function bootHosted() {
    bindActionButtons(sendHostAction);
    if (typeof GameI18n !== 'undefined' && GameI18n.apply) GameI18n.apply();
    if (hostBridge.mode === 'remote') {
      uiState.authorized = false;
      setControlsEnabled(false);
    }
    hostBridge.onSnapshot(function (status, snapshot) {
      if (status && status.deviceMap && typeof status.deviceMap === 'object') {
        var lockIds = status.deviceMap[ROLE_LOCK];
        uiState.hasLock = Array.isArray(lockIds) ? lockIds.length > 0 : !!lockIds;
      }
      if (status && Array.isArray(status.errors) && status.errors.length > 0) {
        var lastErr = status.errors[status.errors.length - 1];
        uiState.hostError = lastErr && lastErr.message ? String(lastErr.message) : '';
      } else {
        uiState.hostError = '';
      }
      if (hostBridge.mode === 'remote') {
        var auth = !status || status.authorized !== false;
        if (auth !== uiState.authorized) {
          uiState.authorized = auth;
        }
      }
      renderSnapshot(snapshot);
    });
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', function () {
        if (uiState.snapshot) drawChart(uiState.snapshot);
      });
    }
    hostBridge.start();
  }

  // ---- 页面自驱动回退模式（无 HostRuntime 时经 DeviceAPI 驱动同一个 Core） ----

  var localTimer = null;
  var shockStopTimer = null;

  function safeInvoke(dev, cap, action, input) {
    if (!dev || !dev.isMapped()) return;
    try {
      var p = dev.invoke(cap, action, input || {});
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (_) {}
  }

  function stopStandaloneOutputs() {
    if (localTimer) { clearInterval(localTimer); localTimer = null; }
    if (shockStopTimer) { clearTimeout(shockStopTimer); shockStopTimer = null; }
    if (typeof DeviceAPI === 'undefined') return;
    [ROLE_SHOCK, ROLE_MOTOR].forEach(function (r) {
      safeInvoke(DeviceAPI.device(r), r === ROLE_SHOCK ? 'shock' : 'strength', 'stop', {});
    });
  }

  function applyDeviceEffects(effects) {
    if (typeof DeviceAPI === 'undefined' || !Array.isArray(effects)) return;
    effects.forEach(function (eff) {
      if (!eff || !eff.type) return;
      try {
        if (eff.type === 'device.shock') {
          // 页面自驱动回退缺乏宿主独立看门狗保障，禁止直接下发真实电击起始输出
          if (typeof DeviceAPI !== 'undefined' && DeviceAPI.log) {
            try { DeviceAPI.log('warn', '页面回退模式缺乏宿主独立停机保护，已跳过电击输出'); } catch (_) {}
          }
        } else if (eff.type === 'device.shock-stop') {
          if (shockStopTimer) { clearTimeout(shockStopTimer); shockStopTimer = null; }
          safeInvoke(DeviceAPI.device(ROLE_SHOCK), 'shock', 'stop', {});
        } else if (eff.type === 'device.set-strength') {
          safeInvoke(DeviceAPI.device(ROLE_MOTOR), 'strength', 'set', { value: eff.value });
        } else if (eff.type === 'device.stop-strength') {
          safeInvoke(DeviceAPI.device(ROLE_MOTOR), 'strength', 'stop', {});
        } else if (eff.type === 'device.lock') {
          safeInvoke(DeviceAPI.device(ROLE_LOCK), 'lock', 'setOpen', { open: !!eff.open });
        } else if (eff.type === 'device.stop-all') {
          stopStandaloneOutputs();
          safeInvoke(DeviceAPI.device(ROLE_LOCK), 'lock', 'setOpen', { open: true });
        }
      } catch (_) {}
    });
  }

  async function bootStandalone() {
    if (typeof GameI18n !== 'undefined' && GameI18n.apply) GameI18n.apply();
    var CoreCtor = (typeof globalThis !== 'undefined' && (
      (globalThis.__MobileSharedCore && globalThis.__MobileSharedCore.HeartRateTrainerCore)
      || globalThis.HeartRateTrainerCore
    )) || null;
    if (!CoreCtor) return;

    try {
      if (typeof DeviceAPI !== 'undefined' && DeviceAPI.ready) await DeviceAPI.ready;
    } catch (_) {}

    var initParams = (typeof DeviceAPI !== 'undefined' && DeviceAPI.params) ? DeviceAPI.params : {};
    var core = new CoreCtor({ params: initParams, random: Math.random });

    function handleResult(res) {
      if (!res) return;
      applyDeviceEffects(res.effects);
      renderSnapshot(res.snapshot);
      if (res.logs && typeof DeviceAPI !== 'undefined' && DeviceAPI.log) {
        res.logs.forEach(function (l) {
          try { DeviceAPI.log(l.level || 'info', l.message || ''); } catch (_) {}
        });
      }
    }

    bindActionButtons(function (act, payload) {
      handleResult(core.action(act, payload, Date.now()));
    });

    handleResult(core.start(Date.now()));

    if (typeof DeviceAPI !== 'undefined') {
      var lockDev = DeviceAPI.device(ROLE_LOCK);
      uiState.hasLock = !!(lockDev && lockDev.isMapped());
      var hrm = DeviceAPI.device(ROLE_HRM);
      if (hrm && hrm.isMapped()) {
        Promise.resolve(hrm.readValue('heartRate')).then(function (bpm) {
          if (typeof bpm === 'number' && Number.isFinite(bpm)) {
            handleResult(core.step({
              nowMs: Date.now(),
              events: [{ type: 'device-property', role: ROLE_HRM, deviceId: ROLE_HRM, name: 'heart_rate', value: bpm, seed: true }],
            }));
          }
        }).catch(function () {});

        hrm.onValue('heartRate', function (bpm) {
          handleResult(core.step({
            nowMs: Date.now(),
            events: [{ type: 'device-property', role: ROLE_HRM, deviceId: ROLE_HRM, name: 'heart_rate', value: bpm }],
          }));
        });

        ['hr_status', 'hr_contact', 'battery'].forEach(function (prop) {
          if (typeof hrm.onProperty === 'function') {
            hrm.onProperty(prop, function (val) {
              handleResult(core.step({
                nowMs: Date.now(),
                events: [{ type: 'device-property', role: ROLE_HRM, deviceId: ROLE_HRM, name: prop, value: val }],
              }));
            });
          }
        });
      }

      if (typeof DeviceAPI.onParamsChange === 'function') {
        DeviceAPI.onParamsChange(function (nextParams) {
          handleResult(core.setParams(nextParams || {}));
        });
      }
    }

    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', stopStandaloneOutputs);
      window.addEventListener('beforeunload', stopStandaloneOutputs);
      window.addEventListener('resize', function () {
        if (uiState.snapshot) drawChart(uiState.snapshot);
      });
    }

    if (localTimer) clearInterval(localTimer);
    localTimer = setInterval(function () {
      var snap = core.snapshot();
      if (snap && snap.ended) {
        stopStandaloneOutputs();
        return;
      }
      handleResult(core.step({ nowMs: Date.now(), events: [] }));
    }, 250);
  }

  function startApp() {
    if (hostBridge) bootHosted();
    else bootStandalone();
  }

  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
  } else {
    startApp();
  }
})();
