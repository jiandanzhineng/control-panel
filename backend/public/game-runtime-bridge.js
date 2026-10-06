// 托管渲染桥（game-runtime-bridge）
// 游戏页面 URL 带 ?runtime=host|remote 时启用；不带时页面保持自驱动（DeviceAPI）原行为。
//   host:   订阅本机 /api/game-runtime/stream（SSE），命令走 /api/game-runtime/{action,params,stop}
//   remote: 订阅本机 /api/remote-game/stream（SSE），命令走 /api/remote-game/command
// 推送协议（见 docs/architecture/split-game-contract.md）：
//   event: snapshot  data: {rev, state}           进流首帧 / 重连 / 补全量
//   event: patch     data: {rev, baseRev, ops}    增量；ops 由 GameStatePatch.apply 落到 state
// state 就是同名 REST 接口的状态文档（host 是 /status，remote 是 /remote-game/status），
// 页面因此不需要区分两种来源。baseRev 对不上（丢包、乱序）时重开流补全量；
// SSE 不可用（旧后端、无 EventSource）时回落到轮询，行为与旧版一致。
// 页面只渲染快照、发送命令，不读取或控制设备；被控端与主控端加载同一页面。
(function () {
  'use strict';
  var mode = '';
  try {
    var q = new URLSearchParams(location.search);
    var m = q.get('runtime');
    if (m === 'host' || m === 'remote') mode = m;
  } catch (_) {}
  if (!mode) return;

  var POLL_MS = mode === 'host' ? 500 : 1000;
  var STREAM_URL = mode === 'host' ? '/api/game-runtime/stream' : '/api/remote-game/stream';
  var STATUS_URL = mode === 'host' ? '/api/game-runtime/status' : '/api/remote-game/status';
  var PATCH_URL = '/bridge-api/game-state-patch.js';
  var STREAM_RETRY_MS = 5000;
  var REMOTE_COMMANDS = {
    pause: 'game.pause',
    resume: 'game.resume',
    stop: 'game.stop',
  };
  var listeners = [];
  var source = null;
  var pollTimer = null;
  var retryTimer = null;
  var started = false;
  var rev = 0;
  var lastStatus = null;
  var lastSnapshot = null;
  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](lastStatus, lastSnapshot); } catch (_) {}
    }
  }

  // 状态文档更新：state 里的 snapshot 才是页面真正渲染的东西，status 只是外壳
  function applyState(state) {
    if (!state || typeof state !== 'object') return;
    lastStatus = state;
    lastSnapshot = state.snapshot || null;
    emit();
  }

  // state 是 /status 的整份文档，增量就落在这份文档上（与后端 diff 的路径一致）
  function streamState() {
    return lastStatus && typeof lastStatus === 'object' ? lastStatus : {};
  }

  function clearStream() {
    if (source && source.close) { try { source.close(); } catch (_) {} }
    source = null;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  // ---- 命令：写操作仍走 REST（本机后端），推送通道只负责画面 ----
  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw Object.assign(new Error((data && data.message) || ('请求失败 ' + res.status)), { code: data && data.code });
        return data;
      });
    });
  }

  function sendAction(name, payload) {
    if (mode === 'host') return post('/api/game-runtime/action', { action: name, payload: payload || {} });
    var type = REMOTE_COMMANDS[name] || 'game.action';
    var body = type === 'game.action'
      ? { type: type, payload: withGameSession({ action: name, payload: payload || {} }) }
      : { type: type, payload: withGameSession({}) };
    return post('/api/remote-game/command', body);
  }

  // 游戏控制命令必须带上当前 gameSessionId，宿主据此拒绝旧局命令
  function withGameSession(payload) {
    var out = payload || {};
    var sessionId = lastStatus && lastStatus.gameSessionId;
    if (sessionId) out.gameSessionId = sessionId;
    return out;
  }

  // ---- 回退：轮询（旧后端 / 无 EventSource / SSE 反复失败） ----
  function pollOnce() {
    return fetch(STATUS_URL, { cache: 'no-store' })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error('status ' + res.status);
          applyState(body || null);
        });
      })
      .catch(function () {
        lastStatus = null;
        lastSnapshot = null;
        emit(); // 连接中断：页面自行显示重连提示，不得停止游戏
      });
  }

  function startPolling() {
    if (pollTimer) return;
    pollOnce();
    pollTimer = setInterval(pollOnce, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ---- 推送：SSE（snapshot 首帧 + patch 增量，rev 断档就重开流补全量） ----
  function loadPatchLib() {
    if (window.GameStatePatch) return Promise.resolve(window.GameStatePatch);
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = PATCH_URL;
      el.onload = function () { window.GameStatePatch ? resolve(window.GameStatePatch) : reject(new Error('no patch lib')); };
      el.onerror = function () { reject(new Error('patch lib failed')); };
      document.head.appendChild(el);
    });
  }

  function onSnapshotFrame(event) {
    var data = {};
    try { data = JSON.parse(event.data); } catch (_) { return; }
    rev = Number(data.rev) || 0;
    applyState(data.state);
  }

  function onPatchFrame(event) {
    var data = {};
    try { data = JSON.parse(event.data); } catch (_) { return; }
    var lib = window.GameStatePatch;
    // 全量替换（op 上限兜底）也是合法 patch：baseRev 为 0 且 ops 只有根 set
    if (!lib || Number(data.baseRev) !== rev) return resync();
    var next = lib.apply(streamState(), data.ops || []);
    if (next == null) return resync();
    rev = Number(data.rev) || rev;
    applyState(next);
  }

  // 断档 / 坏帧：重开流拿一份全量，拿不到就回落到轮询
  function resync() {
    clearStream();
    openStream();
  }

  function onStreamFailed() {
    clearStream();
    if (!started) return;
    startPolling();
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (!started) return;
      stopPolling();
      openStream();
    }, STREAM_RETRY_MS);
  }

  function openStream() {
    if (!started || typeof EventSource !== 'function') { startPolling(); return; }
    try {
      source = new EventSource(STREAM_URL);
    } catch (_) {
      source = null;
      startPolling();
      return;
    }
    source.addEventListener('snapshot', onSnapshotFrame);
    source.addEventListener('patch', onPatchFrame);
    source.onerror = onStreamFailed;
  }

  window.GameRuntimeBridge = {
    mode: mode,
    // cb(status, snapshot)；快照/状态为 null 表示连接中断
    onSnapshot: function (cb) {
      listeners.push(cb);
      if (lastStatus || lastSnapshot) cb(lastStatus, lastSnapshot);
    },
    sendAction: sendAction,
    setParams: function (params) {
      if (mode === 'host') return post('/api/game-runtime/params', { params: params || {} });
      return post('/api/remote-game/command', { type: 'game.setParams', payload: withGameSession({ params: params || {} }) });
    },
    stop: function (reason) {
      if (mode === 'host') return post('/api/game-runtime/stop', { reason: reason || 'user_stop' });
      return post('/api/remote-game/command', { type: 'game.stop', payload: withGameSession({}) });
    },
    // 补一次全量：远程模式下发给被控端（白名单命令），本机直接重开流
    requestSnapshot: function () {
      if (mode === 'remote') return post('/api/remote-game/command', { type: 'game.snapshot.request', payload: withGameSession({}) });
      resync();
      return Promise.resolve(null);
    },
    start: function () {
      if (started) return;
      started = true;
      // 增量库先就位再开流，避免首帧 patch 因缺少 apply 而白跑一次补全量
      loadPatchLib().then(function () { openStream(); }, function () { startPolling(); });
    },
  };
})();
