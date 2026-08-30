/* device-control.js — 设备全局控制中心（control.html）。
 *
 * 在 Electron 内置浏览器中通过授权后的 DeviceAPI 工作：
 *   1. 检查 / 申请 DeviceAPI 授权
 *   2. 读取已接入设备及其类型配置
 *   3. 渲染设备卡片、实时读数和参数控件
 *   4. 所有控制动作统一走 DeviceAPI，不直接访问本机 /api/*
 */
(function () {
  'use strict';

  var POLL_MS = 2500;

  var devices = [];
  var deviceEls = {};
  var lastIdSignature = '';
  var pollTimer = null;
  var activeFilter = 'all';
  var query = '';
  var grantStatus = null;
  var deviceApi = window.DeviceAPI || null;
  function t(key, vars) {
    try { if (typeof window !== 'undefined' && window.SiteI18n && window.SiteI18n.t) return window.SiteI18n.t(key, vars); } catch (_) {}
    var text = key;
    if (vars) text = String(text).replace(/\{(\w+)\}/g, function (_, k) { return vars[k] == null ? '' : String(vars[k]); });
    return text;
  }

  function capControl() {
    return {
      strength: {
        name: t('capStrength'), kind: 'slider',
        action: 'set', param: 'value', min: 0, max: 255, step: 1, def: 0, unit: '',
        stops: [{ label: t('zero'), input: { value: 0 }, tone: 'ghost' }],
      },
      shock: {
        name: t('capShock'), kind: 'shock', maxSafe: 30,
        fields: [{ param: 'voltage', label: t('voltage'), min: 0, max: 100, step: 1, def: 24, unit: 'V' }],
        start: { label: t('startShock'), action: 'start', tone: 'danger' },
        stop: { label: t('stopShock'), action: 'stop', tone: 'ghost' },
      },
      lock: {
        name: t('capLock'), kind: 'buttons',
        actions: [
          { label: t('unlock'), action: 'setOpen', input: { open: true }, tone: 'primary' },
          { label: t('lock'), action: 'setOpen', input: { open: false }, tone: 'ghost' },
        ],
      },
      reporting: {
        name: t('capReporting'), kind: 'number',
        action: 'setReportDelay', param: 'ms', label: t('reportInterval'), min: 50, max: 60000, step: 50, def: 5000, unit: 'ms',
      },
      distance: {
        name: t('capDistance'), kind: 'form', action: 'configure',
        fields: [
          { param: 'lowBand', label: t('nearBand'), min: 0, max: 999999, step: 1, def: 20, unit: 'mm' },
          { param: 'highBand', label: t('farBand'), min: 0, max: 999999, step: 1, def: 80, unit: 'mm' },
          { param: 'reportDelayMs', label: t('reportInterval'), min: 0, max: 99999, step: 1, def: 200, unit: 'ms' },
        ],
      },
    };
  }
  var CAP_CONTROL = capControl();

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, tone) {
    var t = el('toast'); if (!t) return;
    t.textContent = msg;
    t.style.borderColor = tone === 'error' ? 'rgba(255,92,122,0.5)'
      : (tone === 'ok' ? 'rgba(56,214,138,0.5)' : 'var(--border-glow)');
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  function fmtAgo(ts) {
    if (!ts) return t('neverReported');
    var d = new Date(ts).getTime();
    var diff = Date.now() - d;
    if (isNaN(diff)) return t('neverReported');
    if (diff < 60000) return t('justNow');
    if (diff < 3600000) return t('minutesAgo', { n: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('hoursAgo', { n: Math.floor(diff / 3600000) });
    return new Date(ts).toLocaleString();
  }
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function hasDeviceApi() {
    return !!(deviceApi && typeof deviceApi.getGrantStatus === 'function' && typeof deviceApi.requestAccess === 'function');
  }

  function setConn(state, text) {
    var bar = el('conn-status');
    if (!bar) return;
    bar.className = 'conn-status ' + state;
    bar.innerHTML = '<span class="dot"></span> ' + esc(text);
  }

  function setAuthNote(state, html) {
    var note = el('auth-note');
    if (!note) return;
    note.className = 'auth-note ' + state;
    note.innerHTML = html;
  }

  function setActionButtons() {
    var requestBtn = el('request-auth');
    var revokeBtn = el('revoke-auth');
    var authorized = !!(grantStatus && grantStatus.granted);
    if (requestBtn) requestBtn.hidden = authorized || !hasDeviceApi();
    if (revokeBtn) revokeBtn.hidden = !authorized || !hasDeviceApi();
  }

  function clearGrid(messageHtml) {
    stopPolling();
    lastIdSignature = '';
    deviceEls = {};
    el('grid').innerHTML = '<div class="empty-state">' + messageHtml + '</div>';
  }

  async function refreshGrantStatus() {
    if (!hasDeviceApi()) {
      grantStatus = { granted: false, origin: '', missingApi: true };
      return grantStatus;
    }
    try {
      grantStatus = await deviceApi.getGrantStatus();
      return grantStatus;
    } catch (err) {
      grantStatus = { granted: false, origin: '', error: err && err.message ? err.message : String(err) };
      return grantStatus;
    }
  }

  function renderUnauthorizedState(reason) {
    setConn('error', t('unauthorized'));
    setAuthNote('warn',
      '<strong>' + t('pageUnauthorized') + '</strong>'
      + (reason ? '<br><span style="color:var(--text-dim);">' + esc(reason) + '</span>' : ''));
    clearGrid(
      '<p style="font-size:16px;margin-bottom:10px;color:var(--warn);">' + t('needPanelAuth') + '</p>'
      + '<p style="color:var(--text-soft);margin-bottom:16px;">' + t('afterAuth') + '</p>'
      + '<button class="btn btn-primary" id="retry-detect">' + t('requestGrant') + '</button>'
    );
    var retry = el('retry-detect');
    if (retry) retry.addEventListener('click', requestAccess);
  }

  function renderMissingApiState() {
    setConn('error', t('noDeviceApi'));
    setAuthNote('error',
      '<strong>' + t('notInPanel') + '</strong>');
    clearGrid(
      '<p style="font-size:16px;margin-bottom:10px;color:var(--warn);">' + t('needInPanel') + '</p>'
      + '<p style="color:var(--text-soft);">' + t('noDeviceApiHint') + '</p>'
    );
  }

  function onlineCount() { return devices.filter(function (d) { return d.connected; }).length; }

  function typeConfig(d) {
    return (d && d.typeConfig) || {};
  }

  function typeName(t, d) {
    var cfg = d && d.type === t ? typeConfig(d) : null;
    return (cfg && cfg.name) || t;
  }

  async function requestAccess() {
    if (!hasDeviceApi()) {
      renderMissingApiState();
      return;
    }
    try {
      setConn('searching', t('requestingAuth'));
      await deviceApi.requestAccess();
      toast(t('accessGranted'), 'ok');
      await loadAll();
    } catch (err) {
      var message = err && err.message ? err.message : String(err);
      toast(t('authFail', { msg: message }), 'error');
      await refreshGrantStatus();
      setActionButtons();
      renderUnauthorizedState(message);
    }
  }

  async function revokeAccess() {
    if (!hasDeviceApi() || !deviceApi.revokeAccess) return;
    try {
      await deviceApi.revokeAccess();
      toast(t('revoked'), 'ok');
    } catch (err) {
      toast(t('revokeFail', { msg: err && err.message ? err.message : err }), 'error');
    }
    await loadAll();
  }

  async function stopOriginSession() {
    if (!hasDeviceApi() || !deviceApi.stop) return;
    try {
      await deviceApi.stop();
      toast(t('sessionStopped'), 'ok');
    } catch (err) {
      toast(t('stopFail', { msg: err && err.message ? err.message : err }), 'error');
    }
  }

  async function loadAll() {
    stopPolling();
    setActionButtons();
    if (!hasDeviceApi()) {
      renderMissingApiState();
      return;
    }
    setConn('searching', t('checkingPageAuth'));
    var status = await refreshGrantStatus();
    setActionButtons();
    if (!status || !status.granted) {
      renderUnauthorizedState(status && status.error);
      return;
    }

    try {
      setConn('searching', t('grantedLoading'));
      setAuthNote('ok',
        '<strong>' + t('grantedNote') + '</strong>');
      devices = await deviceApi.getDevices();
      buildTypeFilter();
      renderGrid(true);
      setConn('ok', t('grantedOnline', { online: onlineCount(), total: devices.length }));
      startPolling();
    } catch (err) {
      var message = err && err.message ? err.message : String(err);
      setConn('error', t('loadFail', { msg: message }));
      setAuthNote('error', '<strong>' + t('loadFailNote', { msg: esc(message) }) + '</strong>');
      clearGrid('<p style="color:var(--warn);">' + t('cannotReadList') + '</p><p>' + esc(message) + '</p>');
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(refreshDevices, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function refreshDevices() {
    if (!hasDeviceApi() || !grantStatus || !grantStatus.granted) return;
    try {
      devices = await deviceApi.getDevices();
      var sig = devices.map(function (d) { return d.id; }).sort().join('|');
      if (sig !== lastIdSignature) {
        buildTypeFilter();
        renderGrid(true);
      } else {
        devices.forEach(updateLive);
        applyFiltering();
      }
      setConn('ok', t('grantedOnline', { online: onlineCount(), total: devices.length }));
    } catch (err) {
      setConn('error', t('refreshFail'));
    }
  }

  function buildTypeFilter() {
    var counts = {};
    devices.forEach(function (d) { counts[d.type] = (counts[d.type] || 0) + 1; });
    var html = '<span class="chip' + (activeFilter === 'all' ? ' active' : '') + '" data-filter="all">' + t('filterAll') + ' <i>' + devices.length + '</i></span>';
    html += '<span class="chip' + (activeFilter === 'online' ? ' active' : '') + '" data-filter="online">' + t('online') + ' <i>' + onlineCount() + '</i></span>';
    html += '<span class="chip' + (activeFilter === 'offline' ? ' active' : '') + '" data-filter="offline">' + t('offline') + ' <i>' + (devices.length - onlineCount()) + '</i></span>';
    Object.keys(counts).sort().forEach(function (t) {
      var device = devices.find(function (d) { return d.type === t; });
      html += '<span class="chip' + (activeFilter === t ? ' active' : '') + '" data-filter="' + esc(t) + '">' + esc(typeName(t, device)) + ' <i>' + counts[t] + '</i></span>';
    });
    var f = el('filters');
    f.innerHTML = html;
    f.querySelectorAll('.chip').forEach(function (c) {
      c.addEventListener('click', function () {
        activeFilter = c.getAttribute('data-filter');
        f.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('active'); });
        c.classList.add('active');
        applyFiltering();
      });
    });
  }

  function visibleDev(d) {
    if (activeFilter === 'online' && !d.connected) return false;
    if (activeFilter === 'offline' && d.connected) return false;
    if (activeFilter !== 'all' && activeFilter !== 'online' && activeFilter !== 'offline' && d.type !== activeFilter) return false;
    if (query) {
      var q = query.toLowerCase();
      var hay = (d.id + ' ' + (d.name || '') + ' ' + (d.nickname || '') + ' ' + d.type + ' ' + typeName(d.type, d)).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }

  function applyFiltering() {
    Object.keys(deviceEls).forEach(function (id) {
      var d = devices.find(function (x) { return x.id === id; });
      var node = deviceEls[id] && deviceEls[id].card;
      if (node) node.style.display = (!d || visibleDev(d)) ? '' : 'none';
    });
  }

  function renderGrid(full) {
    var grid = el('grid');
    if (full) {
      deviceEls = {};
      if (!devices.length) {
        grid.innerHTML = '<div class="empty-state">'
          + '<p style="font-size:16px;margin-bottom:8px;">' + t('noDevices') + '</p>'
          + '<p style="color:var(--text-soft);">' + t('connectFirst') + '</p>'
          + '</div>';
        lastIdSignature = '';
        return;
      }
      grid.innerHTML = devices.map(buildCard).join('');
      devices.forEach(function (d) {
        var card = grid.querySelector('[data-dev="' + cssEscape(d.id) + '"]');
        if (card) {
          deviceEls[d.id] = { card: card, monitor: {} };
          captureLiveEls(d, card);
          wireCard(d, card);
          updateLive(d);
        }
      });
      lastIdSignature = devices.map(function (d) { return d.id; }).sort().join('|');
    }
    applyFiltering();
  }

  function buildCard(d) {
    var cfg = typeConfig(d);
    var caps = cfg.capabilities || d.capabilities || [];
    var capBadges = caps.map(function (c) { return '<span class="badge">' + esc(capLabel(c, cfg)) + '</span>'; }).join('');
    var opsHtml = (cfg.operations || []).map(function (op) {
      return '<button class="btn btn-ghost op-btn" data-op="' + esc(op.key) + '">' + esc(op.name || op.key) + '</button>';
    }).join('');

    var mon = cfg.monitorData || [];
    var monHtml = mon.length
      ? '<div class="mon-row">' + mon.map(function (m) {
          return '<div class="mon-tile"><div class="mon-val" data-mon="' + esc(m.key) + '">--</div>'
            + '<div class="mon-name">' + esc(m.name) + (m.unit ? ' · ' + esc(m.unit) : '') + '</div></div>';
        }).join('') + '</div>'
      : '';

    var controlsHtml = caps.map(function (c) { return controlFor(c); }).filter(Boolean).join('');
    var controlsBox = controlsHtml
      ? '<div class="ctrl-section"><div class="ctrl-section-head">' + t('paramControl') + '</div>' + controlsHtml + '</div>'
      : '<div class="ctrl-section muted">' + t('noParams') + '</div>';

    var battery = (d.data && d.data.battery != null)
      ? '<span class="badge">' + t('battery', { n: esc(String(d.data.battery)) }) + '</span>' : '';

    return '<article class="dev-card' + (d.connected ? '' : ' offline') + '" data-dev="' + cssEscape(d.id) + '">'
      + '<div class="dev-head">'
        + '<span class="dev-status ' + (d.connected ? 'on' : 'off') + '" title="' + (d.connected ? t('online') : t('offline')) + '"></span>'
        + '<div class="dev-titles">'
          + '<div class="dev-name">' + esc(d.nickname || d.name || d.id) + '</div>'
          + '<div class="dev-sub"><span class="dev-type">' + esc(typeName(d.type, d)) + '</span> · <code class="dev-id">' + esc(d.id) + '</code></div>'
        + '</div>'
        + '<div class="dev-meta">' + battery + '<span class="dev-last" data-last>' + esc(fmtAgo(d.lastReport)) + '</span></div>'
      + '</div>'
      + '<div class="dev-caps">' + capBadges + '</div>'
      + (monHtml ? '<div class="ctrl-section"><div class="ctrl-section-head">' + t('liveData') + '</div>' + monHtml + '</div>' : '')
      + (opsHtml ? '<div class="op-row"><span class="op-label">' + t('quickOps') + '</span>' + opsHtml + '</div>' : '')
      + controlsBox
      + '<div class="dev-foot">'
        + '<button class="btn btn-ghost btn-sm dev-stop">' + t('stopZero') + '</button>'
        + '<button class="btn btn-ghost btn-sm dev-toggle-data">' + t('rawData') + '</button>'
      + '</div>'
      + '<pre class="dev-data-pre" hidden></pre>'
    + '</article>';
  }

  function capLabel(cap, cfg) {
    var capCfg = cfg && cfg.capabilityConfig && cfg.capabilityConfig[cap];
    return (capCfg && capCfg.name) || (CAP_CONTROL[cap] && CAP_CONTROL[cap].name) || cap;
  }

  function controlFor(cap) {
    var c = CAP_CONTROL[cap];
    if (!c) return '';
    if (c.kind === 'slider') {
      return '<div class="ctrl" data-cap="' + esc(cap) + '">'
        + '<div class="ctrl-head"><span class="ctrl-name">' + esc(c.name) + '</span>'
        + '<span class="ctrl-val" data-val>' + esc(String(c.def)) + '</span></div>'
        + '<div class="ctrl-row">'
          + '<input type="range" class="cap-range" min="' + c.min + '" max="' + c.max + '" step="' + c.step + '" value="' + c.def + '" '
          + 'data-cap="' + esc(cap) + '" data-action="' + esc(c.action) + '" data-param="' + esc(c.param) + '">'
          + '<button class="btn btn-primary btn-sm cap-apply" data-cap="' + esc(cap) + '" data-action="' + esc(c.action) + '" data-param="' + esc(c.param) + '">' + t('apply') + '</button>'
        + '</div>'
        + stopsHtml(cap, c.stops)
        + '</div>';
    }
    if (c.kind === 'shock') {
      var f = c.fields[0];
      return '<div class="ctrl" data-cap="' + esc(cap) + '">'
        + '<div class="ctrl-head"><span class="ctrl-name">' + esc(c.name) + '</span>'
        + '<span class="ctrl-hint">' + t('suggestSafe', { n: c.maxSafe }) + '</span></div>'
        + '<div class="ctrl-row">'
          + '<label class="cap-field-label">' + esc(f.label)
            + '<input type="number" class="cap-field" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + f.def + '" '
            + 'data-cap="' + esc(cap) + '" data-param="' + esc(f.param) + '"></label>'
          + '<span class="cap-unit">' + esc(f.unit || '') + '</span>'
        + '</div>'
        + '<div class="ctrl-row">'
          + '<button class="btn btn-danger btn-sm cap-action" data-cap="' + esc(cap) + '" data-action="' + esc(c.start.action) + '" data-collect="' + esc(f.param) + '">' + esc(c.start.label) + '</button>'
          + '<button class="btn btn-ghost btn-sm cap-action" data-cap="' + esc(cap) + '" data-action="' + esc(c.stop.action) + '">' + esc(c.stop.label) + '</button>'
        + '</div>'
        + '</div>';
    }
    if (c.kind === 'buttons') {
      var btns = c.actions.map(function (a) {
        return '<button class="btn btn-' + (a.tone === 'primary' ? 'primary' : 'ghost') + ' btn-sm cap-fixed" '
          + 'data-cap="' + esc(cap) + '" data-action="' + esc(a.action) + '" data-input=\'' + JSON.stringify(a.input) + '\'>' + esc(a.label) + '</button>';
      }).join('');
      return '<div class="ctrl" data-cap="' + esc(cap) + '"><div class="ctrl-head"><span class="ctrl-name">' + esc(c.name) + '</span></div><div class="ctrl-row">' + btns + '</div></div>';
    }
    if (c.kind === 'number') {
      return '<div class="ctrl" data-cap="' + esc(cap) + '">'
        + '<div class="ctrl-head"><span class="ctrl-name">' + esc(c.name) + '</span></div>'
        + '<div class="ctrl-row">'
          + '<label class="cap-field-label">' + esc(c.label)
            + '<input type="number" class="cap-field" min="' + c.min + '" max="' + c.max + '" step="' + c.step + '" value="' + c.def + '" '
            + 'data-cap="' + esc(cap) + '" data-param="' + esc(c.param) + '"></label>'
          + '<span class="cap-unit">' + esc(c.unit || '') + '</span>'
          + '<button class="btn btn-primary btn-sm cap-apply-field" data-cap="' + esc(cap) + '" data-action="' + esc(c.action) + '" data-param="' + esc(c.param) + '">' + t('apply') + '</button>'
        + '</div></div>';
    }
    if (c.kind === 'form') {
      var fields = c.fields.map(function (ff) {
        return '<label class="cap-field-label">' + esc(ff.label)
          + '<input type="number" class="cap-field" min="' + ff.min + '" max="' + ff.max + '" step="' + ff.step + '" value="' + ff.def + '" '
          + 'data-cap="' + esc(cap) + '" data-param="' + esc(ff.param) + '"></label>';
      }).join('');
      return '<div class="ctrl" data-cap="' + esc(cap) + '">'
        + '<div class="ctrl-head"><span class="ctrl-name">' + esc(c.name) + '</span></div>'
        + '<div class="ctrl-grid">' + fields + '</div>'
        + '<button class="btn btn-primary btn-sm cap-apply-form" data-cap="' + esc(cap) + '" data-action="' + esc(c.action) + '">' + t('applyConfig') + '</button>'
        + '</div>';
    }
    return '';
  }

  function stopsHtml(cap, stops) {
    if (!stops || !stops.length) return '';
    var btns = stops.map(function (s) {
      return '<button class="btn btn-' + (s.tone === 'primary' ? 'primary' : 'ghost') + ' btn-sm cap-fixed" '
        + 'data-cap="' + esc(cap) + '" data-action=\'' + esc(cap === 'strength' ? 'set' : '') + '\' data-input=\'' + JSON.stringify(s.input) + '\'>' + esc(s.label) + '</button>';
    }).join('');
    return '<div class="ctrl-row ctrl-stops">' + btns + '</div>';
  }

  function captureLiveEls(d, card) {
    deviceEls[d.id].monitor = {};
    card.querySelectorAll('[data-mon]').forEach(function (v) { deviceEls[d.id].monitor[v.getAttribute('data-mon')] = v; });
    deviceEls[d.id].last = card.querySelector('[data-last]');
    deviceEls[d.id].dataPre = card.querySelector('.dev-data-pre');
  }

  function updateLive(d) {
    var ref = deviceEls[d.id]; if (!ref) return;
    var data = d.data || {};
    Object.keys(ref.monitor).forEach(function (key) {
      var val = data[key];
      ref.monitor[key].textContent = (val === undefined || val === null) ? '--' : String(val);
    });
    if (ref.last) ref.last.textContent = fmtAgo(d.lastReport);
    if (ref.card) {
      ref.card.classList.toggle('offline', !d.connected);
      var dot = ref.card.querySelector('.dev-status');
      if (dot) { dot.className = 'dev-status ' + (d.connected ? 'on' : 'off'); }
    }
    if (ref.dataPre && !ref.dataPre.hidden) ref.dataPre.textContent = JSON.stringify(data, null, 2);
  }

  function fieldVal(card, cap, param) {
    var inp = card.querySelector('.cap-field[data-cap="' + cssEscape(cap) + '"][data-param="' + cssEscape(param) + '"]');
    if (!inp) return null;
    var n = Number(inp.value);
    return isNaN(n) ? null : n;
  }

  function collectForm(card, cap) {
    var input = {};
    card.querySelectorAll('.cap-field[data-cap="' + cssEscape(cap) + '"]').forEach(function (inp) {
      var n = Number(inp.value);
      if (!isNaN(n)) input[inp.getAttribute('data-param')] = n;
    });
    return input;
  }

  function getDeviceHandle(id) {
    return deviceApi && typeof deviceApi.device === 'function' ? deviceApi.device(id) : null;
  }

  function callCap(d, cap, action, input, btn) {
    var handle = getDeviceHandle(d.id);
    if (!handle || typeof handle.invoke !== 'function') {
      toast(t('cannotControl'), 'error');
      return Promise.resolve();
    }
    if (btn) btn.disabled = true;
    return Promise.resolve(handle.invoke(cap, action, input || {})).then(function () {
      toast(t('sentOk', { name: capLabel(cap, typeConfig(d)), action: action }), 'ok');
    }, function (err) {
      toast(t('actionFail', { name: capLabel(cap, typeConfig(d)), msg: err && err.message || err }), 'error');
    }).then(function () {
      if (btn) btn.disabled = false;
      return refreshDevices();
    });
  }

  function callOperation(d, opKey, params, btn) {
    var handle = getDeviceHandle(d.id);
    if (!handle || typeof handle.operate !== 'function') {
      toast(t('cannotOp'), 'error');
      return Promise.resolve();
    }
    if (btn) btn.disabled = true;
    return Promise.resolve(handle.operate(opKey, params || {})).then(function () {
      toast(t('opSent', { op: opKey }), 'ok');
    }, function (err) {
      toast(t('opFail', { msg: err && err.message || err }), 'error');
    }).then(function () {
      if (btn) btn.disabled = false;
      return refreshDevices();
    });
  }

  function wireCard(d, card) {
    card.querySelectorAll('.cap-range').forEach(function (r) {
      var cap = r.getAttribute('data-cap');
      var valBox = card.querySelector('.ctrl[data-cap="' + cssEscape(cap) + '"] [data-val]');
      r.addEventListener('input', function () { if (valBox) valBox.textContent = r.value; });
      r.addEventListener('change', function () {
        var v = Number(r.value);
        if (!isNaN(v)) callCap(d, cap, r.getAttribute('data-action'), { value: v });
      });
    });

    card.querySelectorAll('.cap-apply, .cap-apply-field').forEach(function (b) {
      b.addEventListener('click', function () {
        var cap = b.getAttribute('data-cap');
        var action = b.getAttribute('data-action');
        var param = b.getAttribute('data-param');
        var v = fieldVal(card, cap, param);
        if (v === null) return toast(t('enterNumber'), 'error');
        var input = {}; input[param] = v;
        callCap(d, cap, action, input, b);
      });
    });

    card.querySelectorAll('.cap-apply-form').forEach(function (b) {
      b.addEventListener('click', function () {
        var cap = b.getAttribute('data-cap');
        callCap(d, cap, b.getAttribute('data-action'), collectForm(card, cap), b);
      });
    });

    card.querySelectorAll('.cap-action').forEach(function (b) {
      b.addEventListener('click', function () {
        var cap = b.getAttribute('data-cap');
        var action = b.getAttribute('data-action');
        var collect = b.getAttribute('data-collect');
        var input = {};
        if (collect) {
          var v = fieldVal(card, cap, collect);
          if (v === null) return toast(t('enterNumber'), 'error');
          input[collect] = v;
          var maxSafe = CAP_CONTROL[cap] && CAP_CONTROL[cap].maxSafe;
          if (maxSafe && v > maxSafe && !window.confirm(t('overSafe', { name: capLabel(cap, typeConfig(d)), v: v, max: maxSafe }))) return;
        }
        callCap(d, cap, action, input, b);
      });
    });

    card.querySelectorAll('.cap-fixed').forEach(function (b) {
      b.addEventListener('click', function () {
        var cap = b.getAttribute('data-cap');
        var action = b.getAttribute('data-action') || (CAP_CONTROL[cap] && CAP_CONTROL[cap].action);
        var raw = b.getAttribute('data-input');
        var input = raw ? JSON.parse(raw) : {};
        callCap(d, cap, action, input, b);
      });
    });

    card.querySelectorAll('.op-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        callOperation(d, b.getAttribute('data-op'), {}, b);
      });
    });

    var stopBtn = card.querySelector('.dev-stop');
    if (stopBtn) stopBtn.addEventListener('click', function () { stopDevice(d, stopBtn); });

    var toggle = card.querySelector('.dev-toggle-data');
    if (toggle) toggle.addEventListener('click', function () {
      var pre = deviceEls[d.id] && deviceEls[d.id].dataPre;
      if (!pre) return;
      pre.hidden = !pre.hidden;
      if (!pre.hidden) pre.textContent = JSON.stringify(d.data || {}, null, 2);
    });
  }

  function stopDevice(d, btn) {
    var cfg = typeConfig(d);
    var caps = cfg.capabilities || d.capabilities || [];
    var has = function (c) { return caps.indexOf(c) >= 0; };
    var jobs = [];
    if ((cfg.operations || []).some(function (o) { return o.key === 'stop'; })) {
      jobs.push(callOperation(d, 'stop', {}, null));
    } else {
      if (has('shock')) jobs.push(callCap(d, 'shock', 'stop', {}, null));
      if (has('strength')) jobs.push(callCap(d, 'strength', 'set', { value: 0 }, null));
    }
    if (!jobs.length) return toast(t('noStopAction'), 'error');
    if (btn) btn.disabled = true;
    Promise.all(jobs).then(function () {
      toast(t('stoppedOk', { name: d.nickname || d.id }), 'ok');
    }, function (err) {
      toast(t('stopFail', { msg: err && err.message || err }), 'error');
    }).then(function () {
      if (btn) btn.disabled = false;
      refreshDevices();
    });
  }

  function emergencyStopAll() {
    if (!grantStatus || !grantStatus.granted) return toast(t('notGranted'), 'error');
    var targets = devices.filter(function (d) { return d.connected; });
    if (!targets.length) return toast(t('noOnlineDevices'), 'error');
    if (!window.confirm(t('confirmEstop', { n: targets.length }))) return;
    targets.forEach(function (d) { stopDevice(d); });
    toast(t('estopSent', { n: targets.length }), 'ok');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var search = el('search');
    if (search) search.addEventListener('input', function () { query = search.value.trim(); applyFiltering(); });

    var estop = el('estop');
    if (estop) estop.addEventListener('click', emergencyStopAll);

    var refresh = el('refresh');
    if (refresh) refresh.addEventListener('click', refreshDevices);

    var retry = el('retry-top');
    if (retry) retry.addEventListener('click', loadAll);

    var requestBtn = el('request-auth');
    if (requestBtn) requestBtn.addEventListener('click', requestAccess);

    var revokeBtn = el('revoke-auth');
    if (revokeBtn) revokeBtn.addEventListener('click', revokeAccess);

    document.addEventListener('site-locale-change', function () { CAP_CONTROL = capControl(); loadAll(); });
  loadAll();

    window.addEventListener('beforeunload', function () {
      stopPolling();
      stopOriginSession();
    });
  });
})();
