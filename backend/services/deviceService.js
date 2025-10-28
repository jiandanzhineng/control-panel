// 后端设备存储与状态管理（去除 Pinia，保留原功能）
const { deviceTypeMap, getDeviceTypeName } = require('../config/deviceTypes');
const fileStorage = require('../utils/fileStorage');
const logger = require('../utils/logger');
const mqttClient = require('./mqttClientService');

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
  return state.devices.filter(device => device.connected);
}

function disconnectedDevices() {
  return state.devices.filter(device => !device.connected);
}

// ====== Actions 等价实现 ======
function initDeviceList() {
  const savedDevices = fileStorage.getItem('devices');
  if (savedDevices) {
    try {
      state.devices = JSON.parse(savedDevices);
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
    data: {}
  };

  state.devices.push(newDevice);
  saveDevices();
}

function removeDevice(deviceId) {
  const index = state.devices.findIndex(device => device.id === deviceId);
  if (index !== -1) {
    state.devices.splice(index, 1);
    saveDevices();

    if (state.selectedDeviceId === deviceId) {
      state.selectedDeviceId = null;
    }
  }
}

function clearAllDevices() {
  state.devices = [];
  state.selectedDeviceId = null;
  saveDevices();
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
  if (!device.connected) {
    device.connected = true;
  }
  saveDevices();

  // 若有差异则触发回调
  if (changed && state.dataChangeHandlers.length) {
    try {
      emitDeviceDataChange(device, changes, prevData, device.data);
    } catch (e) {
      logger.warn('触发数据变更回调失败', e?.message || e);
    }
  }
}

function markDeviceOffline(deviceId) {
  const device = getDeviceById(deviceId);
  if (device && device.connected) {
    device.connected = false;
    saveDevices();
    console.log(`设备 ${deviceId} 超过${state.DEVICE_OFFLINE_TIMEOUT/1000}秒未上报，已标记为离线`);
  }
}

function checkDevicesOfflineStatus() {
  const currentTime = Date.now();
  state.devices.forEach(device => {
    if (device.connected && device.lastReport) {
      const timeSinceLastReport = currentTime - device.lastReport;
      if (timeSinceLastReport > state.DEVICE_OFFLINE_TIMEOUT) {
        markDeviceOffline(device.id);
      }
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
    fileStorage.setItem('devices', JSON.stringify(state.devices));
  } catch (error) {
    console.error('Failed to save devices to fileStorage:', error);
  }
}

function cleanup() {
  stopOfflineCheck();
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
    logger.info('设备数据变更回调已注册', { count: state.dataChangeHandlers.length });
  }
}

function emitDeviceDataChange(device, changes, prevData, nextData) {
  for (const fn of state.dataChangeHandlers) {
    try {
      fn({ deviceId: device.id, device, changes, prevData, nextData });
    } catch (e) {
      logger.warn('设备数据变更回调执行错误', e?.message || e);
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

    // 检查是否是 dpub 设备主题格式: /dpub/XXXX
    const topicMatch = topic.match(/^\/dpub\/(.+)$/);
    if (!topicMatch) {
      return; // 不是设备topic，忽略
    }
    const deviceId = topicMatch[1];

    // 解析消息内容（优先使用 text，其次 payload Buffer）
    let payloadObj;
    const rawText = typeof message?.text === 'string' ? message.text : (message?.payload ? message.payload.toString('utf8') : '');
    try {
      payloadObj = JSON.parse(rawText);
    } catch (e) {
      logger.error('解析MQTT消息失败', e?.message || e);
      return;
    }

    // 检查设备是否已存在
    let device = getDeviceById(deviceId);

    if (!device) {
      // 设备不存在，自动添加（仅在 report 消息时添加）
      if (payloadObj.method === 'report') {
        const devType = payloadObj.device_type || 'other';
        const deviceData = {
          id: deviceId,
          name: `${getDeviceTypeName(devType)}-${String(deviceId).slice(-4)}`,
          type: devType,
        };
        addDevice(deviceData);
        logger.info('自动添加设备', { name: deviceData.name, deviceId });
        device = getDeviceById(deviceId);
      } else {
        // 非 report 消息且设备不存在
        return;
      }
    }

    // 对于 report 消息：按原样合并数据（移除 method）
    if (payloadObj.method === 'report') {
      const updateData = { ...payloadObj };
      delete updateData.method; // 移除 method 字段
      updateDeviceData(deviceId, updateData);
    } else if (payloadObj.method === 'update') {
      // 对于 update 消息：仅按 key/value 更新对应属性
      const { key, value } = payloadObj || {};
      if (typeof key === 'string' && key.length > 0) {
        updateDeviceData(deviceId, { [key]: value });
      } else {
        const updateData = { ...payloadObj };
        delete updateData.method; // 移除 method 字段
        updateDeviceData(deviceId, updateData);
      }
    }
    // 更新最后消息时间和连接状态
    if (device) {
      device.lastReport = Date.now();
      if (!device.connected) {
        device.connected = true;
      }
      saveDevices();
    }
  } catch (error) {
    logger.error('处理设备消息失败', error?.message || error);
  }
}
// ====== API 适配器与业务方法（供路由层调用） ======
function toApiDevice(device) {
  if (!device) return null;
  const last = device.lastReport ? new Date(device.lastReport).toISOString() : null;
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    connected: !!device.connected,
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

function notifyDeviceUpdate(id, patch = {}) {
  const payload = { method: 'update', ...patch };
  const topic = `/drecv/${id}`;
  mqttClient.publish(topic, payload);
}

function deleteDeviceById(id) {
  const before = state.devices.length;
  removeDevice(id);
  const after = state.devices.length;
  return after < before;
}

function clearDevices() {
  clearAllDevices();
  return true;
}

function getDeviceTypesForApi() {
  return { ...state.deviceTypeMap };
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
  // 新增：MQTT消息处理
  handleDeviceMessage,
  // API 适配器与业务方法
  toApiDevice,
  listDevicesForApi,
  getDeviceForApi,
  updateDeviceMeta,
  notifyDeviceUpdate,
  deleteDeviceById,
  clearDevices,
  getDeviceTypesForApi,
}