(function () {
  'use strict';
  // WS 目标以「本脚本被加载的来源」为准，而非页面 location。
  // 这样开发者把游戏跑在其它端口（如 localhost:8080）、脚本仍从后端
  // (127.0.0.1:5278/bridge-api/...) 加载时，WS 能正确连回后端而非游戏页端口。
  function resolveBridgeBase() {
    try {
      var src = document.currentScript && document.currentScript.src;
      if (src) {
        var u = new URL(src, location.href);
        return (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host;
      }
    } catch (_) {}
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  }
  const WS_URL = resolveBridgeBase() + '/bridge';

  let ws = null;
  let readyResolve = null;
  let pending = new Map();
  let subCallbacks = new Map();
  let propCallbacks = new Map();
  let valueCallbacks = new Map();
  let msgCallbacks = new Map();
  let systemLogCallbacks = [];
  let deviceMapData = {};
  let paramsData = {};
  let gameToken = '';
  let idCounter = 0;
  let commandState = null;
  let commandAudioLoading = null;

  function loadCommandAudio() {
    if (window.VocabCommandAudio) return Promise.resolve(window.VocabCommandAudio);
    if (!commandAudioLoading) commandAudioLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = WS_URL.replace(/^ws/, 'http').replace(/\/bridge$/, '/bridge-api/vocab-command-audio.js');
      script.onload = () => resolve(window.VocabCommandAudio);
      script.onerror = () => { commandAudioLoading = null; reject(new Error('KWS audio capture unavailable')); };
      document.head.appendChild(script);
    });
    return commandAudioLoading;
  }

  function closeCommandCapture() {
    const state = commandState;
    commandState = null;
    if (state) {
      state.closed = true;
      state.capture?.stop();
    }
    return state;
  }

  function createVocabCommands() {
    document.addEventListener('visibilitychange', async () => {
      const state = commandState;
      if (!state) return;
      state.suspended = document.hidden;
      if (state.suspended) {
        state.capture?.stop();
        sendFire({ action: 'speechCommandsUpdate', ...state.options, blockedUntil: Number.MAX_SAFE_INTEGER });
      } else {
        state.options.blockedUntil = Math.max(state.options.blockedUntil || 0, Date.now() + 300);
        sendFire({ action: 'speechCommandsUpdate', ...state.options });
        try {
          const Capture = await loadCommandAudio();
          if (commandState !== state || state.suspended) return;
          state.capture = new Capture(window);
          await state.capture.start(state.onFrame, state.onError);
        } catch (error) { state.onError(error); }
      }
    });
    return {
      status: () => sendRequest({ action: 'speechCommandsStatus' }),
      async start(options, callback) {
        const previous = closeCommandCapture();
        if (previous) sendFire({ action: 'speechCommandsStop', generation: previous.options.generation });
        const state = { options: { ...options }, callback, capture: null, closed: false, suspended: document.hidden };
        state.onFrame = audio => {
          if (commandState !== state || state.closed || state.suspended || Date.now() < state.options.blockedUntil) return;
          if (!ws || ws.readyState !== 1 || ws.bufferedAmount > 65536) return;
          sendFire({ action: 'speechCommandsAudio', generation: state.options.generation, seq: state.options.seq, audio });
        };
        state.onError = error => {
          if (commandState !== state) return;
          closeCommandCapture();
          sendFire({ action: 'speechCommandsStop', generation: state.options.generation });
          callback({ generation: state.options.generation, code: error?.name || 'MIC_UNAVAILABLE' });
        };
        commandState = state;
        try {
          const result = await sendRequest({ action: 'speechCommandsStart', ...state.options });
          if (commandState !== state || state.closed || !result?.ready) return { ready: false };
          const Capture = await loadCommandAudio();
          if (commandState !== state || state.closed) return { ready: false };
          if (state.suspended) return { ...result, ready: true };
          state.capture = new Capture(window);
          const ready = await state.capture.start(state.onFrame, state.onError);
          return { ...result, ready: (ready || state.suspended) && commandState === state && !state.closed };
        } catch (error) {
          state.capture?.stop();
          if (commandState === state) {
            closeCommandCapture();
            sendFire({ action: 'speechCommandsStop', generation: state.options.generation });
          }
          throw error;
        }
      },
      update(options) {
        if (!commandState || options.generation !== commandState.options.generation) return;
        Object.assign(commandState.options, options);
        sendFire({ action: 'speechCommandsUpdate', ...options,
          ...(commandState.suspended ? { blockedUntil: Number.MAX_SAFE_INTEGER } : {}) });
      },
      stop(generation) {
        if (!commandState || (generation != null && generation !== commandState.options.generation)) return Promise.resolve({ ok: true });
        const state = closeCommandCapture();
        return sendRequest({ action: 'speechCommandsStop', generation: state.options.generation });
      },
    };
  }

  function genId() { return 'req_' + (++idCounter) + '_' + Date.now(); }

  function sendRequest(data) {
    return new Promise((resolve, reject) => {
      const id = genId();
      data.id = id;
      pending.set(id, { resolve, reject });
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(data));
      } else {
        reject(new Error('Bridge not connected'));
      }
    });
  }

  function sendFire(data) {
    data.id = genId();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  function restoreSubscriptions() {
    subCallbacks.forEach(function (_callbacks, key) {
      var parts = key.split(':');
      if (parts.length < 3) return;
      sendFire({ action: 'subscribe', deviceId: parts[0], capability: parts[1], event: parts.slice(2).join(':') });
    });
    propCallbacks.forEach(function (_callbacks, key) {
      var idx = key.indexOf(':');
      if (idx < 0) return;
      sendFire({ action: 'subscribeProperty', deviceId: key.slice(0, idx), property: key.slice(idx + 1) });
    });
    valueCallbacks.forEach(function (_callbacks, key) {
      var idx = key.indexOf(':');
      if (idx < 0) return;
      sendFire({ action: 'subscribeValue', deviceId: key.slice(0, idx), capability: key.slice(idx + 1) });
    });
    msgCallbacks.forEach(function (_callbacks, logicalId) {
      sendFire({ action: 'subscribeMessages', deviceId: logicalId });
    });
  }

  function rejectPendingOnClose() {
    pending.forEach(function (p) {
      try { p.reject(new Error('Bridge disconnected')); } catch (_) {}
    });
    pending.clear();
  }

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = function () {
      var initId = genId();
      pending.set(initId, {
        resolve: function(r) {
          if (r && r.ready) {
            if (readyResolve) readyResolve();
            restoreSubscriptions();
          }
        },
        reject: function(){}
      });
      ws.send(JSON.stringify({
        id: initId,
        action: 'init',
        deviceMap: deviceMapData,
        params: paramsData,
        gameToken: gameToken,
      }));
    };
    ws.onmessage = function (evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch (_) { return; }
      if (msg.id && pending.has(msg.id)) {
        var p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          var err = new Error(msg.error);
          // 语音识别、云存档等动作需要保留错误码（NOT_SIGNED_IN / TIMEOUT / TOO_LARGE…）。
          if (msg.code) err.code = msg.code;
          // 云存档版本冲突时带回云端当前内容，页面合并后重试。
          if (msg.remote) err.remote = msg.remote;
          p.reject(err);
        } else p.resolve(msg.result);
        return;
      }
      if (msg.event) handleEvent(msg);
    };
    ws.onclose = function (evt) {
      rejectPendingOnClose();
      const stopped = closeCommandCapture();
      if (stopped) stopped.callback({ generation: stopped.options.generation, code: 'BRIDGE_DISCONNECTED' });
      if (evt && (evt.code === 1000 || evt.code === 4000)) return;
      setTimeout(connect, 2000);
    };
  }

  function handleEvent(msg) {
    switch (msg.event) {
      case 'speechCommand': {
        const state = commandState;
        const data = msg.data;
        if (state && !state.suspended && !state.closed && data && data.generation === state.options.generation && data.seq === state.options.seq
          && Date.now() >= state.options.blockedUntil) state.callback(data);
        break;
      }
      case 'capabilityEvent': {
        var key = msg.deviceId + ':' + msg.capability + ':' + msg.eventName;
        var cbs = subCallbacks.get(key);
        if (cbs) cbs.forEach(function (cb) { try { cb(msg.data); } catch (_) {} });
        break;
      }
      case 'propertyChange': {
        var pKey = msg.deviceId + ':' + msg.property;
        var pCbs = propCallbacks.get(pKey);
        if (pCbs) pCbs.forEach(function (cb) { try { cb(msg.value, msg.oldValue); } catch (_) {} });
        break;
      }
      case 'capabilityValueChange': {
        var vKey = msg.deviceId + ':' + msg.capability;
        var vCbs = valueCallbacks.get(vKey);
        if (vCbs) vCbs.forEach(function (cb) {
          try { cb(msg.value, msg.oldValue, msg.physicalId); } catch (_) {}
        });
        break;
      }
      case 'deviceMessage': {
        var mCbs = msgCallbacks.get(msg.deviceId);
        if (mCbs) mCbs.forEach(function (cb) { try { cb(msg.payload); } catch (_) {} });
        break;
      }
      case 'systemLog': {
        systemLogCallbacks.forEach(function (cb) { try { cb(msg); } catch (_) {} });
        break;
      }
    }
  }

  function device(logicalId) {
    return {
      invoke: function (capability, action, params) {
        return sendRequest({ action: 'invoke', deviceId: logicalId, capability: capability, actionName: action, params: params || {} });
      },
      writeProps: function (props) {
        return sendRequest({ action: 'writeProps', deviceId: logicalId, props: props });
      },
      sendMessage: function (msg) {
        return sendRequest({ action: 'sendMessage', deviceId: logicalId, msg: msg });
      },
      operate: function (operationKey, params) {
        return sendRequest({ action: 'operate', deviceId: logicalId, operationKey: operationKey, params: params || {} });
      },
      on: function (capability, event, callback) {
        var key = logicalId + ':' + capability + ':' + event;
        if (!subCallbacks.has(key)) subCallbacks.set(key, []);
        subCallbacks.get(key).push(callback);
        sendFire({ action: 'subscribe', deviceId: logicalId, capability: capability, event: event });
      },
      off: function (capability, event, callback) {
        var key = logicalId + ':' + capability + ':' + event;
        var arr = subCallbacks.get(key);
        if (arr) {
          var idx = arr.indexOf(callback);
          if (idx >= 0) arr.splice(idx, 1);
          if (!arr.length) {
            subCallbacks.delete(key);
            sendFire({ action: 'unsubscribe', deviceId: logicalId, capability: capability, event: event });
          }
        }
      },
      onProperty: function (property, callback) {
        var key = logicalId + ':' + property;
        if (!propCallbacks.has(key)) propCallbacks.set(key, []);
        propCallbacks.get(key).push(callback);
        sendFire({ action: 'subscribeProperty', deviceId: logicalId, property: property });
      },
      offProperty: function (property, callback) {
        var key = logicalId + ':' + property;
        var arr = propCallbacks.get(key);
        if (arr) {
          var idx = arr.indexOf(callback);
          if (idx >= 0) arr.splice(idx, 1);
          if (!arr.length) {
            propCallbacks.delete(key);
            sendFire({ action: 'unsubscribeProperty', deviceId: logicalId, property: property });
          }
        }
      },
      onValue: function (capability, callback) {
        var key = logicalId + ':' + capability;
        if (!valueCallbacks.has(key)) valueCallbacks.set(key, []);
        valueCallbacks.get(key).push(callback);
        sendFire({ action: 'subscribeValue', deviceId: logicalId, capability: capability });
      },
      offValue: function (capability, callback) {
        var key = logicalId + ':' + capability;
        var arr = valueCallbacks.get(key);
        if (arr) {
          var idx = arr.indexOf(callback);
          if (idx >= 0) arr.splice(idx, 1);
          if (!arr.length) {
            valueCallbacks.delete(key);
            sendFire({ action: 'unsubscribeValue', deviceId: logicalId, capability: capability });
          }
        }
      },
      onMessage: function (callback) {
        if (!msgCallbacks.has(logicalId)) msgCallbacks.set(logicalId, []);
        msgCallbacks.get(logicalId).push(callback);
        sendFire({ action: 'subscribeMessages', deviceId: logicalId });
      },
      offMessage: function (callback) {
        var arr = msgCallbacks.get(logicalId);
        if (arr) {
          var idx = arr.indexOf(callback);
          if (idx >= 0) arr.splice(idx, 1);
          if (!arr.length) {
            msgCallbacks.delete(logicalId);
            sendFire({ action: 'unsubscribeMessages', deviceId: logicalId });
          }
        }
      },
      read: function (property) {
        return sendRequest({ action: 'read', deviceId: logicalId, property: property });
      },
      readValue: function (capability) {
        return sendRequest({ action: 'readValue', deviceId: logicalId, capability: capability });
      },
      isMapped: function () {
        var ids = deviceMapData[logicalId];
        return Array.isArray(ids) ? ids.length > 0 : !!ids;
      },
    };
  }

  var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });

  window.DeviceAPI = {
    device: device,
    // 游戏用语音识别（朗读游戏等）。PC 宿主总有这块；手机旧版 App 没有，游戏要判存在性。
    // audio: 16kHz 单声道 WAV 的 base64（不带 data: 前缀）；
    // reject 的 Error 带 code：NOT_SIGNED_IN | NO_STT | TIMEOUT | RATE_LIMITED |
    // UPSTREAM_* | BAD_AUDIO。
    speech: {
      status: function () {
        return sendRequest({ action: 'speechStatus' });
      },
      transcribe: function (options) {
        var opts = options || {};
        return sendRequest({
          action: 'speechToText',
          audio: opts.audio,
          format: opts.format || 'wav',
          timeoutMs: opts.timeoutMs,
        });
      },
    },
    // 页面游戏云存档（背单词等）。gameId 由宿主按当前游戏决定，页面传不进来。
    // reject 的 Error 带 code：NOT_SIGNED_IN | VERSION_CONFLICT（err.remote = { data, version }）
    // | NETWORK | TOO_LARGE | BAD_GAME | BAD_DATA | UPSTREAM_<status>。
    cloud: {
      status: function () {
        return sendRequest({ action: 'cloudStatus' });
      },
      get: function () {
        return sendRequest({ action: 'cloudGet' });
      },
      put: function (data, baseVersion) {
        return sendRequest({ action: 'cloudPut', data: data, baseVersion: baseVersion });
      },
    },
    getDevices: function () { return sendRequest({ action: 'getDevices' }); },
    getDeviceMap: function () { return sendRequest({ action: 'getDeviceMap' }); },
    log: function (level, message, meta) { sendFire({ action: 'log', level: level, message: message, meta: meta }); },
    onSystemLog: function (cb) { systemLogCallbacks.push(cb); },
    offSystemLog: function (cb) {
      var idx = systemLogCallbacks.indexOf(cb);
      if (idx >= 0) systemLogCallbacks.splice(idx, 1);
    },
    params: paramsData,
    deviceMap: deviceMapData,
    locale: 'zh',
    localeTag: 'zh-CN',
    ready: readyPromise,
    _setConfig: function (cfg) {
      if (cfg.deviceMap) {
        deviceMapData = cfg.deviceMap;
        window.DeviceAPI.deviceMap = deviceMapData;
      }
      if (cfg.params) {
        paramsData = cfg.params;
        window.DeviceAPI.params = paramsData;
      }
      if (cfg.locale) {
        window.DeviceAPI.locale = cfg.locale === 'en' ? 'en' : 'zh';
        window.DeviceAPI.localeTag = cfg.localeTag || (window.DeviceAPI.locale === 'en' ? 'en-US' : 'zh-CN');
      }
    },
  };

  var metaEl = document.getElementById('game-manifest');
  if (metaEl) {
    try {
      var meta = JSON.parse(metaEl.textContent);
      if (meta.id === 'vocab-game') window.DeviceAPI.speech.commands = createVocabCommands();
      if (meta.params) {
        var defaults = {};
        meta.params.forEach(function (p) { if (p.key && p.default !== undefined) defaults[p.key] = p.default; });
        paramsData = defaults;
        window.DeviceAPI.params = paramsData;
      }
    } catch (_) {}
  }

  // Support URL query params: ?deviceMap=JSON&params=JSON
  try {
    var urlParams = new URLSearchParams(location.search);
    var dmStr = urlParams.get('deviceMap');
    var pStr = urlParams.get('params');
    var localeStr = urlParams.get('locale');
    var localeTagStr = urlParams.get('localeTag');
    // 令牌优先从 # 片段读（片段不会进服务器访问日志）；兼容旧的 query 传法。
    var hashParams = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
    var gameTokenStr = hashParams.get('gameToken') || urlParams.get('gameToken');
    if (gameTokenStr) gameToken = gameTokenStr;
    if (dmStr) { deviceMapData = JSON.parse(decodeURIComponent(dmStr)); window.DeviceAPI.deviceMap = deviceMapData; }
    if (pStr) { var urlP = JSON.parse(decodeURIComponent(pStr)); Object.assign(paramsData, urlP); window.DeviceAPI.params = paramsData; }
    if (localeStr) {
      window.DeviceAPI.locale = localeStr === 'en' ? 'en' : 'zh';
      window.DeviceAPI.localeTag = localeTagStr || (window.DeviceAPI.locale === 'en' ? 'en-US' : 'zh-CN');
    }
  } catch (_) {}

  window.addEventListener?.('pagehide', () => {
    const stopped = closeCommandCapture();
    if (stopped) sendFire({ action: 'speechCommandsStop', generation: stopped.options.generation });
  });

  connect();
})();
