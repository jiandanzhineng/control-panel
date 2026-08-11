// 后端设备存储与状态管理（去除 Pinia，保留原功能）
const {
  deviceTypeMap,
  getDeviceTypeName,
  hasOperations,
  getDeviceTypeConfig
} = require('../config/deviceTypes');
const deviceRegistry = require('../devices/registry');
const fileStorage = require('../utils/fileStorage');
const logger = require('./logService');
const mqttClient = require('./mqttClientService');
const deviceConnections = require('./deviceConnectionService');
const nicknameService = require('./nicknameService');
const firmwareOtaService = require('./firmwareOtaService');

const state = {
  devices: [],
  selectedDeviceId: null,
  DEVICE_OFFLINE_TIMEOUT: 60000, // 60秒
  deviceTypeMap,
  offlineCheckInterval: null, // 离线检查定时器
  OFFLINE_CHECK_INTERVAL: 3000, // 3秒检查一次
  // 运行期数据变更回调（不持久化）
  dataChangeHandlers: [],
};

// ====== Getter 等价实现 ======
function getDeviceById(id) {
  return state.devices.find(device => device.id === id);
}

function connectedDevices() {
  return state.devices.filter(device => deviceConnections.getDeviceConnections(device.id).connections.length > 0);
}

function disconnectedDevices() {
  return state.devices.filter(device => deviceConnections.getDeviceConnections(device.id).connections.length === 0);
}

// ====== Actions 等价实现 ======
function initDeviceList() {
  const savedDevices = fileStorage.getItem('devices');
  if (savedDevices) {
    try {
      const parsed = JSON.parse(savedDevices);
      state.devices = Array.isArray(parsed) ? parsed.map((device) => ({
        id: device.id,
        name: device.name,
        type: device.type,
        connected: false,
        lastReport: device.lastReport || null,
        data: device.data || {},
      })) : [];
      // 检查已保存设备的离线状态
      checkDevicesOfflineStatus();
    } catch (error) {
      console.error('Failed to load devices from fileStorage:', error);
      state.devices = [];
    }
  }

  // 启动离线检查循环
  startOfflineCheck();
}

function addDevice(deviceData) {
  const newDevice = {
    id: deviceData.id,
    name: deviceData.name,
    type: deviceData.type,
    connected: false,
    lastReport: null,
    data: deviceData.data || {}
  };

  state.devices.push(newDevice);
  saveDevices();
}

async function disconnectDeviceConnections(deviceId) {
  const connections = deviceConnections.listConnectionRecords(deviceId);
  await Promise.allSettled(connections.map(async (connection) => {
    await connection.adapter.disconnect?.();
    deviceConnections.unregisterConnection(deviceId, connection.type, connection.adapter);
  }));
}

async function removeDevice(deviceId) {
  const index = state.devices.findIndex(device => device.id === deviceId);
  if (index !== -1) {
    await disconnectDeviceConnections(deviceId);
    state.devices.splice(index, 1);
    saveDevices();

    if (state.selectedDeviceId === deviceId) {
      state.selectedDeviceId = null;
    }
    emitDeviceListChange('removed', deviceId);
  }
}

async function clearAllDevices() {
  await Promise.all(state.devices.map((device) => disconnectDeviceConnections(device.id)));
  deviceConnections.clear();
  state.devices = [];
  state.selectedDeviceId = null;
  saveDevices();
  emitDeviceListChange('cleared');
}

function updateDeviceData(deviceId, data) {
  const device = getDeviceById(deviceId);
  if (!device) return;

  const prevData = device.data || {};
  const changes = {};
  let changed = false;

  const incoming = data || {};
  for (const [key, newVal] of Object.entries(incoming)) {
    const oldVal = prevData[key];
    if (!deepEqual(oldVal, newVal)) {
      changes[key] = { old: oldVal, new: newVal };
      changed = true;
    }
  }

  // 合并数据
  device.data = { ...prevData, ...incoming };
  device.lastReport = Date.now();
  refreshDeviceRuntimeState(device);
  saveDevices();

  // 若有差异则触发回调
  if (changed && state.dataChangeHandlers.length) {
    try {
      emitDeviceDataChange(device, changes, prevData, device.data);
    } catch (e) {
      logger.warn('Device', '触发数据变更回调失败');
    }
  }
}

