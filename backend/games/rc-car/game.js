// 遥控车 — 托管渲染页面（HostRuntime）
// 只渲染宿主快照、发送操作、在 host 模式播放语音；不直接访问设备。
(function () {
  'use strict';

  function L() { return (typeof GameI18n !== 'undefined' && GameI18n.t) ? GameI18n.t : function (zh) { return zh; }; }
  function t(zh) { return L()(zh); }
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
  function fmtDeg(v) { var n = Number(v); return (Number.isFinite(n) ? n.toFixed(1) : '0.0') + '°'; }
  function fmtSigned(v) { var n = Number(v) || 0; return (n >= 0 ? '+' : '') + n.toFixed(1) + '°'; }
  function fmtDuration(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return '--:--';
    var total = Math.max(0, Math.round(Number(ms) / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var mm = String(m).padStart(2, '0');
    var ss = String(s).padStart(2, '0');
    return h > 0 ? String(h) + ':' + mm + ':' + ss : mm + ':' + ss;
  }
  function fmtNum(v, digits) {
    var n = Number(v);
    return Number.isFinite(n) ? n.toFixed(digits == null ? 1 : digits) : '--';
  }

  var CMD_LABEL = { forward: '前进', backward: '后退', left: '左转', right: '右转' };
  var CMD_GLYPH = { forward: '▲', backward: '▼', left: '◀', right: '▶' };
  var PHASE_LABEL = { CALIBRATING: '校准中', STOPPED: '待命', MOVING: '移动中', TURNING: '转向中' };
  var PROMPT_TEXT = {
    calib_start: '校准开始：保持不动',
    calib_done: '校准完成',
    cmd_forward: '前进',
    cmd_backward: '后退',
    cmd_left: '左转',
    cmd_right: '右转',
    cmd_stop: '停',
    violation: '没有照做',
    level_up: '加强一档',
    level_down: '减弱一档',
    pelvic_remind: '收紧提肛',
    edging_peak: '寸止到了',
    sensor_lost: '传感器断开',
    game_end: '游戏结束'
  };
  var VOICE_KEYS = {};
  Object.keys(PROMPT_TEXT).forEach(function (key) { VOICE_KEYS[key] = true; });
  var EDGING_LABEL = { CALM: '平静', MIDDLE: '中段', EDGING: '临界' };
  var END_LABEL = { time: '时间到', stop: '已停止', action: '已停止' };

  function voiceLocale() {
    try {
      if (typeof GameI18n !== 'undefined' && typeof GameI18n.locale === 'function') {
        return GameI18n.locale() === 'en' ? 'en' : 'zh';
      }
    } catch (_) { /* 跟随中文 */ }
    return 'zh';
  }

  // 语音播放器：intro/critical/state 优先级 + 自动播放被拦时等一次用户手势（同 surge-edging）
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
      try { console.warn('语音播放失败 ' + event.key + ' (' + event.url + ')' + detail); } catch (_) {}
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
        var entry = { audio: audio, event: event, retried: false };
        entry.onEnded = function () { finishEntry(entry, false); };
        entry.onError = function () {
          // 英文语音缺失时回落中文，不影响口令节奏
          if (event.fallbackUrl && !entry.retried) {
            entry.retried = true;
            stopEntry(entry);
            if (current === entry) current = null;
            startEvent({ key: event.key, kind: event.kind, isValid: event.isValid, url: event.fallbackUrl });
            return;
          }
          finishEntry(entry, true);
        };
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
        logFailure(event, error);
        playQueuedState();
        return false;
      }
    }
    function play(key, options) {
      if (!enabled || !key) return false;
      var opts = options || {};
      var locale = voiceLocale();
      var event = {
        key: key,
        kind: opts.kind || 'info',
        isValid: opts.isValid,
        url: basePath + '/' + locale + '/' + key + '.mp3',
        fallbackUrl: locale === 'en' ? basePath + '/zh/' + key + '.mp3' : ''
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
        queuedState = event;
        return false;
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
  // ---- 托管桥 ----
  var bridge = (typeof window !== 'undefined' && window.GameRuntimeBridge) ? window.GameRuntimeBridge : null;
  var mode = bridge ? bridge.mode : '';
  var authorized = bridge ? bridge.mode !== 'remote' : false;
  var lastSnapshot = null;
  var snapAt = 0;
  var startedAtMs = -1;
  var lastPromptSeq = 0;
  var lastShocks = 0;
  var lastViolationAt = 0;
  var shockBaseline = false;
  var voiceEnabled = true;
  var flashTimer = null;
  var ui = { levelMax: 0, cmdKey: '', deadlineMs: 0, cmdTotal: 1 };

  function setConn(state) {
    var el = $('#connText');
    var pill = el ? el.closest('.pill') : null;
    if (!el) return;
    if (state === 'ok') {
      el.textContent = t('在线');
      if (pill) pill.setAttribute('data-tone', 'ok');
    } else if (state === 'lost') {
      el.textContent = t('离线');
      if (pill) pill.setAttribute('data-tone', 'danger');
    } else {
      el.textContent = t('等待指令');
      if (pill) pill.setAttribute('data-tone', 'warn');
    }
  }

  function flashHud() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    } catch (_) {}
    var el = $('#flash');
    if (!el) return;
    el.classList.add('on');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.classList.remove('on'); }, 450);
  }

  // 只在 host 模式（执行端）发声；remote 只显示文字
  function handleVoice(snapshot) {
    if (!bridge || bridge.mode !== 'host') return;
    var prompt = snapshot && snapshot.prompt;
    if (!prompt || !Number.isFinite(Number(prompt.seq))) return;
    var seq = Number(prompt.seq);
    if (seq === lastPromptSeq) return;
    lastPromptSeq = seq;
    if (!voiceEnabled) return;
    var key = String(prompt.key || '');
    if (!VOICE_KEYS[key]) return;
    var kind = (key === 'violation' || key.indexOf('cmd_') === 0) ? 'critical' : 'state';
    voicePlayer.play(key, { kind: kind });
  }

  function handleShockFlash(snapshot) {
    var shocks = Number(snapshot.stats && snapshot.stats.shocks) || 0;
    var violationAt = Number(snapshot.lastViolation && snapshot.lastViolation.atMs) || 0;
    if (!shockBaseline) {
      shockBaseline = true;
      lastShocks = shocks;
      lastViolationAt = violationAt;
      return;
    }
    if (shocks > lastShocks || violationAt !== lastViolationAt) flashHud();
    lastShocks = shocks;
    lastViolationAt = violationAt;
  }
  // ---- 罗盘 ----
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var COUNTDOWN_C = 2 * Math.PI * 42;
  var SHOCK_C = 2 * Math.PI * 54;

  function polar(cx, cy, r, deg) {
    var rad = (deg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }
  function arcPath(cx, cy, r, startDeg, endDeg) {
    if (Math.abs(endDeg - startDeg) < 0.01) return '';
    var s = polar(cx, cy, r, startDeg);
    var e = polar(cx, cy, r, endDeg);
    var large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
    var sweep = endDeg > startDeg ? 1 : 0;
    return 'M ' + s[0].toFixed(2) + ' ' + s[1].toFixed(2) +
      ' A ' + r + ' ' + r + ' 0 ' + large + ' ' + sweep + ' ' + e[0].toFixed(2) + ' ' + e[1].toFixed(2);
  }
  function buildCompassTicks() {
    var g = $('#compassTicks');
    if (!g) return;
    // 屏幕角度：0 在正上，顺时针增大。core 里正角 = 左转，所以左 90 = +90°，右 90 = -90°。
    var LABELS = { 0: '0', 90: 'R90', 180: '180', 270: 'L90' };
    for (var i = 0; i < 36; i += 1) {
      var deg = i * 10;
      var major = deg % 90 === 0;
      var a = polar(160, 160, major ? 110 : 119, deg);
      var b = polar(160, 160, 128, deg);
      var line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', a[0].toFixed(2));
      line.setAttribute('y1', a[1].toFixed(2));
      line.setAttribute('x2', b[0].toFixed(2));
      line.setAttribute('y2', b[1].toFixed(2));
      line.setAttribute('class', 'tick' + (major ? ' major' : ''));
      g.appendChild(line);
      if (major) {
        var pos = polar(160, 160, 96, deg);
        var label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('x', pos[0].toFixed(2));
        label.setAttribute('y', pos[1].toFixed(2));
        label.setAttribute('class', 'tick-label');
        label.textContent = LABELS[deg] || String(deg);
        g.appendChild(label);
      }
    }
  }

  function buildEnergy() {
    var track = $('#energyTrack');
    if (!track) return;
    for (var i = 0; i < 12; i += 1) {
      var seg = document.createElement('div');
      seg.className = 'energy-seg';
      track.appendChild(seg);
    }
  }

  function buildLevelSegs(max) {
    var box = $('#levelSegs');
    if (!box) return;
    box.innerHTML = '';
    var count = Math.max(1, Math.min(20, Math.round(max) || 1));
    for (var i = 0; i < count; i += 1) {
      var seg = document.createElement('div');
      seg.className = 'seg';
      box.appendChild(seg);
    }
    ui.levelMax = max;
  }
  function renderCompass(s) {
    var now = Date.now();
    var delta = Number(s.headingDelta) || 0;
    var needle = $('#needle');
    if (needle) needle.setAttribute('transform', 'rotate(' + (-delta).toFixed(2) + ' 160 160)');
    var hv = $('#headingValue');
    if (hv) hv.textContent = fmtDeg(s.heading);
    var hd = $('#headingDelta');
    if (hd) hd.textContent = fmtSigned(delta);

    var cmd = s.command;
    var targetD = '';
    var progressD = '';
    var glyphText = '·';
    if (cmd) {
      glyphText = CMD_GLYPH[cmd.cmd] || '·';
      if (cmd.cmd === 'left' || cmd.cmd === 'right') {
        var sign = cmd.cmd === 'left' ? 1 : -1; // core: 正角 = 左转
        var target = Math.max(0, Number(cmd.targetDeg) || 0);
        var progress = clamp(Number(cmd.progressDeg) || 0, 0, target);
        targetD = arcPath(160, 160, 116, 0, -sign * target);
        progressD = progress > 0.2 ? arcPath(160, 160, 116, 0, -sign * progress) : '';
      }
    }
    var targetArc = $('#targetArc');
    var progressArc = $('#progressArc');
    if (targetArc) { targetArc.setAttribute('d', targetD); targetArc.style.display = targetD ? '' : 'none'; }
    if (progressArc) { progressArc.setAttribute('d', progressD); progressArc.style.display = progressD ? '' : 'none'; }
    var glyph = $('#cmdGlyph');
    if (glyph) {
      glyph.textContent = glyphText;
      glyph.style.fill = cmd && cmd.status === 'violating' ? 'var(--danger)' : '';
    }

    var ring = $('#countdownRing');
    var val = $('#countdownValue');
    var txt = $('#countdownText');
    if (cmd && Number(cmd.deadlineMs) > 0) {
      var key = String(cmd.cmd) + ':' + String(cmd.sinceMs);
      if (key !== ui.cmdKey) { ui.cmdKey = key; ui.deadlineMs = 0; }
      if (Number(cmd.deadlineMs) !== ui.deadlineMs) {
        ui.cmdTotal = Math.max(0.1, (Number(cmd.deadlineMs) - now) / 1000);
        ui.deadlineMs = Number(cmd.deadlineMs);
      }
      var remain = Math.max(0, Number(cmd.deadlineMs) - now);
      var frac = clamp((remain / 1000) / ui.cmdTotal, 0, 1);
      if (val) val.setAttribute('stroke-dashoffset', (COUNTDOWN_C * (1 - frac)).toFixed(2));
      if (txt) txt.textContent = (remain / 1000).toFixed(1) + 's';
      if (ring) ring.setAttribute('class', cmd.status === 'violating' ? 'danger' : (remain < 1000 ? 'warn' : ''));
    } else {
      if (val) val.setAttribute('stroke-dashoffset', COUNTDOWN_C.toFixed(2));
      if (txt) txt.textContent = '--';
      if (ring) ring.setAttribute('class', '');
    }
  }

  function renderEnergy(s) {
    var motion = s.motion || {};
    var energy = clamp(Number(motion.energy) || 0, 0, 1);
    var active = Math.round(energy * 12);
    $$('#energyTrack .energy-seg').forEach(function (el, i) { el.classList.toggle('on', i < active); });
    var box = $('#energy');
    if (box) box.classList.toggle('moving', !!motion.moving);
    var pct = $('#energyPct');
    if (pct) pct.textContent = Math.round(energy * 100) + '%';
    var st = $('#motionState');
    if (st) st.textContent = t(motion.moving ? '运动中' : '静止');
  }
  function renderLevel(s) {
    var max = Math.max(1, Math.round(Number(s.maxLevel) || 1));
    var lv = clamp(Math.round(Number(s.level) || 1), 1, max);
    if (ui.levelMax !== max) buildLevelSegs(max);
    var segs = $$('#levelSegs .seg');
    var count = segs.length || 1;
    segs.forEach(function (el, i) {
      var lo = Math.round(i * max / count) + 1;
      var hi = Math.round((i + 1) * max / count);
      el.classList.toggle('on', hi <= lv);
      el.classList.toggle('current', lv >= lo && lv <= hi);
    });
    var lt = $('#levelText');
    if (lt) lt.textContent = lv + ' / ' + max;
    var vt = $('#voltageText');
    if (vt) vt.textContent = (Number(s.voltage) || 0) + ' V';
    var st = $('#streakText');
    if (st) st.textContent = String(Number(s.compliantStreak) || 0);
  }

  function phaseLabel(s) {
    if (s.ended) return t('已结束');
    if (s.paused) return t('已暂停');
    return t(PHASE_LABEL[s.phase] || s.phase || '-');
  }

  function renderTiles(s) {
    var stats = s.stats || {};
    var phase = phaseLabel(s);
    var phaseText = $('#phaseText');
    if (phaseText) {
      phaseText.textContent = phase;
      var pill = phaseText.closest('.pill');
      if (pill) {
        var tone = 'ok';
        if (s.ended || !s.running) tone = 'warn';
        else if (s.command && s.command.status === 'violating') tone = 'danger';
        else if (s.phase === 'CALIBRATING' || s.paused) tone = 'warn';
        pill.setAttribute('data-tone', tone);
      }
    }
    var tilePhase = $('#tilePhase');
    if (tilePhase) tilePhase.textContent = phase;
    var elapsed = Number(s.elapsedMs) || 0;
    var mission = $('#missionTime');
    if (mission) mission.textContent = fmtDuration(elapsed);
    var tileElapsed = $('#tileElapsed');
    if (tileElapsed) tileElapsed.textContent = fmtDuration(elapsed);
    var tileRemain = $('#tileRemain');
    if (tileRemain) tileRemain.textContent = s.remainingMs == null ? t('无限') : fmtDuration(s.remainingMs);
    var comp = $('#tileCompliance');
    if (comp) comp.innerHTML = String(Number(stats.compliance) || 0) + '<small>%</small>';
    var cmds = $('#tileCommands');
    if (cmds) cmds.textContent = String(Number(stats.commands) || 0);
    var viol = $('#tileViolations');
    if (viol) viol.textContent = String(Number(stats.violations) || 0);
    var shocks = $('#tileShocks');
    if (shocks) shocks.textContent = String(Number(stats.shocks) || 0);
    var online = !!s.sensorOnline;
    var sensor = $('#tileSensor');
    if (sensor) sensor.className = 'v ' + (online ? 'ok' : 'bad');
    var sensorText = $('#sensorText');
    if (sensorText) sensorText.textContent = t(online ? '在线' : '离线');
  }

  function fmtArr(v) {
    if (!v) return '--';
    if (Array.isArray(v)) return '[' + v.map(function (x) { return fmtNum(x, 2); }).join(', ') + ']';
    if (typeof v === 'object') return '[' + ['w', 'x', 'y', 'z'].map(function (k) { return fmtNum(v[k], 3); }).join(', ') + ']';
    return '--';
  }

  function renderAddon(s) {
    var addon = s.addon || {};
    var on = addon.mode === 1 || addon.mode === 2;
    var panel = $('#addonPanel');
    if (panel) panel.classList.toggle('show', on);
    if (!on) return;
    var p = Number(addon.pressure);
    var base = Number(addon.baseline);
    var target = Number(addon.target);
    var hasPressure = Number.isFinite(p);
    var scale = Math.max((Number.isFinite(target) ? target : 0) * 1.5, Number.isFinite(p) ? p * 1.1 : 0, Number.isFinite(base) ? base * 1.1 : 0, 1);
    var bad = addon.mode === 1 ? addon.ok === false : addon.edgingPhase === 'EDGING';
    var bar = $('#addonBar');
    if (bar) {
      bar.style.width = hasPressure ? (clamp(p / scale, 0, 1) * 100).toFixed(1) + '%' : '0%';
      bar.classList.toggle('bad', !!bad);
    }
    var mark = $('#addonMark');
    if (mark) mark.style.left = Number.isFinite(target) ? (clamp(target / scale, 0, 1) * 100).toFixed(1) + '%' : '0%';
    var pr = $('#addonPressure');
    if (pr) pr.textContent = hasPressure ? fmtNum(p, 1) + ' kPa' : '--';
    var bl = $('#addonBaseline');
    if (bl) bl.textContent = Number.isFinite(base) ? fmtNum(base, 1) + ' kPa' : '--';
    var tg = $('#addonTarget');
    if (tg) tg.textContent = Number.isFinite(target) ? fmtNum(target, 1) + ' kPa' : '--';
    var state = '--';
    if (addon.mode === 1) state = addon.ok == null ? '--' : t(addon.ok ? '达标' : '不达标');
    else state = t(EDGING_LABEL[addon.edgingPhase] || '--');
    var ast = $('#addonState');
    if (ast) {
      ast.textContent = state;
      ast.style.color = bad ? 'var(--danger)' : (addon.ok === true ? 'var(--ok)' : '');
    }
  }
  function renderPrompt(s) {
    var banner = $('#promptBanner');
    var text = $('#promptText');
    var msg = '';
    if (!s) msg = t('等待宿主连接');
    else if (s.ended) msg = t('游戏结束') + ' · ' + t(END_LABEL[s.endReason] || '已停止');
    else if (s.paused) msg = t('已暂停');
    else if (s.prompt && PROMPT_TEXT[s.prompt.key]) msg = t(PROMPT_TEXT[s.prompt.key]);
    else if (s.phase === 'CALIBRATING') msg = t('校准中');
    else msg = t('等待指令');
    if (text) text.textContent = msg;
    if (banner) banner.classList.toggle('violating', !!(s && s.command && s.command.status === 'violating'));
  }

  function renderDir(s) {
    var panel = $('#dirPanel');
    if (!panel) return;
    panel.classList.remove('hidden');
    var raw = s.raw || {};
    var set = function (id, value) { var el = $('#' + id); if (el) el.textContent = value; };
    set('dtHeading', fmtDeg(s.heading));
    set('dtDelta', fmtSigned(s.headingDelta));
    var motion = s.motion || {};
    set('dtEnergy', fmtNum(motion.energy, 2));
    set('dtAccel', fmtNum(motion.accelStd, 2) + ' m/s²');
    set('dtGyro', fmtNum(motion.gyroMean, 1) + ' °/s');
    set('dtRaw', 'q ' + fmtArr(raw.quat) + ' | a ' + fmtArr(raw.accel) + ' | g ' + fmtArr(raw.gyro));
    var hint = $('#dirHint');
    if (hint) hint.textContent = s.ended ? t('已结束：显示最后一份快照的原始数据。') : t('左转时累计转角应增大；方向反了就打开「转向反向」。');
  }

  function renderSnapshot(s) {
    renderPrompt(s);
    renderCompass(s);
    renderEnergy(s);
    renderLevel(s);
    renderTiles(s);
    renderAddon(s);
    renderDir(s);
  }

  function renderNoSnapshot() {
    setConn('lost');
    var text = $('#promptText');
    if (text) text.textContent = t('连接中断，正在重连');
    var banner = $('#promptBanner');
    if (banner) banner.classList.remove('violating');
    updateControls(null);
  }

  function onSnapshot(status, snapshot) {
    if (bridge && bridge.mode === 'remote') {
      var ok = !status || status.authorized !== false;
      if (ok !== authorized) {
        authorized = ok;
        if (!ok) release();
      }
    }
    if (!snapshot) {
      lastSnapshot = null;
      renderNoSnapshot();
      return;
    }
    setConn('ok');
    snapAt = Date.now();
    var started = Number(snapshot.startedAtMs) || 0;
    if (started !== startedAtMs) {
      startedAtMs = started;
      lastPromptSeq = 0;
      lastShocks = 0;
      lastViolationAt = 0;
      shockBaseline = false;
      ui.cmdKey = '';
    }
    lastSnapshot = snapshot;
    voiceEnabled = snapshot.voiceEnabled !== false && !(snapshot.params && snapshot.params.voiceEnabled === false);
    voicePlayer.setEnabled(voiceEnabled);
    handleVoice(snapshot);
    handleShockFlash(snapshot);
    renderSnapshot(snapshot);
    updateControls(snapshot);
  }
  // ---- 操作 ----
  var HOLD_RESEND_MS = 400;
  var active = { cmd: '', source: '', key: '', pointerId: null, timer: null, seq: 0 };

  function send(action, payload) {
    if (!bridge || !authorized) return;
    try {
      var result = bridge.sendAction(action, payload || {});
      if (result && typeof result.catch === 'function') result.catch(function () {});
    } catch (_) {}
  }

  function setPressed(cmd, on) {
    $$('[data-cmd]').forEach(function (btn) {
      if (btn.getAttribute('data-cmd') === cmd) btn.classList.toggle('pressed', !!on);
    });
  }

  function press(cmd, source, key, pointerId) {
    if (!bridge || !authorized) return;
    if (!lastSnapshot || !lastSnapshot.running || lastSnapshot.ended) return;
    if (active.cmd) {
      if (active.cmd === cmd && active.source === source && active.pointerId === pointerId) return;
      release();
    }
    active.cmd = cmd;
    active.source = source;
    active.key = key || '';
    active.pointerId = pointerId == null ? null : pointerId;
    active.seq += 1;
    var seq = active.seq;
    send('press', { cmd: cmd, seq: seq });
    active.timer = setInterval(function () {
      if (active.cmd === cmd) send('press', { cmd: cmd, seq: seq });
    }, HOLD_RESEND_MS);
    setPressed(cmd, true);
  }

  function release() {
    if (!active.cmd) return;
    var cmd = active.cmd;
    if (active.timer) { clearInterval(active.timer); active.timer = null; }
    active.cmd = '';
    active.source = '';
    active.key = '';
    active.pointerId = null;
    setPressed(cmd, false);
    send('release', { cmd: cmd });
  }

  function updateControls(s) {
    var can = !!bridge && authorized;
    var running = !!s && !!s.running && !s.ended;
    if (!can || !running) { if (active.cmd) release(); }
    $$('[data-cmd]').forEach(function (btn) { btn.disabled = !can || !running; });
    var shock = $('#shockBtn');
    if (shock) {
      var readyAt = Number(s && s.manualShockReadyAtMs) || 0;
      shock.disabled = !can || !running || Date.now() < readyAt;
    }
    var pause = $('#pauseBtn');
    if (pause) {
      pause.disabled = !can || !running;
      pause.textContent = t(s && s.paused ? '继续' : '暂停');
    }
    var recal = $('#recalBtn');
    if (recal) recal.disabled = !can || !running;
  }

  function tickClocks() {
    var s = lastSnapshot;
    if (!s) return;
    var now = Date.now();
    var extra = s.running && !s.paused ? Math.max(0, now - snapAt) : 0;
    var elapsed = (Number(s.elapsedMs) || 0) + extra;
    var mission = $('#missionTime');
    if (mission) mission.textContent = fmtDuration(elapsed);
    var tileElapsed = $('#tileElapsed');
    if (tileElapsed) tileElapsed.textContent = fmtDuration(elapsed);
    var tileRemain = $('#tileRemain');
    if (tileRemain) tileRemain.textContent = s.remainingMs == null ? t('无限') : fmtDuration(Math.max(0, Number(s.remainingMs) - extra));
    renderCompass(s);
    var readyAt = Number(s.manualShockReadyAtMs) || 0;
    var left = Math.max(0, readyAt - now);
    var val = $('#shockValue');
    if (val) val.setAttribute('stroke-dashoffset', (SHOCK_C * (1 - clamp(left / 1000, 0, 1))).toFixed(2));
    var shock = $('#shockBtn');
    if (shock && s.running && !s.ended) shock.disabled = !(bridge && authorized) || left > 0;
  }
  function bindControls() {
    $$('[data-cmd]').forEach(function (btn) {
      var cmd = btn.getAttribute('data-cmd');
      btn.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        press(cmd, 'pointer', '', e.pointerId);
      });
      var up = function (e) {
        if (active.source === 'pointer' && active.pointerId === e.pointerId) release();
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('lostpointercapture', up);
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });

    var shock = $('#shockBtn');
    if (shock) {
      shock.addEventListener('click', function () {
        if (!shock.disabled) send('shock');
      });
    }
    var pause = $('#pauseBtn');
    if (pause) {
      pause.addEventListener('click', function () {
        if (!lastSnapshot) return;
        send(lastSnapshot.paused ? 'resume' : 'pause');
      });
    }
    var recal = $('#recalBtn');
    if (recal) {
      recal.addEventListener('click', function () { send('recalibrate'); });
    }

    var KEY_CMD = {
      KeyW: 'forward', ArrowUp: 'forward',
      KeyS: 'backward', ArrowDown: 'backward',
      KeyA: 'left', ArrowLeft: 'left',
      KeyD: 'right', ArrowRight: 'right'
    };
    function isTyping(target) {
      if (!target) return false;
      var tag = String(target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      return !!target.isContentEditable;
    }
    document.addEventListener('keydown', function (e) {
      if (e.repeat || isTyping(e.target)) return;
      if (e.code === 'Space') {
        // 焦点在按钮上时保留原生激活（Tab 键盘操作）
        if (e.target && String(e.target.tagName || '').toUpperCase() === 'BUTTON') return;
        e.preventDefault();
        var btn = $('#shockBtn');
        if (btn && !btn.disabled) send('shock');
        return;
      }
      var cmd = KEY_CMD[e.code];
      if (!cmd) return;
      e.preventDefault();
      if (active.source === 'key' && active.key === e.code) return;
      press(cmd, 'key', e.code, null);
    });
    document.addEventListener('keyup', function (e) {
      var cmd = KEY_CMD[e.code];
      if (!cmd) return;
      if (active.source === 'key' && active.key === e.code) release();
    });
    window.addEventListener('blur', release);
    window.addEventListener('pagehide', release);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) release();
    });
  }

  function boot() {
    buildCompassTicks();
    buildEnergy();
    buildLevelSegs(7);
    if (typeof GameI18n !== 'undefined' && GameI18n.apply) GameI18n.apply();
    var modeText = $('#modeText');
    if (modeText) modeText.textContent = mode ? String(mode).toUpperCase() : '--';
    setConn(bridge ? 'wait' : 'lost');
    bindControls();
    setInterval(tickClocks, 100);
    if (bridge) {
      bridge.onSnapshot(onSnapshot);
      bridge.start();
    } else {
      renderNoSnapshot();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
