/* 连接策略：退避、是否该重连、哪些 error 是重连噪声。无 DOM / MQTT 依赖。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CunzhiConn = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEEPALIVE_SEC = 30;
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 15000;
  const CONNECT_TIMEOUT_MS = 8000;
  const SUBSCRIBE_RETRY_MS = 300;

  function mqttOptions(clientId) {
    return {
      clientId,
      clean: true,
      keepalive: KEEPALIVE_SEC,
      reconnectPeriod: 0,
      connectTimeout: CONNECT_TIMEOUT_MS,
      resubscribe: false,
    };
  }

  function makeClientId(deviceId) {
    return `vweb_${deviceId}_${Math.random().toString(16).slice(2, 8)}`;
  }

  function nextBackoff(attempt) {
    const n = Math.max(0, Number(attempt) || 0);
    return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * (2 ** n));
  }

  function shouldReconnect(flags) {
    return !!(flags && flags.wantConnected && !flags.userEnded);
  }

  function isReconnectNoise(err) {
    const msg = err && (err.message || String(err));
    if (!msg) return false;
    return /client disconnecting|Keepalive timeout|ECONNRESET|connection closed|WebSocket is closed/i.test(msg);
  }

  function canSubscribe(client) {
    return !!(client && client.connected && !client.disconnecting);
  }

  return {
    KEEPALIVE_SEC, RECONNECT_MIN_MS, RECONNECT_MAX_MS,
    CONNECT_TIMEOUT_MS, SUBSCRIBE_RETRY_MS,
    mqttOptions, makeClientId, nextBackoff,
    shouldReconnect, isReconnectNoise, canSubscribe,
  };
}));