function markDeviceOffline(deviceId) {
  const device = getDeviceById(deviceId);
  if (device && deviceConnections.hasConnection(deviceId, 'mqtt')) {
    deviceConnections.unregisterConnection(deviceId, 'mqtt');
    refreshDeviceRuntimeState(device);
    saveDevices();
    emitDeviceListChange('disconnected', deviceId);
    console.log(`设备 ${deviceId} 超过${state.DEVICE_OFFLINE_TIMEOUT/1000}秒未上报，已标记为离线`);
  }
}

function checkDevicesOfflineStatus() {
  const currentTime = Date.now();
  state.devices.forEach(device => {
    const mqtt = deviceConnections.listConnectionRecords(device.id)
      .find((connection) => connection.type === 'mqtt');
    if (mqtt && currentTime - mqtt.lastActivity > state.DEVICE_OFFLINE_TIMEOUT) {
      markDeviceOffline(device.id);
    }
  });
}

function startOfflineCheck() {
  if (state.offlineCheckInterval) {
    return; // 已经启动了
  }

  state.offlineCheckInterval = setInterval(() => {
    checkDevicesOfflineStatus();
  }, state.OFFLINE_CHECK_INTERVAL);

  console.log(`离线检查循环已启动，每${state.OFFLINE_CHECK_INTERVAL/1000}秒检查一次`);
}

function stopOfflineCheck() {
  if (state.offlineCheckInterval) {
    clearInterval(state.offlineCheckInterval);
    state.offlineCheckInterval = null;
    console.log('离线检查循环已停止');
  }
}

function selectDevice(deviceId) {
  state.selectedDeviceId = deviceId;
}

function saveDevices() {
  try {
    const persisted = state.devices.map((device) => ({
      id: device.id,
      name: device.name,
      type: device.type,
      lastReport: device.lastReport || null,
      data: device.data || {},
    }));
    fileStorage.setItem('devices', JSON.stringify(persisted));
  } catch (error) {
    console.error('Failed to save devices to fileStorage:', error);
  }
}

function cleanup() {
  stopOfflineCheck();
  deviceConnections.clear();
}

function refreshDeviceRuntimeState(device) {
  if (!device) return;
  const runtime = deviceConnections.getDeviceConnections(device.id);
  device.connected = runtime.connections.length > 0;
  // Compatibility for current BLE/front-end callers; new code uses
  // controlConnection and connections from toApiDevice().
  device.connectionType = runtime.controlConnection;
  device.controlConnection = runtime.controlConnection;
}

// ====== 数据变更回调机制 ======
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== 'object' || tb !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_) {
    return false;
  }
}

function onDeviceDataChange(handler) {
  if (typeof handler === 'function') {
    state.dataChangeHandlers.push(handler);
    logger.info('Device', '设备数据变更回调已注册');
  }
}

// 原始消息监听（供 Bridge 等订阅，覆盖真实 MQTT 与虚拟设备注入两条来源）
const rawMessageHandlers = [];
const deviceListChangeHandlers = [];

function onDeviceListChange(handler) {
  if (typeof handler !== 'function') return () => {};
  deviceListChangeHandlers.push(handler);
  return () => {
    const index = deviceListChangeHandlers.indexOf(handler);
    if (index >= 0) deviceListChangeHandlers.splice(index, 1);
  };
}

function emitDeviceListChange(reason, deviceId = null) {
  for (const handler of deviceListChangeHandlers) {
    try { handler({ reason, deviceId }); } catch (_) {}
  }
}

function onDeviceRawMessage(handler) {
  if (typeof handler === 'function') rawMessageHandlers.push(handler);
}
function emitRawMessage(deviceId, payload) {
  for (const h of rawMessageHandlers) {
    try { h({ deviceId, payload }); } catch (_) {}
  }
}

