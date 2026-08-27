const { WebSocketServer } = require('ws');
const deviceService = require('./deviceService');
const deviceRegistry = require('../devices/registry');
const { getCapabilityDefinition } = require('../devices/capabilities');
const logService = require('./logService');
const virtualDeviceService = require('./virtualDeviceService');
const { BRIDGE_INTERNAL_HEADER } = require('../constants/bridgeAccess');
const externalGameAccessService = require('./externalGameAccessService');
const browserDeviceGrantService = require('./browserDeviceGrantService');

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
    this.kind = config.kind || 'play';
    this.origin = config.origin || '';
    this.subscriptions = new Map();
    this.propertySubscriptions = new Map();
    this.valueSubscriptions = new Map();
    this.capabilityValueCache = new Map();
    this.messageSubscriptions = new Set();
    this.active = true;
    this.pendingCloseTimer = null;
    this.lastShockAt = 0;
    this.shockCount = 0;
    this.shockStopTimer = null;
    this.shockStopTargets = new Set();
  }

  send(data) {
    if (this.ws && this.ws.readyState === 1) {
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
    if (this.shockStopTimer) {
      clearTimeout(this.shockStopTimer);
      this.shockStopTimer = null;
    }
    this.subscriptions.clear();
    this.propertySubscriptions.clear();
    this.valueSubscriptions.clear();
    this.capabilityValueCache.clear();
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
      // 开发者放行开关：受信开发 origin（本地任意端口 / 白名单）免内部头直连。
      // 浏览器 WS 握手无法附加自定义头，故这里是外部本地游戏试玩的关键放行点。
      try {
        if (externalGameAccessService.isTrustedDevOrigin(origin)) return true;
      } catch (_) {}
      // 已通过 DeviceAPI 授权（electron 内置浏览器弹窗，当天有效）的 origin 受信。
      // 与 HTTP /api 侧 browserApiAccess 的 grant 放行对称：远程游戏页经授权后，
      // 其 WS 桥订阅（onValue/subscribeValue）才能建立，否则重量等能力值无法同步。
      try {
        if (browserDeviceGrantService.isGranted(origin)) return true;
      } catch (_) {}
      try {
        if (info.req.headers[BRIDGE_INTERNAL_HEADER] !== '1') return false;
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
        session.send({ id, result: invokeForSession(session, msg) });
        break;
      }

      case 'writeProps': {
        session.send({ id, result: writePropsForSession(session, msg) });
        break;
      }

      case 'operate': {
        session.send({ id, result: operateForSession(session, msg) });
        break;
      }

      case 'sendMessage': {
        session.send({ id, result: sendMessageForSession(session, msg) });
        break;
      }

      case 'read': {
        session.send({ id, result: readForSession(session, msg) });
        break;
      }

      case 'readValue': {
        session.send({ id, result: readValueForSession(session, msg) });
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

      case 'subscribeValue': {
        const valueKey = `${msg.deviceId}:${msg.capability}`;
        session.valueSubscriptions.set(valueKey, {
          logicalId: msg.deviceId,
          capability: msg.capability,
        });
        initializeCapabilityValueCache(session, msg.deviceId, msg.capability);
        session.send({ id, result: { ok: true } });
        break;
      }

      case 'unsubscribeValue': {
        const valueKey = `${msg.deviceId}:${msg.capability}`;
        session.valueSubscriptions.delete(valueKey);
        clearCapabilityValueCache(session, msg.deviceId, msg.capability);
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
        session.send({ id, result: listDevicesWithCapabilities() });
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
      checkCapabilityValueChanges(session, logicalId, deviceId, Object.keys(changes || {}));
    }
  }
}

function capabilityValueCacheKey(logicalId, capability, physicalId) {
  return `${logicalId}:${capability}:${physicalId}`;
}

function resolveCapabilityValueForDevice(physicalId, capability) {
  const dev = deviceService.getDeviceById(physicalId);
  if (!dev) return null;
  const deviceType = deviceRegistry.getDeviceType(dev.type);
  return deviceType.resolveCapabilityValue(capability, dev.data || {});
}

function initializeCapabilityValueCache(session, logicalId, capability) {
  for (const physicalId of resolvePhysicalIds(session, logicalId)) {
    const key = capabilityValueCacheKey(logicalId, capability, physicalId);
    session.capabilityValueCache.set(
      key,
      resolveCapabilityValueForDevice(physicalId, capability)
    );
  }
}

function clearCapabilityValueCache(session, logicalId, capability) {
  const prefix = `${logicalId}:${capability}:`;
  for (const key of session.capabilityValueCache.keys()) {
    if (key.startsWith(prefix)) session.capabilityValueCache.delete(key);
  }
}

function checkCapabilityValueChanges(session, logicalId, physicalId, changedProps) {
  const dev = deviceService.getDeviceById(physicalId);
  if (!dev) return;
  const deviceType = deviceRegistry.getDeviceType(dev.type);

  for (const sub of session.valueSubscriptions.values()) {
    if (sub.logicalId !== logicalId) continue;
    const watch = deviceType.getCapabilityValueWatch(sub.capability);
    if (!watch.some((prop) => changedProps.includes(prop))) continue;

    const key = capabilityValueCacheKey(logicalId, sub.capability, physicalId);
    const oldValue = session.capabilityValueCache.get(key);
    const value = deviceType.resolveCapabilityValue(sub.capability, dev.data || {});
    session.capabilityValueCache.set(key, value);
    if (Object.is(value, oldValue)) continue;

    session.send({
      event: 'capabilityValueChange',
      deviceId: logicalId,
      capability: sub.capability,
      value,
      oldValue,
      physicalId,
    });
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

function getCloneableTypeConfig(type) {
  try {
    return JSON.parse(JSON.stringify(deviceRegistry.getDeviceTypeConfig(type) || {}));
  } catch (_) {
    return {};
  }
}

function isYcyBridgeDevice(device) {
  return /^YCY_/.test(String(device?.type || ''))
    && (device.connections || []).some((connection) => (
      connection.type === 'brand' && connection.mode === 'bridge'
    ));
}

function getEffectiveCapabilities(device) {
  return isYcyBridgeDevice(device) ? [] : deviceRegistry.getDeviceCapabilities(device.type);
}

function getEffectiveTypeConfig(device) {
  const config = getCloneableTypeConfig(device.type);
  if (!isYcyBridgeDevice(device)) return config;
  // API-bridge 只接受玩法编号和全局停止；隐藏会生成原始 BLE 帧的能力/操作。
  return {
    ...config,
    capabilities: [],
    capabilityConfig: {},
    operations: (config.operations || []).filter((operation) => ['trigger', 'stop'].includes(operation.key)),
  };
}

function listDevicesWithCapabilities() {
  return deviceService.listDevicesForApi().map((d) => ({
    id: d.id,
    type: d.type,
    name: d.name,
    nickname: d.nickname,
    connected: d.connected,
    connectionType: d.connectionType,
    controlConnection: d.controlConnection,
    connections: d.connections || [],
    data: d.data || {},
    capabilities: getEffectiveCapabilities(d),
    typeConfig: getEffectiveTypeConfig(d),
  }));
}

function getAllDeviceMap() {
  const map = {};
  const devices = deviceService.listDevicesForApi();
  for (const device of devices) {
    map[device.id] = [device.id];
    const caps = getEffectiveCapabilities(device);
    if (caps.includes('shock') && !map.shock) map.shock = [device.id];
    if (caps.includes('strength') && !map.vibrator) map.vibrator = [device.id];
  }
  return map;
}

function resolvePhysicalIds(session, logicalOrPhysicalId) {
  const mapped = session.getPhysicalIds(logicalOrPhysicalId);
  if (mapped.length) return mapped;
  const direct = deviceService.getDeviceById(logicalOrPhysicalId);
  return direct ? [logicalOrPhysicalId] : [];
}

function requirePhysicalIds(session, logicalOrPhysicalId) {
  const physIds = resolvePhysicalIds(session, logicalOrPhysicalId);
  if (!physIds.length) {
    emitSystemLog(session, 'warn', `设备 ${logicalOrPhysicalId} 未映射或离线`);
    return [];
  }
  return physIds;
}

function ensureCapability(physId, capability) {
  const device = deviceService.getDeviceById(physId);
  if (!device) {
    const error = new Error('设备不存在');
    error.code = 'DEVICE_NOT_FOUND';
    throw error;
  }
  if (isYcyBridgeDevice(device) || !deviceRegistry.hasCapability(device.type, capability)) {
    const error = new Error(`设备 ${physId} 不支持能力 ${capability}`);
    error.code = 'CAPABILITY_NOT_SUPPORTED';
    throw error;
  }
  return device;
}

function invokeForSession(session, msg) {
  const physIds = requirePhysicalIds(session, msg.deviceId);
  if (!physIds.length) return null;
  if (msg.capability === 'shock' && msg.actionName === 'start') {
    const gate = checkShockSafetyGate(session);
    if (!gate.ok) {
      emitSystemLog(session, 'warn', gate.message);
      return { ok: false, skipped: true, reason: gate.reason };
    }
    // 无上限、无冷却：仅记录用于展示/日志，不参与拦截。
    session.lastShockAt = Date.now();
    session.shockCount += 1;
  }
  for (const physId of physIds) {
    ensureCapability(physId, msg.capability);
    const safeParams = sanitizeCapabilityInput(msg.capability, msg.actionName, msg.params || {});
    if (virtualDeviceService.isVirtualDevice(physId)) {
      virtualDeviceService.interceptCommand(physId, { action: 'invoke', capability: msg.capability, actionName: msg.actionName, params: safeParams });
    } else {
      deviceService.invokeDeviceCapability(physId, msg.capability, msg.actionName, safeParams);
    }
    scheduleShockAutoStop(session, physId, msg.capability, msg.actionName);
  }
  return { ok: true };
}

function writePropsForSession(session, msg) {
  const physIds = requirePhysicalIds(session, msg.deviceId);
  if (!physIds.length) return null;
  for (const physId of physIds) {
    if (virtualDeviceService.isVirtualDevice(physId)) {
      virtualDeviceService.interceptCommand(physId, { action: 'writeProps', props: msg.props });
    } else {
      deviceService.publishDeviceMessage(physId, { method: 'update', ...msg.props });
    }
  }
  return { ok: true };
}

function operateForSession(session, msg) {
  const physIds = requirePhysicalIds(session, msg.deviceId);
  if (!physIds.length) return null;
  for (const physId of physIds) {
    deviceService.executeDeviceOperation(physId, msg.operationKey, msg.params || {});
  }
  return { ok: true };
}

function sendMessageForSession(session, msg) {
  const physIds = requirePhysicalIds(session, msg.deviceId);
  if (!physIds.length) return null;
  for (const physId of physIds) {
    if (virtualDeviceService.isVirtualDevice(physId)) {
      virtualDeviceService.interceptCommand(physId, { action: 'sendMessage', msg: msg.msg });
    } else {
      deviceService.publishDeviceMessage(physId, msg.msg);
    }
  }
  return { ok: true };
}

function readForSession(session, msg) {
  const physIds = resolvePhysicalIds(session, msg.deviceId);
  return physIds.map((physId) => {
    const dev = deviceService.getDeviceById(physId);
    return dev?.data?.[msg.property] ?? null;
  });
}

function readValueForSession(session, msg) {
  const physIds = resolvePhysicalIds(session, msg.deviceId);
  return physIds.map((physId) => {
    ensureCapability(physId, msg.capability);
    return resolveCapabilityValueForDevice(physId, msg.capability);
  });
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
  const seenPhysicalIds = new Set();
  for (const [logicalId, ids] of logicalEntries) {
    const arr = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    for (const physId of arr) {
      if (seenPhysicalIds.has(physId)) continue;
      seenPhysicalIds.add(physId);
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
  const type = device?.type;
  // 某些类型的两个能力共用同一停止帧；只发一次，避免重复写入或覆盖状态。
  const duplicateStop = (capability) => (
    (capability === 'estim' && (type === 'DGLAB' || type === 'YCY_EMS') && resetCaps.has('shock'))
    || (capability === 'motors' && (type === 'YCY_TOY' || type === 'YCY_CUP') && resetCaps.has('strength'))
  );

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
    if (resetCaps.has('strength') && !duplicateStop('strength')) {
      if (virtualDeviceService.isVirtualDevice(physId)) {
        virtualDeviceService.interceptCommand(physId, { action: 'invoke', capability: 'strength', actionName: 'stop', params: {} });
      } else {
        deviceService.invokeDeviceCapability(physId, 'strength', 'stop', {});
      }
    }
  } catch (error) {
    emitSystemLog(session, 'warn', `复位强度设备失败: ${logicalId}`, { physId, error: error?.message || String(error) });
  }

  for (const capability of ['motors', 'estim', 'pump']) {
    if (!resetCaps.has(capability) || duplicateStop(capability)) continue;
    try {
      if (virtualDeviceService.isVirtualDevice(physId)) {
        virtualDeviceService.interceptCommand(physId, {
          action: 'invoke', capability, actionName: 'stop', params: {},
        });
      } else {
        deviceService.invokeDeviceCapability(physId, capability, 'stop', {});
      }
    } catch (error) {
      emitSystemLog(session, 'warn', `复位${capability}设备失败: ${logicalId}`, {
        physId,
        error: error?.message || String(error),
      });
    }
  }
}

function closeSession(session) {
  resetSessionDevices(session);
  removeSession(session);
}

function getOrCreateBrowserSession(origin) {
  const normalizedOrigin = String(origin || '');
  if (!normalizedOrigin) {
    const error = new Error('origin is required');
    error.code = 'ORIGIN_REQUIRED';
    throw error;
  }
  if (activeSession?.kind === 'browser' && activeSession.origin === normalizedOrigin) {
    return activeSession;
  }
  replaceActiveSession();
  const session = new GameSession(null, {
    kind: 'browser',
    origin: normalizedOrigin,
    deviceMap: getAllDeviceMap(),
    params: {},
  });
  sessions.set(session.id, session);
  activeSession = session;
  return session;
}

function ensureBrowserSession(origin) {
  const normalizedOrigin = String(origin || '');
  if (activeSession?.kind === 'browser' && activeSession.origin === normalizedOrigin) {
    activeSession.deviceMap = getAllDeviceMap();
    return activeSession;
  }
  return getOrCreateBrowserSession(normalizedOrigin);
}

function runBrowserCommand(origin, action, payload = {}) {
  if (action === 'getDevices') return listDevicesWithCapabilities();
  if (action === 'getDeviceMap') return getAllDeviceMap();

  const session = action === 'read' || action === 'readValue'
    ? new GameSession(null, {
      kind: 'browser-query',
      origin: String(origin || ''),
      deviceMap: getAllDeviceMap(),
      params: {},
    })
    : ensureBrowserSession(origin);
  const msg = {
    ...payload,
    action,
  };
  switch (action) {
    case 'invoke':
      return invokeForSession(session, msg);
    case 'writeProps':
      return writePropsForSession(session, msg);
    case 'operate':
      return operateForSession(session, msg);
    case 'sendMessage':
      return sendMessageForSession(session, msg);
    case 'read':
      return readForSession(session, msg);
    case 'readValue':
      return readValueForSession(session, msg);
    default: {
      const error = new Error(`Unknown browser device action: ${action}`);
      error.code = 'UNKNOWN_BROWSER_DEVICE_ACTION';
      throw error;
    }
  }
}

function exitBrowserOrigin(origin) {
  const normalizedOrigin = String(origin || '');
  if (activeSession?.kind === 'browser' && activeSession.origin === normalizedOrigin) {
    resetActiveSession('browser-origin-exit');
  }
  return { ok: true };
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

// 电击触发已改为无次数上限、无冷却延时。连续触发时以“最新一次触发”
// 为准重新计算结束时间（见 scheduleShockAutoStop 的重排逻辑），因此这里
// 不再做任何拦截，恒定放行。保留函数便于将来需要时再加安全阀。
function checkShockSafetyGate() {
  return { ok: true };
}

// 单会话只维护一个自动停止定时器。每次 start 都取消上一个定时器并按
// 最新触发时间重新排期，使得连续触发时电击结束时间 = 最后一次触发 + 时长，
// 而不会被更早那次触发的定时器提前 stop 打断。
function scheduleShockAutoStop(session, physId, capability, actionName) {
  if (capability !== 'shock' || actionName !== 'start') return;
  const duration = Math.min(10, Math.max(1, Number(session.params?.shockDuration) || 10));
  if (session.shockStopTimer) {
    clearTimeout(session.shockStopTimer);
    session.shockStopTimer = null;
  }
  session.shockStopTargets = session.shockStopTargets || new Set();
  session.shockStopTargets.add(physId);
  session.shockStopTimer = setTimeout(() => {
    session.shockStopTimer = null;
    if (!session.active) return;
    const targets = Array.from(session.shockStopTargets || []);
    session.shockStopTargets = new Set();
    for (const target of targets) {
      try {
        if (virtualDeviceService.isVirtualDevice(target)) {
          virtualDeviceService.interceptCommand(target, { action: 'invoke', capability: 'shock', actionName: 'stop', params: {} });
        } else {
          deviceService.invokeDeviceCapability(target, 'shock', 'stop', {});
        }
      } catch (_) {}
    }
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

module.exports = {
  init,
  getActiveSessions,
  closeSession,
  exitCurrent,
  resetActiveSession,
  runBrowserCommand,
  exitBrowserOrigin,
  getAllDeviceMap,
  listDevicesWithCapabilities,
};
