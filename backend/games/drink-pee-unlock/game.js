// 喝水/憋尿解锁玩法 — 页面自驱动（DeviceAPI），逻辑/UI 对齐老版 drinkPeeUnlockEmbedded.js
(function () {
  'use strict';
  const SCALE = 'scale';   // 老版 SCALE_DEVICE
  const SENSOR = 'sensor'; // 老版 QIYA_DEVICE
  const QTZ = 'qtz';       // 老版 QTZ_DEVICE
  const CUNZHI = 'cunzhi'; // 寸止玩法设备（tiptoePressure）
  const PUNISH = 'punish'; // 老版 DIANJI_DEVICE
  const VIBE = 'vibe';     // 老版 VIBE_DEVICE
  const LOCK = 'lock';     // 老版 ZIDONGSUO_DEVICE

  const cfg = {
    mode: 'drink', durationSec: 1800, targetWeight: 500, changeThreshold: 1,
    stableWindowSec: 30, punishCooldownSec: 10, shockIntensity: 24, shockDuration: 2,
    pressureThreshold: 20, tiptoePressureThreshold: 100,
    vibeStartProb: 0.05, vibeIntensity: 255, vibeDuration: 3,
    tiptoeDebounceMs: 300,
  };
  const rt = {
    running: false, state: 'End', startTs: 0, endTs: 0, cooldownUntil: 0, forceStop: false,
    pressure: 0, pressureMin: null, pressureMax: null,
    qiyaMapped: false, qtzMapped: false,
    qtzTiptoePressure: 0, cunzhiMapped: false,
    tiptoePressure: 0, tiptoePressureMax: null,
    tiptoeViolated: false, tiptoeViolatedSince: 0,
    weight: null, weightTs: 0, weightHistory: [], weightMin: null, weightMax: null, initialWeight: null,
    stableSinceTs: 0, stableAnchorWeight: null,
    progress: 0, lastPunishReason: '无', shockCount: 0, shockTimer: null,
    punishMapped: false, shockActive: false,
    vibeActive: false, vibeTimer: null, lastProgressLogTs: 0,
  };
  const view = {
    title: '喝水/憋尿解锁玩法', statusText: '初始化', remainingSec: '-', initialWeight: '-',
    progress: 0, targetWeight: 500, shockCount: 0, cooldownRemainingSec: 0, lastPunishReason: '',
    weight: '-', pressure: '-', tiptoeOk: false, punishCountdown: '-', mode: 'drink',
    tiptoeQtz: '-', tiptoePressureText: '-', tiptoePressureThreshold: 0, tiptoePressureMax: '-',
    weightMin: '-', weightMax: '-', pressureMin: '-', pressureMax: '-', weightCount: 0,
    stableWindowSec: 0, punishCooldownSec: 0, punishDevice: '未映射',
    shockStatus: '不可用', shockIntensity: 0, shockDuration: 0,
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
    const shock = document.getElementById('shockStatusVal');
    if (shock) shock.classList.toggle('text-danger', !!rt.shockActive);
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
  // 根据惩罚原因映射语音 key
  function getPunishVoiceKey() {
    var r = rt.lastPunishReason;
    if (r.indexOf('气压') >= 0) return 'punish_pressure';
    if (r.indexOf('未保持双脚踮脚') >= 0) return 'punish_tiptoe_qtz';
    if (r.indexOf('脚跟落地') >= 0 || r.indexOf('压力超阈值') >= 0) return 'punish_tiptoe_cunzhi';
    if (r.indexOf('喝水') >= 0) return 'punish_drink_stall';
    if (r.indexOf('排泄') >= 0) return 'punish_pee_stall';
    return null;
  }
  // 根据结束原因映射语音 key
  function getEndVoiceKey(reason) {
    if (reason && reason.indexOf('达成目标') >= 0) return cfg.mode === 'pee' ? 'unlock_pee' : 'unlock_drink';
    if (reason && reason.indexOf('超时') >= 0) return 'unlock_timeout';
    return 'end_manual';
  }
  // 里程碑语音播报追踪（仅 Running 状态播报，避免与惩罚/冷却语音叠加及结束后误播）
  var _lastMilestone = 0;
  function checkMilestoneVoice() {
    if (rt.state !== 'Running') return;
    var pct = cfg.targetWeight > 0 ? rt.progress / cfg.targetWeight : 0;
    var milestones = [0.25, 0.50, 0.75, 0.90];
    for (var i = 0; i < milestones.length; i++) {
      if (pct >= milestones[i] && _lastMilestone < milestones[i]) {
        _lastMilestone = milestones[i];
        var key = 'progress_' + String(Math.round(milestones[i] * 100));
        playVoice(key, 'info', function () { return rt.running && rt.state === 'Running'; });
        return;
      }
    }
  }
  // 随机鼓励与提醒
  var _lastEncourageTs = 0;
  var _lastRemindTs = 0;
  function maybeEncourageOrRemind(now) {
    // 每 60~120 秒随机一句鼓励
    if (!_lastEncourageTs) _lastEncourageTs = now;
    if (now - _lastEncourageTs > 60000 + Math.random() * 60000) {
      _lastEncourageTs = now;
      playVoice(cfg.mode === 'pee' ? 'encourage_pee' : 'encourage_drink', 'info', function () { return rt.running && rt.state === 'Running'; });
      return;
    }
    // 每 45~90 秒随机一句姿态提醒（只提醒实际接了设备、正在被监测的姿态）
    if (!_lastRemindTs) _lastRemindTs = now;
    if (now - _lastRemindTs > 45000 + Math.random() * 45000) {
      _lastRemindTs = now;
      var remindKeys = [];
      if (rt.qtzMapped || rt.cunzhiMapped) remindKeys.push('remind_tiptoe');
      if (rt.qiyaMapped) remindKeys.push('remind_sphincter');
      if (remindKeys.length) playVoice(remindKeys[Math.floor(Math.random() * remindKeys.length)], 'info', function () { return rt.running && rt.state === 'Running'; });
    }
  }

  function setStrength(dev, v) { if (DeviceAPI.device(dev).isMapped()) DeviceAPI.device(dev).invoke('strength', 'set', { value: Math.round(v) }); }
  function startShock(voltage) {
    if (!rt.punishMapped) return false;
    DeviceAPI.device(PUNISH).invoke('shock', 'start', { voltage });
    rt.shockActive = true;
    return true;
  }
  function stopShockDev() {
    rt.shockActive = false;
    if (rt.punishMapped) DeviceAPI.device(PUNISH).invoke('shock', 'stop', {});
  }
  function setLockOpen(open) { if (DeviceAPI.device(LOCK).isMapped()) DeviceAPI.device(LOCK).invoke('lock', 'setOpen', { open: !!open }); }
  // QTZ 的按钮差异已收敛为 tiptoePressure 能力值。
  function tiptoeQtzOk() {
    if (!rt.qtzMapped) return true;
    return Number(rt.qtzTiptoePressure) <= (Number(cfg.tiptoePressureThreshold) || 0);
  }
  // CUNZHI01 压力式踮脚：压力低于阈值(未落地)才算踮脚成功；带防抖的违规判定
  function tiptoeCunzhiOk() { if (!rt.cunzhiMapped) return true; return !rt.tiptoeViolated; }
  // 综合踮脚判定：两种来源都必须满足（未映射的来源视为满足）
  function tiptoeOk() { return tiptoeQtzOk() && tiptoeCunzhiOk(); }
  // CUNZHI01 踮脚压力评估：超阈值 + 防抖后判定为违规（落地）
  function evalTiptoePressure(p) {
    rt.tiptoePressure = p;
    rt.tiptoePressureMax = rt.tiptoePressureMax === null ? p : Math.max(rt.tiptoePressureMax, p);
    refreshTiptoeViolation();
  }
  // 基于当前压力与防抖窗口重算违规状态（loop 兜底调用，不依赖上报频率）
  function refreshTiptoeViolation() {
    if (!rt.cunzhiMapped) return;
    const over = Number(rt.tiptoePressure) > (Number(cfg.tiptoePressureThreshold) || 0);
    const now = Date.now();
    if (over) {
      if (!rt.tiptoeViolatedSince) rt.tiptoeViolatedSince = now;
      if (!rt.tiptoeViolated && (now - rt.tiptoeViolatedSince) >= (Number(cfg.tiptoeDebounceMs) || 0)) rt.tiptoeViolated = true;
    } else if (rt.tiptoeViolated || rt.tiptoeViolatedSince) {
      rt.tiptoeViolated = false;
      rt.tiptoeViolatedSince = 0;
    }
  }
  function pressureOk() { if (!rt.qiyaMapped) return true; return Number(rt.pressure) >= (Number(cfg.pressureThreshold) || 0); }
  function remainingSec(now) { return Math.max(0, Math.ceil((rt.endTs - now) / 1000)); }
  function punishCountdownSec(now) {
    if (!rt.weightTs || !rt.stableSinceTs) return null;
    const windowMs = Math.max(1, Number(cfg.stableWindowSec) || 0) * 1000;
    return Math.max(0, (windowMs - (now - rt.stableSinceTs)) / 1000);
  }
  function calcMinMax(arr) {
    let min = null, max = null;
    for (const it of (arr || [])) { const w = Number(it && it.weight); if (Number.isNaN(w)) continue; min = min === null ? w : Math.min(min, w); max = max === null ? w : Math.max(max, w); }
    return { min, max };
  }
  function resetStableTracking(ts) {
    rt.weightHistory = [];
    rt.weightMin = null;
    rt.weightMax = null;
    if (rt.weight === null) {
      rt.weightTs = 0;
      rt.stableSinceTs = 0;
      rt.stableAnchorWeight = null;
      return;
    }
    rt.weightTs = ts;
    rt.stableSinceTs = ts;
    rt.stableAnchorWeight = rt.weight;
    rt.weightHistory.push({ ts, weight: rt.weight });
    rt.weightMin = rt.weight;
    rt.weightMax = rt.weight;
  }

  function syncView() {
    const now = Date.now();
    view.statusText = stateText();
    view.remainingSec = remainingSec(now);
    view.initialWeight = rt.initialWeight === null ? '-' : round1(rt.initialWeight);
    view.progress = round1(rt.progress);
    view.targetWeight = Number(cfg.targetWeight) || 0;
    view.shockCount = rt.shockCount;
    view.punishDevice = rt.punishMapped ? '已映射' : '未映射';
    view.shockStatus = !rt.punishMapped ? '不可用' : (rt.shockActive ? '电击中' : '待机');
    view.shockIntensity = Number(cfg.shockIntensity) || 0;
    view.shockDuration = Number(cfg.shockDuration) || 0;
    view.cooldownRemainingSec = rt.state === 'Cooldown' ? Math.max(0, Math.ceil((rt.cooldownUntil - now) / 1000)) : 0;
    view.lastPunishReason = rt.lastPunishReason;
    view.weight = rt.weight === null ? '-' : round1(rt.weight);
    view.pressure = rt.qiyaMapped ? round1(rt.pressure) : '-';
    view.tiptoeOk = tiptoeOk();
    view.tiptoeQtz = !rt.qtzMapped ? '未接' : (tiptoeQtzOk() ? '正常' : '落地');
    view.tiptoePressureText = !rt.cunzhiMapped ? '未接' : round1(rt.tiptoePressure);
    view.tiptoePressureThreshold = Number(cfg.tiptoePressureThreshold) || 0;
    view.tiptoePressureMax = rt.tiptoePressureMax === null ? '-' : round1(rt.tiptoePressureMax);
    view.mode = cfg.mode;
    view.weightMin = rt.weightMin === null ? '-' : round1(rt.weightMin);
    view.weightMax = rt.weightMax === null ? '-' : round1(rt.weightMax);
    view.pressureMin = rt.pressureMin === null ? '-' : round1(rt.pressureMin);
    view.pressureMax = rt.pressureMax === null ? '-' : round1(rt.pressureMax);
    view.weightCount = rt.weightHistory.length;
    view.stableWindowSec = Number(cfg.stableWindowSec) || 0;
    view.punishCooldownSec = Number(cfg.punishCooldownSec) || 0;
    const countdown = punishCountdownSec(now);
    view.punishCountdown = countdown === null ? '-' : Math.ceil(countdown);
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
    const shockStarted = startShock(voltage);
    if (shockStarted) {
      rt.shockCount += 1;
      addLog('warn', `触发电击惩罚: 原因=${rt.lastPunishReason}（${voltage}V）`);
    } else {
      addLog('warn', `触发惩罚: 原因=${rt.lastPunishReason}（未映射电击设备，已跳过电击）`);
    }
    playVoice(getPunishVoiceKey(), 'critical', function () { return rt.running && rt.state === 'Punish'; });
    syncView(); render();
    if (rt.shockTimer) clearTimeout(rt.shockTimer);
    rt.shockTimer = setTimeout(() => { stopShockDev(); enterCooldown(); }, shockDurationMs);
  }
  function enterCooldown() {
    rt.state = 'Cooldown';
    rt.cooldownUntil = Date.now() + Math.max(1, Number(cfg.punishCooldownSec) || 0) * 1000;
    addLog('info', `进入冷却 (${Number(cfg.punishCooldownSec)}s)`);
    playVoice('cooldown_start', 'state', function () { return rt.running && rt.state === 'Cooldown'; });
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
    if (!rt.running) return; // 结束后属性回调仍在，避免结束时重复 end/重复播报
    const windowMs = Math.max(1, Number(cfg.stableWindowSec) || 0) * 1000;
    const cutoff = ts - windowMs;
    const mode = cfg.mode === 'pee' ? 'pee' : 'drink';
    rt.weight = weight; rt.weightTs = ts;
    if (rt.initialWeight === null) rt.initialWeight = weight;
    else if (mode === 'drink') rt.initialWeight = Math.max(rt.initialWeight, weight);
    else rt.initialWeight = Math.min(rt.initialWeight, weight);
    rt.weightHistory = rt.weightHistory.filter((it) => it && typeof it.ts === 'number' && it.ts >= cutoff);
    rt.weightHistory.push({ ts, weight });
    const mm = calcMinMax(rt.weightHistory);
    rt.weightMin = mm.min; rt.weightMax = mm.max;
    const oldProgress = rt.progress;
    rt.progress = mode === 'drink'
      ? Math.max(0, rt.initialWeight - weight)
      : Math.max(0, weight - rt.initialWeight);
    if (rt.progress - oldProgress > 0.5) {
      const now = Date.now();
      if (now - (rt.lastProgressLogTs || 0) >= 2000) { rt.lastProgressLogTs = now; addLog('info', `进度更新: ${round1(rt.progress)}g`); }
    }
    const thresholdG = Math.max(0, Number(cfg.changeThreshold) || 0);
    if (!rt.stableSinceTs || rt.stableAnchorWeight === null) {
      rt.stableSinceTs = ts;
      rt.stableAnchorWeight = weight;
    } else {
      const changed = mode === 'drink'
        ? rt.stableAnchorWeight > weight + thresholdG
        : rt.stableAnchorWeight < weight - thresholdG;
      if (changed) {
        rt.stableSinceTs = ts;
        rt.stableAnchorWeight = weight;
      }
    }
    if (rt.progress >= Math.max(1, Number(cfg.targetWeight) || 0)) { enterUnlocked('达成目标'); end({ reason: '达成目标' }); return; }
    checkMilestoneVoice();
    syncView(); render();
  }
  function loop() {
    if (!rt.running) return;
    if (rt.forceStop) { end({ reason: '手动结束' }); return; }
    const now = Date.now();
    if (now >= rt.endTs) { enterUnlocked('超时自动解锁'); end({ reason: '超时自动解锁' }); return; }
    if (rt.state === 'Cooldown') {
      if (now >= rt.cooldownUntil) {
        resetStableTracking(now);
        rt.state = 'Running';
        rt.lastPunishReason = '无';
        addLog('info', '冷却结束，恢复运行');
        playVoice('cooldown_end', 'state', function () { return rt.running && rt.state === 'Running'; });
      }
      syncView(); render(); return;
    }
    if (rt.state === 'Running') {
      refreshTiptoeViolation();
      if (!pressureOk()) { enterPunish('提肛惩罚：气压不足'); return; }
      if (!tiptoeQtzOk()) { enterPunish('踮脚惩罚：未保持双脚踮脚'); return; }
      if (!tiptoeCunzhiOk()) { enterPunish('踮脚惩罚：脚跟落地(压力超阈值)'); return; }
      const countdown = punishCountdownSec(now);
      if (countdown !== null && countdown <= 0) {
        const type = cfg.mode === 'pee' ? '排泄惩罚' : '喝水惩罚';
        enterPunish(`${type}：${Number(cfg.stableWindowSec) || 0}秒内无有效重量变化`);
        return;
      }
      if (!rt.vibeActive && Math.random() < clamp(Number(cfg.vibeStartProb) || 0, 0, 1)) startVibe();
      maybeEncourageOrRemind(now);
      syncView(); render(); return;
    }
    if (rt.state === 'Unlocked') { end({ reason: '已解锁' }); return; }
  }
  function start() {
    const now = Date.now();
    voicePlayer.stop();
    rt.running = true; rt.state = 'Running'; rt.startTs = now;
    rt.endTs = now + Math.max(1, Number(cfg.durationSec) || 0) * 1000;
    rt.cooldownUntil = 0; rt.forceStop = false;
    rt.pressureMin = null; rt.pressureMax = null; rt.qtzTiptoePressure = 0;
    rt.qiyaMapped = DeviceAPI.device(SENSOR).isMapped();
    rt.qtzMapped = DeviceAPI.device(QTZ).isMapped();
    rt.cunzhiMapped = DeviceAPI.device(CUNZHI).isMapped();
    rt.tiptoePressure = 0; rt.tiptoePressureMax = null; rt.tiptoeViolated = false; rt.tiptoeViolatedSince = 0;
    rt.punishMapped = DeviceAPI.device(PUNISH).isMapped();
    rt.weight = null; rt.weightTs = 0; rt.weightHistory = []; rt.weightMin = null; rt.weightMax = null; rt.initialWeight = null;
    rt.stableSinceTs = 0; rt.stableAnchorWeight = null;
    rt.progress = 0; rt.lastPunishReason = '无'; rt.shockCount = 0;
    rt.shockActive = false; rt.vibeActive = false;
    // 重置语音追踪状态
    _lastMilestone = 0;
    _lastEncourageTs = 0;
    _lastRemindTs = 0;
    const scaleDevice = DeviceAPI.device(SCALE);
    scaleDevice.onValue('weight', (nv) => { const w = Number(nv); if (!Number.isNaN(w)) onWeightSample(w, Date.now()); });
    if (scaleDevice.isMapped()) {
      scaleDevice.readValue('weight').then((values) => {
        if (!rt.running || rt.weightTs) return;
        const current = Array.isArray(values) ? values.find((value) => value !== null && value !== undefined) : values;
        const weight = Number(current);
        if (!Number.isNaN(weight)) onWeightSample(weight, Date.now());
      }).catch((error) => addLog('warn', `读取电子秤当前重量失败: ${error && error.message || error}`));
    }
    try {
      if (scaleDevice.isMapped()) scaleDevice.invoke('reporting', 'setReportDelay', { ms: 1000 });
      setLockOpen(false); stopShockDev(); setStrength(VIBE, 0);
    } catch (_) {}
    if (rt.qiyaMapped) {
      const sensorDevice = DeviceAPI.device(SENSOR);
      const applyPressure = (nv) => {
        const p = Number(nv); if (Number.isNaN(p)) return;
        rt.pressure = p; rt.pressureMin = rt.pressureMin === null ? p : Math.min(rt.pressureMin, p); rt.pressureMax = rt.pressureMax === null ? p : Math.max(rt.pressureMax, p);
        view.pressure = round1(p);
      };
      sensorDevice.onValue('sphincterPressure', applyPressure);
      sensorDevice.readValue('sphincterPressure').then((values) => {
        if (!rt.running) return;
        const current = Array.isArray(values) ? values.find((value) => value !== null && value !== undefined) : values;
        if (current !== null && current !== undefined) applyPressure(current);
      }).catch((error) => addLog('warn', `读取当前气压失败: ${error && error.message || error}`));
    }
    if (rt.qtzMapped) {
      const tiptoeDevice = DeviceAPI.device(QTZ);
      const applyTiptoePressure = (nv) => {
        const p = Number(nv); if (Number.isNaN(p)) return;
        rt.qtzTiptoePressure = p;
        view.tiptoeOk = tiptoeOk();
      };
      tiptoeDevice.onValue('tiptoePressure', applyTiptoePressure);
      tiptoeDevice.readValue('tiptoePressure').then((values) => {
        if (!rt.running) return;
        const current = Array.isArray(values) ? values.find((value) => value !== null && value !== undefined) : values;
        if (current !== null && current !== undefined) applyTiptoePressure(current);
      }).catch((error) => addLog('warn', `读取当前踮脚压力失败: ${error && error.message || error}`));
    }
    if (rt.cunzhiMapped) {
      const cunzhiDevice = DeviceAPI.device(CUNZHI);
      try { cunzhiDevice.invoke('reporting', 'setReportDelay', { ms: 100 }); } catch (_) {}
      cunzhiDevice.onValue('tiptoePressure', (nv) => { evalTiptoePressure(Number(nv) || 0); });
      cunzhiDevice.readValue('tiptoePressure').then((values) => {
        if (!rt.running) return;
        const current = Array.isArray(values) ? values.find((value) => value !== null && value !== undefined) : values;
        if (current !== null && current !== undefined) evalTiptoePressure(Number(current) || 0);
      }).catch((error) => addLog('warn', `读取 CUNZHI01 踮脚压力失败: ${error && error.message || error}`));
      addLog('info', `CUNZHI01 踮脚压力监测已启用（阈值 ${cfg.tiptoePressureThreshold}，防抖 ${cfg.tiptoeDebounceMs}ms）`);
    }
    addLog('info', `游戏启动 mode=${cfg.mode} target=${cfg.targetWeight}g`);
    playVoice(cfg.mode === 'pee' ? 'start_pee' : 'start_drink', 'intro', function () { return rt.running; });
    syncView(); render();
  }
  function end(extra) {
    rt.running = false;
    if (rt.shockTimer) { clearTimeout(rt.shockTimer); rt.shockTimer = null; }
    if (rt.vibeTimer) { clearTimeout(rt.vibeTimer); rt.vibeTimer = null; }
    setStrength(VIBE, 0); stopShockDev(); setLockOpen(true);
    try { if (DeviceAPI.device(SCALE).isMapped()) DeviceAPI.device(SCALE).invoke('reporting', 'setReportDelay', { ms: 5000 }); } catch (_) {}
    try { if (rt.cunzhiMapped) DeviceAPI.device(CUNZHI).invoke('reporting', 'setReportDelay', { ms: 5000 }); } catch (_) {}
    if (rt.state !== 'Unlocked') rt.state = 'End';
    const reason = extra && extra.reason || '';
    addLog('info', `结束: ${reason}（进度 ${round1(rt.progress)}g）`);
    playVoice(getEndVoiceKey(reason), 'critical', function () { return !rt.running; });
    syncView(); render();
  }

  let loopTimer = null;
  async function boot() {
    render();
    try { await DeviceAPI.ready; } catch (_) {}
    const p = DeviceAPI.params || {};
    Object.keys(cfg).forEach((k) => { if (p[k] !== undefined && p[k] !== null) cfg[k] = p[k]; });
    voicePlayer.setEnabled(p.voiceEnabled === undefined ? true : !!p.voiceEnabled);
    addLog('info', '设备通道就绪，开始游戏');
    start();
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = setInterval(loop, 1000);
  }

  window.__game = { start, loop, end, rt, cfg, view };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