function emitDeviceDataChange(device, changes, prevData, nextData) {
  for (const fn of state.dataChangeHandlers) {
    try {
      fn({ deviceId: device.id, device, changes, prevData, nextData });
    } catch (e) {
      logger.warn('Device', '设备数据变更回调执行错误');
    }
  }
}

// 可选：提供只读快照（避免外部直接修改内部 state）
function getStateSnapshot() {
  return {
    devices: JSON.parse(JSON.stringify(state.devices)),
    selectedDeviceId: state.selectedDeviceId,
    DEVICE_OFFLINE_TIMEOUT: state.DEVICE_OFFLINE_TIMEOUT,
    OFFLINE_CHECK_INTERVAL: state.OFFLINE_CHECK_INTERVAL,
  };
}

async function handleDeviceMessage(message) {
  try {
    // 支持 mqttClientService 的回调对象：{ topic, payload, text, packet }
    const topic = message?.topic;
    if (typeof topic !== 'string') return;

    logger.info('Device', `收到MQTT消息 ${topic}`);

    // 检查是否是 dpub 设备主题格式: /dpub/XXXX
    const topicMatch = topic.match(/^\/dpub\/(.+)$/);
    if (!topicMatch) {
      // logger.debug('Device', '忽略非设备主题');
      return; // 不是设备topic，忽略
    }
    const deviceId = topicMatch[1];

    // 解析消息内容（优先使用 text，其次 payload Buffer）
    let payloadObj;
    const rawText = typeof message?.text === 'string' ? message.text : (message?.payload ? message.payload.toString('utf8') : '');
    logger.info('Device', `解析MQTT消息内容: ${rawText}`);
    try {
      payloadObj = JSON.parse(rawText);
    } catch (e) {
      logger.error('Device', `解析MQTT消息失败: ${e?.message || e}`);
      return;
    }

    // 检查设备是否已存在
    let device = getDeviceById(deviceId);

    if (!device) {
      // 设备不存在，自动添加（仅在 report 消息时添加）
      if (payloadObj.method === 'report') {
        const devType = payloadObj.device_type || 'base';
        const deviceData = {
          id: deviceId,
          name: `${getDeviceTypeName(devType)}-${String(deviceId).slice(-4)}`,
          type: devType,
        };
        addDevice(deviceData);
        logger.info('Device', '自动添加设备');
        device = getDeviceById(deviceId);
      } else {
        // 非 report 消息且设备不存在
        return;
      }
    }

    connectTransportDevice({
      id: deviceId,
      name: device.name,
      type: payloadObj.device_type || device.type,
      connectionType: 'mqtt',
      firmwareVersion: payloadObj.ver,
    }, {
      kind: 'mqtt',
      send: (outbound) => mqttClient.publish(`/drecv/${deviceId}`, outbound),
    });
    handleTransportMessage(deviceId, payloadObj, 'mqtt');
  } catch (error) {
    logger.error('Device', '处理设备消息失败');
  }
}
// ====== API 适配器与业务方法（供路由层调用） ======
function toApiDevice(device) {
  if (!device) return null;
  const last = device.lastReport ? new Date(device.lastReport).toISOString() : null;
  const nickname = nicknameService.getNickname(device.id);
  const runtime = deviceConnections.getDeviceConnections(device.id);
  return {
    id: device.id,
    name: device.name,
    nickname: nickname,
    type: device.type,
    connected: runtime.connections.length > 0,
    connectionType: runtime.controlConnection,
    controlConnection: runtime.controlConnection,
    connections: runtime.connections,
    lastReport: last,
    data: device.data || {},
  };
}

function listDevicesForApi() {
  return state.devices.map(d => toApiDevice(d));
}

function getDeviceForApi(id) {
  const dev = getDeviceById(id);
  return dev ? toApiDevice(dev) : null;
}

function updateDeviceMeta(id, patch = {}) {
  const dev = getDeviceById(id);
  if (!dev) return null;
  if (typeof patch.name === 'string') {
    dev.name = patch.name;
  }
  dev.lastReport = Date.now();
  saveDevices();
  return dev;
}

