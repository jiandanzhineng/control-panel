(function () {
  'use strict';
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/bridge';

  let ws = null;
  let readyResolve = null;
  let pending = new Map();
  let subCallbacks = new Map();
  let propCallbacks = new Map();
  let msgCallbacks = new Map();
  let systemLogCallbacks = [];
  let deviceMapData = {};
  let paramsData = {};
  let idCounter = 0;

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
      }));
    };
    ws.onmessage = function (evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch (_) { return; }
      if (msg.id && pending.has(msg.id)) {
        var p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
        return;
      }
      if (msg.event) handleEvent(msg);
    };
    ws.onclose = function (evt) {
      rejectPendingOnClose();
      if (evt && (evt.code === 1000 || evt.code === 4000)) return;
      setTimeout(connect, 2000);
    };
  }

  function handleEvent(msg) {
    switch (msg.event) {
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
      isMapped: function () {
        var ids = deviceMapData[logicalId];
        return Array.isArray(ids) ? ids.length > 0 : !!ids;
      },
    };
  }

  var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });

  window.DeviceAPI = {
    device: device,
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
    },
  };

  var metaEl = document.getElementById('game-manifest');
  if (metaEl) {
    try {
      var meta = JSON.parse(metaEl.textContent);
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
    if (dmStr) { deviceMapData = JSON.parse(decodeURIComponent(dmStr)); window.DeviceAPI.deviceMap = deviceMapData; }
    if (pStr) { var urlP = JSON.parse(decodeURIComponent(pStr)); Object.assign(paramsData, urlP); window.DeviceAPI.params = paramsData; }
  } catch (_) {}

  connect();
})();
