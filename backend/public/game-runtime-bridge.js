// 托管渲染桥（game-runtime-bridge）
// 游戏页面 URL 带 ?runtime=host|remote 时启用；不带时页面保持自驱动（DeviceAPI）原行为。
//   host:   轮询本机 /api/game-runtime/status，命令走 /api/game-runtime/{action,params,stop}
//   remote: 轮询本机 /api/remote-game/status（取 snapshot），命令走 /api/remote-game/command
// 页面只渲染快照、发送命令，不读取或控制设备；A（被控端）与 B（主控端）加载同一页面。
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
  var REMOTE_COMMANDS = {
    pause: 'game.pause',
    resume: 'game.resume',
    stop: 'game.stop',
  };
  var listeners = [];
  var timer = null;
  var lastStatus = null;
  var lastSnapshot = null;

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](lastStatus, lastSnapshot); } catch (_) {}
    }
  }

  function pollOnce() {
    var url = mode === 'host' ? '/api/game-runtime/status' : '/api/remote-game/status';
    return fetch(url, { cache: 'no-store' })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error('status ' + res.status);
          lastStatus = body || null;
          lastSnapshot = (body && body.snapshot) || null;
          emit();
        });
      })
      .catch(function () {
        lastStatus = null;
        lastSnapshot = null;
        emit(); // 连接中断：页面自行显示重连提示，不得停止游戏
      });
  }

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
    var body = type === 'game.action' ? { type: type, payload: { action: name, payload: payload || {} } } : { type: type };
    return post('/api/remote-game/command', body);
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
      return post('/api/remote-game/command', { type: 'game.setParams', payload: { params: params || {} } });
    },
    stop: function (reason) {
      if (mode === 'host') return post('/api/game-runtime/stop', { reason: reason || 'user_stop' });
      return post('/api/remote-game/command', { type: 'game.stop' });
    },
    start: function () {
      if (timer) return;
      pollOnce();
      timer = setInterval(pollOnce, POLL_MS);
    },
  };
})();
