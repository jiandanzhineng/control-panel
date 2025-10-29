const mqtt = require('mqtt');
const os = require('os');
const logger = require('../utils/logger');

/**
 * 单例 MQTT 客户端服务
 * - 自动连接到 mqtt://127.0.0.1:1883
 * - 支持订阅、发布、取消订阅
 * - 支持注册消息处理回调（多个）
 * - 具有重连与状态查询
 */

const BROKER_URL = process.env.MQTT_CLIENT_URL || 'mqtt://127.0.0.1:1883';
const CLIENT_ID = process.env.MQTT_CLIENT_ID || `fb-client-${os.hostname()}-${Date.now()}`;

let state = {
  client: null,
  connected: false,
  connecting: false,
  lastError: null,
  subscriptions: new Set(),
  handlers: [],
};

function init() {
  if (state.client) return state.client;

  const opts = {
    clientId: CLIENT_ID,
    clean: true,
    keepalive: 60,
    reconnectPeriod: 3000, // 自动重连周期
    connectTimeout: 8000,
  };

  logger.info('MQTT client init', { url: BROKER_URL, clientId: CLIENT_ID });
  const client = mqtt.connect(BROKER_URL, opts);
  state.client = client;
  state.connecting = true;

  client.on('connect', () => {
    state.connected = true;
    state.connecting = false;
    state.lastError = null;
    logger.info('MQTT client connected', { url: BROKER_URL });
    // 默认订阅：如果已有订阅，重新订阅；否则可选择订阅通配符
    if (state.subscriptions.size === 0) {
      trySubscribe('#'); // 可按需改为具体主题
    } else {
      for (const t of state.subscriptions) trySubscribe(t);
    }
  });

  client.on('reconnect', () => {
    state.connecting = true;
    logger.info('MQTT client reconnecting...', { url: BROKER_URL });
  });

  client.on('close', () => {
    state.connected = false;
    logger.warn('MQTT client connection closed');
  });

  client.on('error', (err) => {
    state.lastError = err?.message || String(err);
    logger.error('MQTT client error', state.lastError);
  });

  client.on('message', (topic, payload, packet) => {
    const text = safePayloadToString(payload);
    // 内部日志（截断以防过长）
    // logger.debug('MQTT message', { topic, payload: text.slice(0, 500) });
    // 调用用户注册的处理器
    for (const fn of state.handlers) {
      try { fn({ topic, payload, text, packet }); } catch (e) {
        logger.warn('MQTT handler error', e?.message || e);
      }
    }
  });

  return client;
}

function safePayloadToString(buf) {
  if (!buf) return '';
  try { return buf.toString('utf8'); } catch (_) { return ''; }
}

function trySubscribe(topic, qos = 0) {
  if (!state.client) return;
  state.client.subscribe(topic, { qos }, (err) => {
    if (err) {
      logger.warn('MQTT subscribe failed', { topic, err: err?.message || err });
    } else {
      state.subscriptions.add(topic);
      logger.info('MQTT subscribed', { topic, qos });
    }
  });
}

function subscribe(topic, qos = 0) { trySubscribe(topic, qos); }

function unsubscribe(topic) {
  if (!state.client) return;
  state.client.unsubscribe(topic, (err) => {
    if (err) {
      logger.warn('MQTT unsubscribe failed', { topic, err: err?.message || err });
    } else {
      state.subscriptions.delete(topic);
      logger.info('MQTT unsubscribed', { topic });
    }
  });
}

function publish(topic, message, options = { qos: 0, retain: false }) {
  if (!state.client) throw new Error('MQTT client not initialized');
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  state.client.publish(topic, payload, options, (err) => {
    if (err) {
      logger.warn('MQTT publish failed', { topic, err: err?.message || err });
    } else {
      logger.debug('MQTT publish ok', { topic });
    }
  });
}

function onMessage(handler) {
  if (typeof handler === 'function') {
    state.handlers.push(handler);
    logger.info('MQTT handler registered', { count: state.handlers.length });
  }
}

function status() {
  return {
    url: BROKER_URL,
    clientId: CLIENT_ID,
    connected: state.connected,
    connecting: state.connecting,
    subscriptions: Array.from(state.subscriptions),
    handlerCount: state.handlers.length,
    lastError: state.lastError || null,
  };
}

function disconnect() {
  if (!state.client) return;
  try { state.client.end(true); } catch (_) {}
  state.connected = false;
  state.connecting = false;
  logger.info('MQTT client disconnected');
}

module.exports = {
  init,
  subscribe,
  unsubscribe,
  publish,
  onMessage,
  status,
  disconnect,
};