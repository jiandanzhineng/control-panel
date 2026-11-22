// 全局事件流（A1）：seq + 环形缓冲 + 前缀过滤 + 同 key 节流。
// 供 GET /api/events/stream（SSE）与 /api/events/recent 使用。
// 发布方：deviceService（设备增删/上下线/data）、playCarrierBus（游戏启停）、
// gameHostService（状态）、remoteSessionService（会话模式/撤权）、clientControlService（客户端）。
const playCarrierBus = require('./playCarrierBus');

const RING_SIZE = 500;
const DEVICE_UPDATE_THROTTLE_MS = 200;
const GAME_STATE_THROTTLE_MS = 500;

let seq = 0;
let buffer = [];
const listeners = new Set();
// key → { type, payload, timer }
const throttled = new Map();
let carrierUnsub = null;
let gameHostUnsub = null;

function nowMs() {
  return Date.now();
}

function cloneEvent(event) {
  // 事件只读消费；浅拷贝避免订阅方改到环形缓冲里的对象
  return { ...event };
}

function matchesTypes(type, filters) {
  if (!Array.isArray(filters) || filters.length === 0) return true;
  const value = String(type || '');
  return filters.some((filter) => {
    const prefix = String(filter || '').trim();
    if (!prefix) return false;
    return value === prefix || value.startsWith(`${prefix}.`);
  });
}

function publish(type, payload = {}) {
  const event = { seq: ++seq, type, ts: nowMs(), ...(payload || {}) };
  buffer.push(event);
  if (buffer.length > RING_SIZE) buffer.splice(0, buffer.length - RING_SIZE);
  for (const listener of listeners) {
    try { listener(cloneEvent(event)); } catch (_) { /* 订阅方自己兜异常 */ }
  }
  return event;
}

function getSeq() {
  return seq;
}

function recent({ limit = 100, types = null } = {}) {
  const n = Math.max(0, Math.min(RING_SIZE, Number(limit) || 0));
  const rows = buffer.filter((event) => matchesTypes(event.type, types));
  return rows.slice(Math.max(0, rows.length - n)).map(cloneEvent);
}

function since(lastSeq) {
  const from = Number(lastSeq);
  if (!Number.isFinite(from) || from < 0) return [];
  return buffer.filter((event) => event.seq > from).map(cloneEvent);
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function flushKey(key) {
  const entry = throttled.get(key);
  if (!entry) return null;
  throttled.delete(key);
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  return publish(entry.type, entry.payload);
}

// 同 key 在 intervalMs 内只发一次；后续 payload 合并进待发事件（用于设备 data / 游戏状态）。
function publishThrottled(key, type, payload = {}, {
  intervalMs = DEVICE_UPDATE_THROTTLE_MS,
  merge = null,
} = {}) {
  const existing = throttled.get(key);
  if (existing) {
    existing.type = type;
    existing.payload = typeof merge === 'function'
      ? merge(existing.payload, payload || {})
      : { ...existing.payload, ...(payload || {}) };
    return null;
  }
  const entry = {
    type,
    payload: { ...(payload || {}) },
    timer: setTimeout(() => { flushKey(key); }, intervalMs),
  };
  if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
  throttled.set(key, entry);
  return entry;
}

function mergeDeviceUpdate(previous, next) {
  return {
    ...previous,
    ...next,
    changes: { ...(previous.changes || {}), ...(next.changes || {}) },
  };
}

/** 设备 data 变化：同设备 200ms 合并（changes 累加、data 取最新）。 */
function publishDeviceUpdated(deviceId, changes, data, intervalMs = DEVICE_UPDATE_THROTTLE_MS) {
  return publishThrottled(`device.updated:${deviceId}`, 'device.updated', {
    deviceId,
    changes: changes || {},
    data: data || {},
  }, { intervalMs, merge: mergeDeviceUpdate });
}

/** 立即发出所有待发节流事件（测试/关停用）。 */
function flushThrottled() {
  const keys = Array.from(throttled.keys());
  const events = [];
  for (const key of keys) {
    const event = flushKey(key);
    if (event) events.push(event);
  }
  return events;
}

/** 订阅玩法载体总线：HostRuntime 与 iframe（bridge）游戏启停都进事件流。 */
function attachGameCarrier() {
  if (carrierUnsub) return carrierUnsub;
  carrierUnsub = playCarrierBus.onPlayCarrierChange((event) => {
    if (!event || typeof event !== 'object') return;
    const gameId = event.gameId || null;
    if (event.action === 'start') {
      publish('game.started', {
        gameId,
        carrier: event.kind || null,
        source: event.source || 'local',
      });
      return;
    }
    if (event.action === 'exit') {
      publish('game.stopped', {
        gameId,
        carrier: event.kind || null,
        source: event.source || null,
        reason: event.reason || null,
      });
    }
  });
  return carrierUnsub;
}

/** 订阅 HostRuntime 状态：500ms 合并，只在不运行时也保留结束态。 */
function attachGameHost(gameHost) {
  if (!gameHost || typeof gameHost.subscribe !== 'function') return () => {};
  if (gameHostUnsub) return gameHostUnsub;
  gameHostUnsub = gameHost.subscribe((status) => {
    // 没有会话也没有结束态时不发空状态（启动时 subscribe 会立刻回一份 idle）
    if (!status?.running && !status?.ended && !status?.gameId) return;
    const running = !!status?.running;
    const ended = !!status?.ended;
    publishThrottled('game.state', 'game.state', {
      gameId: status?.gameId || status?.snapshot?.gameId || null,
      running,
      ended,
      paused: !!status?.snapshot?.paused,
      sessionId: status?.sessionId || null,
      runtimeMode: status?.runtimeMode || null,
      snapshot: status?.snapshot || null,
    }, {
      intervalMs: GAME_STATE_THROTTLE_MS,
      merge: (previous, next) => ({ ...previous, ...next }),
    });
  });
  return gameHostUnsub;
}

function _resetForTests() {
  for (const entry of throttled.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  throttled.clear();
  listeners.clear();
  buffer = [];
  seq = 0;
  if (carrierUnsub) { try { carrierUnsub(); } catch (_) {} carrierUnsub = null; }
  if (gameHostUnsub) { try { gameHostUnsub(); } catch (_) {} gameHostUnsub = null; }
  playCarrierBus.reset?.();
}

module.exports = {
  RING_SIZE,
  DEVICE_UPDATE_THROTTLE_MS,
  GAME_STATE_THROTTLE_MS,
  publish,
  publishThrottled,
  publishDeviceUpdated,
  flushThrottled,
  recent,
  since,
  subscribe,
  getSeq,
  matchesTypes,
  attachGameCarrier,
  attachGameHost,
  _resetForTests,
};
