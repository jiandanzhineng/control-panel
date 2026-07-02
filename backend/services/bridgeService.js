const { WebSocketServer } = require('ws');
const deviceService = require('./deviceService');
const deviceRegistry = require('../devices/registry');
const { getCapabilityDefinition } = require('../devices/capabilities');
const logService = require('./logService');
const virtualDeviceService = require('./virtualDeviceService');

let wss = null;
const sessions = new Map();
let activeSession = null;
let pendingDisconnect = null;
const DISCONNECT_GRACE_MS = 60000;

function generateId() {
  return require('crypto').randomUUID();
}

class GameSession {
  constructor(ws, config) {
    this.ws = ws;
    this.id = generateId();
    this.deviceMap = config.deviceMap || {};
    this.params = config.params || {};
    this.subscriptions = new Map();
    this.propertySubscriptions = new Map();
    this.messageSubscriptions = new Set();
    this.active = true;
    this.pendingCloseTimer = null;
    this.lastShockAt = 0;
    this.shockCount = 0;
  }

  send(data) {
    if (this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(data));
    }
  }

  getPhysicalIds(logicalId) {
    const ids = this.deviceMap[logicalId];
    if (!ids) return [];
    return Array.isArray(ids) ? ids : [ids];
  }

  destroy() {
    this.active = false;
    if (this.pendingCloseTimer) {
      clearTimeout(this.pendingCloseTimer);
      this.pendingCloseTimer = null;
    }
    this.subscriptions.clear();
    this.propertySubscriptions.clear();
    this.messageSubscriptions.clear();
  }
}

function init(server) {
  wss = new WebSocketServer({
    server,
    path: '/bridge',
    // 只放行控制台同机来源（同 hostname，忽略端口）。外部游戏经 /games/proxy 同源化后
    // Origin 即控制台自身。无 Origin（原生客户端 / Electron）放行。
    // 注意：前端 dev/Electron 经代理转发时 changeOrigin 会改写 Host，故只比 hostname。
    verifyClient: (info) => {
      const origin = info.origin || info.req.headers.origin;
      if (!origin) return true;
      try {
        const originHost = new URL(origin).hostname;
        const hostHeader = info.req.headers.host || '';
        const reqHost = hostHeader.split(':')[0];
        const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
        if (localHosts.has(originHost) && localHosts.has(reqHost)) return true;
        return !!reqHost && originHost === reqHost;
      } catch (_) {
        return false;
      }
    },
  });

  wss.on('connection', (ws, req) => {
    let session = null;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!msg || !msg.action) return;

      if (msg.action === 'exitCurrent') {
        resetActiveSession('explicit-exit');
        ws.send(JSON.stringify({ id: msg.id, result: { ok: true } }));
        return;
      }

      if (!session && msg.action === 'init') {
        const config = {
          deviceMap: msg.deviceMap || {},
          params: msg.params || {},
        };
        if (pendingDisconnect && activeSession === pendingDisconnect && isSameSessionConfig(pendingDisconnect, config)) {
          removeSession(pendingDisconnect);
        } else {
          replaceActiveSession();
        }
        session = new GameSession(ws, {
          deviceMap: config.deviceMap,
          params: config.params,
        });
        sessions.set(session.id, session);
        activeSession = session;
        pendingDisconnect = null;
        session.send({ id: msg.id, result: { sessionId: session.id, ready: true } });
        return;
      }

      if (!session) {
        ws.send(JSON.stringify({ id: msg.id, error: 'Session not initialized' }));
        return;
      }

      handleMessage(session, msg);
    });

    ws.on('close', () => {
      if (session) {
        scheduleGracefulClose(session);
      }
    });
  });

  deviceService.onDeviceDataChange(handleDeviceDataChange);
  // 原始消息统一来源：真实 MQTT 与虚拟设备注入都经 deviceService.handleDeviceMessage 广播
  deviceService.onDeviceRawMessage(({ deviceId, payload }) => handleRawMessageForBridge(deviceId, payload));
}