function sendDeviceMessage(id, message = {}) {
  const result = deviceConnections.send(id, message || {});
  if (result.result && typeof result.result.catch === 'function') {
    result.result.catch((error) => {
      logger.warn('Device', `异步设备写入失败: ${error?.message || error}`);
    });
  }
  if (result.connectionType === 'mqtt') result.topic = `/drecv/${id}`;
  delete result.result;
  return result;
}

async function sendDeviceMessageAndWait(id, message = {}) {
  const result = deviceConnections.send(id, message || {});
  await Promise.resolve(result.result);
  if (result.connectionType === 'mqtt') result.topic = `/drecv/${id}`;
  delete result.result;
  return result;
}

function notifyDeviceUpdate(id, patch = {}) {
  const payload = { method: 'update', ...patch };
  return sendDeviceMessage(id, payload);
}

function publishDeviceAction(id, action, payload = {}) {
  const message = { method: 'action', action, ...payload };
  return sendDeviceMessage(id, message);
}

function publishDeviceMessage(id, message = {}) {
  return sendDeviceMessage(id, message || {});
}

async function deleteDeviceById(id) {
  if (!getDeviceById(id)) return false;
  await removeDevice(id);
  return true;
}

async function clearDevices() {
  await clearAllDevices();
  return true;
}

function getDeviceTypesForApi() {
  return { ...state.deviceTypeMap };
}

// ====== 设备操作相关功能 ======
function devicePublishFn(deviceId, message) {
  return sendDeviceMessage(deviceId, message);
}

function deviceConnectionFingerprint(deviceId) {
  const device = getDeviceForApi(deviceId);
  if (!device) return '';
  return JSON.stringify({
    type: device.type,
    connected: device.connected,
    controlConnection: device.controlConnection,
    connections: (device.connections || []).map((connection) => connection.type).sort(),
  });
}

function connectTransportDevice(deviceData, transport) {
  if (!deviceData?.id || !deviceData?.type) {
    throw new TypeError('Transport device requires id and type');
  }
  if (!transport || typeof transport.send !== 'function') {
    throw new TypeError('Transport requires send(message)');
  }

  const kind = deviceData.connectionType || transport.kind;
  if (!kind) throw new TypeError('Transport device requires connectionType');

  const previousFingerprint = deviceConnectionFingerprint(deviceData.id);
  let device = getDeviceById(deviceData.id);
  if (!device) {
    addDevice({
      id: deviceData.id,
      name: deviceData.name || `${getDeviceTypeName(deviceData.type)}-${String(deviceData.id).slice(-4)}`,
      type: deviceData.type,
      connectionType: kind,
    });
    device = getDeviceById(deviceData.id);
  }

  deviceConnections.registerConnection(device.id, kind, transport, {
    firmwareVersion: deviceData.firmwareVersion,
    metadata: {
      ...(deviceData.transportMetadata || {}),
      ...(deviceData.portPath ? { portPath: deviceData.portPath } : {}),
      ...(deviceData.browserDeviceId ? { browserDeviceId: deviceData.browserDeviceId } : {}),
      ...(deviceData.legacyIdentity !== undefined ? { legacyIdentity: !!deviceData.legacyIdentity } : {}),
    },
  });
  device.name = deviceData.name || device.name;
  if (deviceData.type !== 'base' || !device.type || device.type === 'base') {
    device.type = deviceData.type;
  }
  device.lastReport = Date.now();
  refreshDeviceRuntimeState(device);
  updateDeviceData(device.id, deviceData.data || {});
  if (previousFingerprint !== deviceConnectionFingerprint(device.id)) {
    emitDeviceListChange('connected', device.id);
  }
  return toApiDevice(device);
}

function handleTransportProperty(deviceId, key, value, connectionType) {
  const device = getDeviceById(deviceId);
  if (!device || !deviceConnections.hasConnection(deviceId, connectionType)) return false;
  deviceConnections.touchConnection(deviceId, connectionType);
  updateDeviceData(deviceId, { [key]: value });
  return true;
}

