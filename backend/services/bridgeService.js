const { WebSocketServer } = require('ws');
const deviceService = require('./deviceService');
const deviceRegistry = require('../devices/registry');
const { getCapabilityDefinition } = require('../devices/capabilities');
const logService = require('./logService');
const virtualDeviceService = require('./virtualDeviceService');

let wss = null;
const sessions = new Map();

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

      if (!session && msg.action === 'init') {
        session = new GameSession(ws, {
          deviceMap: msg.deviceMap || {},
          params: msg.params || {},
        });
        sessions.set(session.id, session);
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
        closeSession(session);
        sessions.delete(session.id);
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
        for (const physId of physIds) {
          if (virtualDeviceService.isVirtualDevice(physId)) {
            virtualDeviceService.interceptCommand(physId, { action: 'invoke', capability: msg.capability, actionName: msg.actionName, params: msg.params || {} });
          } else {
            deviceService.invokeDeviceCapability(physId, msg.capability, msg.actionName, msg.params || {});
          }
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

function closeSession(session) {
  const allPhysIds = new Set();
  for (const ids of Object.values(session.deviceMap || {})) {
    const arr = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    arr.forEach((id) => allPhysIds.add(id));
  }
  for (const physId of allPhysIds) {
    deviceService.invokeDeviceClose(physId);
  }
  session.destroy();
}

function emitSystemLog(session, level, message, meta) {
  session.send({ event: 'systemLog', level, message, meta: meta || {} });
}

function getActiveSessions() {
  return Array.from(sessions.values()).filter((s) => s.active);
}

module.exports = { init, getActiveSessions, closeSession };