function handleMessage(session, msg) {
  const { id, action } = msg;

  try {
    switch (action) {
      case 'invoke': {
        const physIds = session.getPhysicalIds(msg.deviceId);
        if (!physIds.length) {
          emitSystemLog(session, 'warn', `设备 ${msg.deviceId} 未映射或离线`);
          session.send({ id, result: null });
          return;
        }
        if (msg.capability === 'shock' && msg.actionName === 'start') {
          const gate = checkShockSafetyGate(session);
          if (!gate.ok) {
            emitSystemLog(session, 'warn', gate.message);
            session.send({ id, result: { ok: false, skipped: true, reason: gate.reason } });
            return;
          }
          session.lastShockAt = Date.now();
          session.shockCount += 1;
        }
        for (const physId of physIds) {
          const safeParams = sanitizeCapabilityInput(msg.capability, msg.actionName, msg.params || {});
          if (virtualDeviceService.isVirtualDevice(physId)) {
            virtualDeviceService.interceptCommand(physId, { action: 'invoke', capability: msg.capability, actionName: msg.actionName, params: safeParams });
          } else {
            deviceService.invokeDeviceCapability(physId, msg.capability, msg.actionName, safeParams);
          }
          scheduleShockAutoStop(session, physId, msg.capability, msg.actionName);
        }
        session.send({ id, result: { ok: true } });
        break;
      }

      case 'writeProps': {
        const physIds = session.getPhysicalIds(msg.deviceId);
        if (!physIds.length) {
          emitSystemLog(session, 'warn', `设备 ${msg.deviceId} 未映射或离线`);
          session.send({ id, result: null });
          return;
        }
        for (const physId of physIds) {
          if (virtualDeviceService.isVirtualDevice(physId)) {
            virtualDeviceService.interceptCommand(physId, { action: 'writeProps', props: msg.props });
          } else {
            deviceService.publishDeviceMessage(physId, { method: 'update', ...msg.props });
          }
        }
        session.send({ id, result: { ok: true } });
        break;
      }

      case 'sendMessage': {
        const physIds = session.getPhysicalIds(msg.deviceId);
        if (!physIds.length) {
          emitSystemLog(session, 'warn', `设备 ${msg.deviceId} 未映射或离线`);
          session.send({ id, result: null });
          return;
        }
        for (const physId of physIds) {
          if (virtualDeviceService.isVirtualDevice(physId)) {
            virtualDeviceService.interceptCommand(physId, { action: 'sendMessage', msg: msg.msg });
          } else {
            deviceService.publishDeviceMessage(physId, msg.msg);
          }
        }
        session.send({ id, result: { ok: true } });
        break;
      }

      case 'read': {
        const physIds = session.getPhysicalIds(msg.deviceId);
        const values = physIds.map((physId) => {
          const dev = deviceService.getDeviceById(physId);
          return dev?.data?.[msg.property] ?? null;
        });
        session.send({ id, result: values });
        break;
      }

      case 'subscribe': {
        const key = `${msg.deviceId}:${msg.capability}:${msg.event}`;
        session.subscriptions.set(key, { logicalId: msg.deviceId, capability: msg.capability, event: msg.event });
        session.send({ id, result: { ok: true } });
        break;
      }

      case 'unsubscribe': {
        const key = `${msg.deviceId}:${msg.capability}:${msg.event}`;
        session.subscriptions.delete(key);
        session.send({ id, result: { ok: true } });
        break;
      }

      case 'subscribeProperty': {
        const pKey = `${msg.deviceId}:${msg.property}`;
        session.propertySubscriptions.set(pKey, { logicalId: msg.deviceId, property: msg.property });
        session.send({ id, result: { ok: true } });
        break;
      }

      case 'unsubscribeProperty': {
        const pKey = `${msg.deviceId}:${msg.property}`;
        session.propertySubscriptions.delete(pKey);
        session.send({ id, result: { ok: true } });
        break;
      }

      case 'subscribeMessages': {
        session.messageSubscriptions.add(msg.deviceId);
        session.send({ id, result: { ok: true } });
        break;
      }

      case 'unsubscribeMessages': {
        session.messageSubscriptions.delete(msg.deviceId);
        session.send({ id, result: { ok: true } });
        break;
      }

      case 'getDevices': {
        const devices = deviceService.listDevicesForApi().map((d) => ({
          id: d.id, type: d.type,
          capabilities: deviceRegistry.getDeviceCapabilities(d.type),
          connected: d.connected,
        }));
        session.send({ id, result: devices });
        break;
      }

      case 'getDeviceMap': {
        session.send({ id, result: session.deviceMap });
        break;
      }

      case 'log': {
        logService.info('GameLog', `[${msg.level}] ${msg.message}`);
        break;
      }

      default:
        session.send({ id, error: `Unknown action: ${action}` });
    }
  } catch (e) {
    session.send({ id, error: e.message || String(e) });
  }
}