function handleTransportMessage(deviceId, payload, connectionType) {
  const device = getDeviceById(deviceId);
  if (!device || !deviceConnections.hasConnection(deviceId, connectionType)
      || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }

  const previousType = device.type;
  if (payload.method === 'report' || payload.method === 'update') {
    if (payload.method === 'report' && typeof payload.device_type === 'string' && payload.device_type) {
      device.type = payload.device_type;
    }
    const update = { ...payload };
    delete update.method;
    if (typeof update.key === 'string' && Object.prototype.hasOwnProperty.call(update, 'value')) {
      updateDeviceData(deviceId, { [update.key]: update.value });
    } else {
      updateDeviceData(deviceId, update);
    }
  } else if (payload.method === 'ota_status') {
    firmwareOtaService.recordOtaStatus(deviceId, payload);
  }
  deviceConnections.touchConnection(deviceId, connectionType, {
    firmwareVersion: payload.ver,
  });
  device.lastReport = Date.now();
  refreshDeviceRuntimeState(device);
  saveDevices();
  emitRawMessage(deviceId, payload);
  if (device.type !== previousType) emitDeviceListChange('type-changed', deviceId);
  return true;
}

function disconnectTransportDevice(deviceId, connectionType) {
  const device = getDeviceById(deviceId);
  const removed = deviceConnections.unregisterConnection(deviceId, connectionType);
  if (!device || !removed) return false;
  refreshDeviceRuntimeState(device);
  device.lastReport = Date.now();
  saveDevices();
  emitDeviceListChange('disconnected', deviceId);
  return true;
}

function clearRuntimeTransports() {
  deviceConnections.clear();
  state.devices.forEach(refreshDeviceRuntimeState);
  emitDeviceListChange('runtime-cleared');
}

function setControlConnection(deviceId, connectionType) {
  const device = getDeviceById(deviceId);
  if (!device) {
    const error = new Error('设备不存在');
    error.code = 'DEVICE_NOT_FOUND';
    throw error;
  }
  deviceConnections.setControlConnection(deviceId, connectionType);
  refreshDeviceRuntimeState(device);
  emitDeviceListChange('control-connection-changed', deviceId);
  return toApiDevice(device);
}

function executeDeviceOperation(deviceId, operationKey, params = {}) {
  const device = getDeviceById(deviceId);
  if (!device) {
    const error = new Error('设备不存在');
    error.code = 'DEVICE_NOT_FOUND';
    throw error;
  }
  const deviceType = deviceRegistry.getDeviceType(device.type);
  try {
    deviceType.invokeOperation(deviceId, operationKey, params, devicePublishFn);
    return { success: true, message: '操作执行成功' };
  } catch (error) {
    const wrappedError = new Error(`操作执行失败: ${error.message}`);
    wrappedError.code = error.code || 'OPERATION_FAILED';
    throw wrappedError;
  }
}

async function executeDeviceOperationAndWait(deviceId, operationKey, params = {}) {
  const device = getDeviceById(deviceId);
  if (!device) {
    const error = new Error('设备不存在');
    error.code = 'DEVICE_NOT_FOUND';
    throw error;
  }
  const deviceType = deviceRegistry.getDeviceType(device.type);
  const pending = [];
  try {
    deviceType.invokeOperation(deviceId, operationKey, params, (id, message) => {
      pending.push(sendDeviceMessageAndWait(id, message));
      return message;
    });
    await Promise.all(pending);
    return { success: true, message: '操作执行成功' };
  } catch (error) {
    const wrappedError = new Error(`操作执行失败: ${error.message}`);
    wrappedError.code = error.code || 'OPERATION_FAILED';
    throw wrappedError;
  }
}

function invokeDeviceCapability(deviceId, capabilityKey, actionName, input = {}) {
  const device = getDeviceById(deviceId);
  if (!device) {
    const error = new Error('设备不存在');
    error.code = 'DEVICE_NOT_FOUND';
    throw error;
  }
  const deviceType = deviceRegistry.getDeviceType(device.type);
  deviceType.invokeCapability(deviceId, capabilityKey, actionName, input || {}, devicePublishFn);
  return { ok: true };
}

