const VALID_TRANSPORTS = new Set(['mqtt', 'serial', 'ble']);

const devices = new Map();

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireTransport(type) {
  if (!VALID_TRANSPORTS.has(type)) {
    throw createError('INVALID_TRANSPORT', `Unsupported device transport: ${type}`);
  }
}

function getOrCreateDevice(deviceId) {
  let entry = devices.get(deviceId);
  if (!entry) {
    entry = { controlConnection: null, connections: new Map() };
    devices.set(deviceId, entry);
  }
  return entry;
}

function registerConnection(deviceId, type, adapter, details = {}) {
  if (!deviceId) throw createError('DEVICE_ID_REQUIRED', 'Device id is required');
  requireTransport(type);
  if (!adapter || typeof adapter.send !== 'function') {
    throw createError('INVALID_TRANSPORT_ADAPTER', 'Transport adapter requires send(message)');
  }

  const now = Date.now();
  const device = getOrCreateDevice(deviceId);
  const existing = device.connections.get(type);
  const connection = {
    type,
    adapter,
    connectedAt: existing?.connectedAt || now,
    lastActivity: now,
    firmwareVersion: details.firmwareVersion ?? existing?.firmwareVersion ?? null,
    metadata: {
      ...(existing?.metadata || {}),
      ...(details.metadata || {}),
    },
  };
  device.connections.set(type, connection);

  // A newly discovered transport must never steal control from an existing one.
  if (!device.controlConnection) device.controlConnection = type;
  return getDeviceConnections(deviceId);
}

function touchConnection(deviceId, type, details = {}) {
  const connection = devices.get(deviceId)?.connections.get(type);
  if (!connection) return false;
  connection.lastActivity = Date.now();
  if (details.firmwareVersion !== undefined) {
    connection.firmwareVersion = details.firmwareVersion;
  }
  if (details.metadata) {
    connection.metadata = { ...connection.metadata, ...details.metadata };
  }
  return true;
}

function unregisterConnection(deviceId, type, adapter = null) {
  const device = devices.get(deviceId);
  const connection = device?.connections.get(type);
  if (!connection || (adapter && connection.adapter !== adapter)) return false;

  device.connections.delete(type);
  if (device.controlConnection === type) {
    const fallback = [...device.connections.values()]
      .sort((left, right) => left.connectedAt - right.connectedAt)[0];
    device.controlConnection = fallback?.type || null;
  }
  if (device.connections.size === 0) devices.delete(deviceId);
  return true;
}

function setControlConnection(deviceId, type) {
  requireTransport(type);
  const device = devices.get(deviceId);
  if (!device?.connections.has(type)) {
    throw createError('CONNECTION_NOT_AVAILABLE', `${type} connection is not online`);
  }
  device.controlConnection = type;
  return getDeviceConnections(deviceId);
}

function getControlConnection(deviceId) {
  const device = devices.get(deviceId);
  if (!device?.controlConnection) return null;
  return device.connections.get(device.controlConnection) || null;
}

function send(deviceId, message = {}) {
  const connection = getControlConnection(deviceId);
  if (!connection) {
    throw createError('DEVICE_OFFLINE', `Device ${deviceId} has no active connection`);
  }

  // Never retry on another transport: the command may have executed before a
  // transport reported an error.
  const result = connection.adapter.send(message);
  connection.lastActivity = Date.now();
  return {
    ok: true,
    connectionType: connection.type,
    controlConnection: connection.type,
    message,
    result,
  };
}

function hasConnection(deviceId, type) {
  return !!devices.get(deviceId)?.connections.has(type);
}

function listConnectionRecords(deviceId) {
  return [...(devices.get(deviceId)?.connections.values() || [])];
}

function toPublicConnection(connection) {
  return {
    ...connection.metadata,
    type: connection.type,
    connected: true,
    connectedAt: new Date(connection.connectedAt).toISOString(),
    lastActivity: new Date(connection.lastActivity).toISOString(),
    ...(connection.firmwareVersion ? { firmwareVersion: connection.firmwareVersion } : {}),
  };
}

function getDeviceConnections(deviceId) {
  const device = devices.get(deviceId);
  if (!device) return { controlConnection: null, connections: [] };
  return {
    controlConnection: device.controlConnection,
    connections: [...device.connections.values()]
      .sort((left, right) => left.connectedAt - right.connectedAt)
      .map(toPublicConnection),
  };
}

function clear() {
  devices.clear();
}

module.exports = {
  VALID_TRANSPORTS,
  registerConnection,
  touchConnection,
  unregisterConnection,
  setControlConnection,
  getControlConnection,
  getDeviceConnections,
  listConnectionRecords,
  hasConnection,
  send,
  clear,
};