function handleDeviceDataChange(evt) {
  const { deviceId, changes } = evt;
  for (const session of sessions.values()) {
    if (!session.active) continue;
    const reverseMap = buildReverseMap(session.deviceMap);
    const logicalIds = reverseMap.get(deviceId);
    if (!logicalIds) continue;

    for (const logicalId of logicalIds) {
      for (const [prop, change] of Object.entries(changes || {})) {
        const pKey = `${logicalId}:${prop}`;
        if (session.propertySubscriptions.has(pKey)) {
          session.send({
            event: 'propertyChange',
            deviceId: logicalId,
            property: prop,
            value: change.new,
            oldValue: change.old,
            physicalId: deviceId,
          });
        }

        checkCapabilityEvents(session, logicalId, deviceId, 'prop', prop, change);
      }
    }
  }
}

function handleRawMessageForBridge(physicalId, payload) {
  if (!physicalId || !payload || typeof payload !== 'object') return;

  for (const session of sessions.values()) {
    if (!session.active) continue;
    const reverseMap = buildReverseMap(session.deviceMap);
    const logicalIds = reverseMap.get(physicalId);
    if (!logicalIds) continue;

    for (const logicalId of logicalIds) {
      if (session.messageSubscriptions.has(logicalId)) {
        session.send({
          event: 'deviceMessage',
          deviceId: logicalId,
          payload,
          physicalId,
        });
      }

      checkCapabilityEvents(session, logicalId, physicalId, 'msg', null, null, payload);
    }
  }
}

function checkCapabilityEvents(session, logicalId, physicalId, watchType, prop, change, msgPayload) {
  for (const [key, sub] of session.subscriptions) {
    if (sub.logicalId !== logicalId) continue;
    const cap = getCapabilityDefinition(sub.capability);
    if (!cap?.events?.[sub.event]) continue;
    const evDef = cap.events[sub.event];
    if (!evDef.watch) continue;

    for (const w of evDef.watch) {
      let matched = false;
      if (watchType === 'prop' && w.type === 'prop' && w.key === prop) {
        matched = true;
      }
      if (watchType === 'msg' && w.type === 'msg' && msgPayload) {
        if (matchMessage(w.match, msgPayload)) matched = true;
      }
      if (!matched) continue;

      const dev = deviceService.getDeviceById(physicalId);
      const data = {
        props: dev?.data || {},
        changed: prop || null,
        msg: msgPayload || null,
        physicalId,
      };
      if (typeof evDef.trigger === 'function' && !evDef.trigger(data)) continue;

      session.send({
        event: 'capabilityEvent',
        deviceId: logicalId,
        capability: sub.capability,
        eventName: sub.event,
        data,
      });
    }
  }
}

function matchMessage(match, payload) {
  if (!match || typeof match !== 'object') return false;
  for (const [k, v] of Object.entries(match)) {
    if (payload[k] !== v) return false;
  }
  return true;
}

function buildReverseMap(deviceMap) {
  const rev = new Map();
  for (const [logicalId, ids] of Object.entries(deviceMap || {})) {
    const arr = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    for (const id of arr) {
      if (!rev.has(id)) rev.set(id, new Set());
      rev.get(id).add(logicalId);
    }
  }
  return rev;
}

function replaceActiveSession() {
  if (!activeSession) return;
  resetSessionDevices(activeSession);
  try {
    if (activeSession.ws && activeSession.ws.readyState === 1) {
      activeSession.ws.close(4000, 'Replaced by a new play session');
    }
  } catch (_) {}
  removeSession(activeSession);
}

function isSameSessionConfig(session, config) {
  try {
    return JSON.stringify(session.deviceMap || {}) === JSON.stringify(config.deviceMap || {})
      && JSON.stringify(session.params || {}) === JSON.stringify(config.params || {});
  } catch (_) {
    return false;
  }
}

function resetActiveSession(reason) {
  if (!activeSession) return;
  const session = activeSession;
  resetSessionDevices(session);
  try {
    if (session.ws && session.ws.readyState === 1) {
      session.ws.close(1000, reason || 'exit');
    }
  } catch (_) {}
  removeSession(session);
}

function scheduleGracefulClose(session) {
  if (!session.active) return;
  pendingDisconnect = session;
  if (session.pendingCloseTimer) clearTimeout(session.pendingCloseTimer);
  session.pendingCloseTimer = setTimeout(() => {
    if (!session.active) return;
    resetSessionDevices(session);
    removeSession(session);
  }, DISCONNECT_GRACE_MS);
}