async function invokeDeviceCapabilityAndWait(deviceId, capabilityKey, actionName, input = {}) {
  const device = getDeviceById(deviceId);
  if (!device) {
    const error = new Error('设备不存在');
    error.code = 'DEVICE_NOT_FOUND';
    throw error;
  }
  const pending = [];
  const deviceType = deviceRegistry.getDeviceType(device.type);
  deviceType.invokeCapability(deviceId, capabilityKey, actionName, input || {}, (id, message) => {
    pending.push(sendDeviceMessageAndWait(id, message));
    return message;
  });
  await Promise.all(pending);
  return { ok: true };
}

function invokeDeviceClose(deviceId) {
  const device = getDeviceById(deviceId);
  if (!device) return;
  const deviceType = deviceRegistry.getDeviceType(device.type);
  try {
    deviceType.invokeClose(deviceId, devicePublishFn);
  } catch (_) {}
}

function stopExecutionDevice(deviceId) {
  const device = getDeviceById(deviceId);
  if (!device) {
    const error = new Error('设备不存在');
    error.code = 'DEVICE_NOT_FOUND';
    throw error;
  }

  const deviceType = deviceRegistry.getDeviceType(device.type);
  const capabilities = ['shock', 'strength'].filter((key) => deviceType.hasCapability(key));
  if (capabilities.length === 0) {
    return {
      deviceId,
      eligible: false,
      capabilities: [],
      commandSent: false,
      confirmed: false,
    };
  }

  const command = deviceType.invokeClose(deviceId, devicePublishFn);
  if (!command) {
    const error = new Error(`设备类型 ${device.type} 未定义执行输出复位`);
    error.code = 'DEVICE_STOP_NOT_SUPPORTED';
    throw error;
  }

  return {
    deviceId,
    eligible: true,
    capabilities,
    commandSent: true,
    confirmed: false,
    command,
  };
}

// 获取设备类型配置
function getDeviceTypeConfigForApi(type) {
  return getDeviceTypeConfig(type);
}

function deviceHasOperations(deviceId) {
  const device = getDeviceById(deviceId);
  return device ? hasOperations(device.type) : false;
}

function deviceHasCapabilities(deviceId, capabilities = []) {
  const device = getDeviceById(deviceId);
  return device ? deviceRegistry.hasCapabilities(device.type, capabilities) : false;
}

module.exports = {
  // 状态与快照
  state,
  getStateSnapshot,
  // Getter 对应
  getDeviceById,
  connectedDevices,
  disconnectedDevices,
  // Actions 对应
  initDeviceList,
  addDevice,
  removeDevice,
  clearAllDevices,
  updateDeviceData,
  markDeviceOffline,
  checkDevicesOfflineStatus,
  startOfflineCheck,
  stopOfflineCheck,
  selectDevice,
  saveDevices,
  cleanup,
  // 数据变更回调
  onDeviceDataChange,
  onDeviceRawMessage,
  onDeviceListChange,
  // 新增：MQTT消息处理
  handleDeviceMessage,
  connectTransportDevice,
  handleTransportProperty,
  handleTransportMessage,
  disconnectTransportDevice,
  clearRuntimeTransports,
  setControlConnection,
  // API 适配器与业务方法
  toApiDevice,
  listDevicesForApi,
  getDeviceForApi,
  updateDeviceMeta,
  notifyDeviceUpdate,
  publishDeviceAction,
  publishDeviceMessage,
  sendDeviceMessageAndWait,
  deleteDeviceById,
  clearDevices,
  getDeviceTypesForApi,
  // 设备操作和监控数据相关
  executeDeviceOperation,
  executeDeviceOperationAndWait,
  invokeDeviceCapability,
  invokeDeviceCapabilityAndWait,
  invokeDeviceClose,
  stopExecutionDevice,
  devicePublishFn,
  getDeviceTypeConfigForApi,
  deviceHasOperations,
  deviceHasCapabilities,
}