function removeSession(session) {
  if (!session) return;
  session.destroy();
  sessions.delete(session.id);
  if (activeSession === session) activeSession = null;
  if (pendingDisconnect === session) pendingDisconnect = null;
}

function resetSessionDevices(session) {
  const logicalEntries = Object.entries(session.deviceMap || {});
  for (const [logicalId, ids] of logicalEntries) {
    const arr = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    for (const physId of arr) {
      resetPhysicalDevice(session, logicalId, physId);
    }
  }
}

function resetPhysicalDevice(session, logicalId, physId) {
  const manifestCapabilities = [];
  if (logicalId === 'shock') manifestCapabilities.push('shock');
  if (logicalId === 'vibrator') manifestCapabilities.push('strength');

  const device = deviceService.getDeviceById(physId);
  const caps = device ? deviceRegistry.getDeviceCapabilities(device.type) : manifestCapabilities;
  const resetCaps = new Set([
    ...manifestCapabilities,
    ...(Array.isArray(caps) ? caps : []),
  ]);

  try {
    if (resetCaps.has('shock')) {
      if (virtualDeviceService.isVirtualDevice(physId)) {
        virtualDeviceService.interceptCommand(physId, { action: 'invoke', capability: 'shock', actionName: 'stop', params: {} });
      } else {
        deviceService.invokeDeviceCapability(physId, 'shock', 'stop', {});
      }
    }
  } catch (error) {
    emitSystemLog(session, 'warn', `复位电击设备失败: ${logicalId}`, { physId, error: error?.message || String(error) });
  }

  try {
    if (resetCaps.has('strength')) {
      if (virtualDeviceService.isVirtualDevice(physId)) {
        virtualDeviceService.interceptCommand(physId, { action: 'invoke', capability: 'strength', actionName: 'stop', params: {} });
      } else {
        deviceService.invokeDeviceCapability(physId, 'strength', 'stop', {});
      }
    }
  } catch (error) {
    emitSystemLog(session, 'warn', `复位强度设备失败: ${logicalId}`, { physId, error: error?.message || String(error) });
  }
}

function closeSession(session) {
  resetSessionDevices(session);
  removeSession(session);
}

function sanitizeCapabilityInput(capability, actionName, params = {}) {
  if (capability === 'shock' && actionName === 'start') {
    return {
      ...params,
      voltage: Math.min(100, Math.max(0, Number(params.voltage) || 0)),
    };
  }
  if (capability === 'strength' && actionName === 'set') {
    return {
      ...params,
      value: Math.min(255, Math.max(0, Number(params.value) || 0)),
    };
  }
  return params;
}

function checkShockSafetyGate(session) {
  const params = session.params || {};
  const now = Date.now();
  const cooldownMs = Math.max(500, Number(params.cooldownMs) || 0);
  const maxShocks = Number(params.maxShocks);
  if (Number.isFinite(maxShocks) && maxShocks > 0 && session.shockCount >= maxShocks) {
    return { ok: false, reason: 'maxShocks', message: '电击触发已达到当前会话上限' };
  }
  if (cooldownMs > 0 && now - session.lastShockAt < cooldownMs) {
    return { ok: false, reason: 'cooldown', message: '电击触发处于冷却期' };
  }
  return { ok: true };
}

function scheduleShockAutoStop(session, physId, capability, actionName) {
  if (capability !== 'shock' || actionName !== 'start') return;
  const duration = Math.min(10, Math.max(1, Number(session.params?.shockDuration) || 10));
  setTimeout(() => {
    if (!session.active) return;
    try {
      if (virtualDeviceService.isVirtualDevice(physId)) {
        virtualDeviceService.interceptCommand(physId, { action: 'invoke', capability: 'shock', actionName: 'stop', params: {} });
      } else {
        deviceService.invokeDeviceCapability(physId, 'shock', 'stop', {});
      }
    } catch (_) {}
  }, duration * 1000);
}

function emitSystemLog(session, level, message, meta) {
  session.send({ event: 'systemLog', level, message, meta: meta || {} });
}

function getActiveSessions() {
  return Array.from(sessions.values()).filter((s) => s.active);
}

function exitCurrent() {
  resetActiveSession('explicit-exit');
  return { ok: true };
}

module.exports = { init, getActiveSessions, closeSession, exitCurrent, resetActiveSession };
