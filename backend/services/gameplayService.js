const fs = require('fs');
const path = require('path');
const vm = require('vm');
const logService = require('./logService');
const { hasInterface } = require('../config/deviceTypes');
const mqttClient = require('./mqttClientService');
const deviceService = require('./deviceService');

// 单例内部状态
const state = {
  currentGameplay: null, // 游戏对象（实例化后）
  gameplaySourcePath: null, // 绝对路径
  isRunning: false,
  startTime: null,
  loopIntervalMs: 1000,
  gameLoopTimer: null,
  parameters: null,
  logCallback: null,
  // 兼容旧版单回调的同时，支持多日志订阅者
  logCallbacks: new Set(),
  // 动态监听器
  mqttMessageHandler: null,
  deviceDataChangeHandler: null,
  // 稳定监听器注册标记
  handlersInitialized: false,
  // 设备管理器（注入给玩法）
  deviceManager: {
    deviceMap: {},
    // 设备消息监听：logicalId -> [callback]
    _messageListeners: new Map(),
    // 属性监听：logicalId -> property -> [callback]
    _propertyListeners: new Map(),
    listenDeviceMessages(logicalId, callback) {
      if (!logicalId || typeof callback !== 'function') return;
      const arr = this._messageListeners.get(logicalId) || [];
      arr.push(callback);
      this._messageListeners.set(logicalId, arr);
      sendLog('info', '已注册设备消息监听', { logicalId, count: arr.length });
    },
    listenDeviceProperty(logicalId, property, callback) {
      if (!logicalId || !property || typeof callback !== 'function') return;
      const propMap = this._propertyListeners.get(logicalId) || new Map();
      const arr = propMap.get(property) || [];
      arr.push(callback);
      propMap.set(property, arr);
      this._propertyListeners.set(logicalId, propMap);
      sendLog('info', '已注册设备属性监听', { logicalId, property, count: arr.length });
    },
    setDeviceProperty(logicalId, properties) {
      const ids = this.deviceMap[logicalId];
      const arr = Array.isArray(ids) ? ids : (ids ? [ids] : []);
      if (!arr.length) return sendLog('warn', '设备未映射，忽略属性设置', { logicalId });
      for (const deviceId of arr) {
        try { deviceService.notifyDeviceUpdate(deviceId, properties || {}); } catch (e) { sendLog('error', '下发设备属性失败', { logicalId, deviceId, error: e?.message || String(e) }); }
      }
    },
    sendDeviceMqttMessage(logicalId, message) {
      const ids = this.deviceMap[logicalId];
      const arr = Array.isArray(ids) ? ids : (ids ? [ids] : []);
      if (!arr.length) return sendLog('warn', '设备未映射，忽略发送MQTT', { logicalId });
      for (const deviceId of arr) {
        try { mqttClient.publish(`/drecv/${deviceId}`, message || {}); sendLog('debug', '发送设备MQTT消息', { logicalId, deviceId, message }); } catch (e) { sendLog('error', '发送设备MQTT消息失败', { logicalId, deviceId, error: e?.message || String(e) }); }
      }
    },
    sendMqttMessage(topic, message) {
      try {
        mqttClient.publish(topic, message);
        sendLog('debug', '发送MQTT消息', { topic });
      } catch (e) {
        sendLog('error', '发送MQTT消息失败', { topic, error: e?.message || String(e) });
      }
    },
    getDeviceProperty(logicalId, property) {
      const ids = this.deviceMap[logicalId];
      const firstId = Array.isArray(ids) ? ids[0] : ids;
      if (!firstId) return undefined;
      const dev = deviceService.getDeviceById(firstId);
      const data = dev?.data || {};
      return data[property];
    },
    log(level, message, extra) { sendLog(level, message, extra); },
    // 由玩法触发状态与界面增量，供 SSE 转发
    emitState(delta) { try { notifyState(delta || {}); } catch (_) {} },
    emitUi(delta) { try { notifyUi(delta || {}); } catch (_) {} },
  },
  // 供 SSE 订阅的增量事件回调集合
  stateUpdateCallbacks: new Set(),
  uiUpdateCallbacks: new Set(),
};

function setLogCallback(cb) { state.logCallback = typeof cb === 'function' ? cb : null; }
function addLogCallback(cb) { if (typeof cb === 'function') state.logCallbacks.add(cb); }
function removeLogCallback(cb) { if (typeof cb === 'function') state.logCallbacks.delete(cb); }

function sendLog(level, message, extra = {}) {
  const payload = { ts: Date.now(), level, message, extra };
  try { 
    const logMessage = extra && Object.keys(extra).length > 0 ? `${message} ${JSON.stringify(extra)}` : message;
    if (logService[level]) {
      logService[level]('GamePlay', logMessage);
    } else {
      logService.info('GamePlay', logMessage);
    }
  } catch (_) {}
  if (state.logCallback) {
    try { state.logCallback(payload); } catch (e) { logService.warn('GamePlay', `logCallback error: ${e?.message || e}`); }
  }
  // 广播到所有订阅者
  try {
    for (const cb of state.logCallbacks) {
      try { cb(payload); } catch (e) { /* 单个订阅者错误不影响其它 */ }
    }
  } catch (_) {}
}

// ===== gameplay 加载与校验 =====
function resolveGameAbsPath(configOrPath) {
  // 支持：绝对路径；"backend/game/..."；其它相对路径认为相对于 backend/game
  if (!configOrPath) return null;
  const p = typeof configOrPath === 'string' ? configOrPath : configOrPath.configPath;
  if (!p || typeof p !== 'string') return null;
  if (path.isAbsolute(p)) return p;
  const prefix = 'backend/game/';
  if (p.startsWith(prefix)) {
    const relWithinGame = p.slice(prefix.length);
    return path.resolve(__dirname, '..', 'game', relWithinGame);
  }
  // 其它相对路径：视为位于 backend/game
  return path.resolve(__dirname, '..', 'game', p);
}

function transformToCommonJS(code) {
  // 极简转换，满足 export default 与具名导出使用场景
  let src = String(code || '');
  // export default XXX
  src = src.replace(/export\s+default\s+/g, 'module.exports = ');
  // export { a, b as c }
  src = src.replace(/export\s*\{([^}]+)\}\s*;?/g, (m, g1) => {
    return `module.exports = { ${g1} };`;
  });
  return src;
}

function runInSandbox(transformedCode, absPath) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    // 定时器相关方法
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    // 时间相关
    Date,
    // 数学相关
    Math,
    // 常用全局对象
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    // 错误处理
    Error,
    TypeError,
    ReferenceError,
    SyntaxError,
  };
  const context = vm.createContext(sandbox, { name: 'GameplaySandbox' });
  const script = new vm.Script(transformedCode, { filename: absPath, displayErrors: true });
  script.runInContext(context, { timeout: 1000 });
  return sandbox.module.exports || sandbox.exports;
}

function isClass(fn) {
  if (typeof fn !== 'function') return false;
  const s = Function.prototype.toString.call(fn);
  return /^class\s/.test(s);
}

function loadGameplayFromFile(absPath) {
  const code = fs.readFileSync(absPath, 'utf8');
  const transformed = transformToCommonJS(code);
  const exported = runInSandbox(transformed, absPath);
  let gameplay = exported;
  if (isClass(exported)) {
    gameplay = new exported();
  }
  if (typeof exported === 'function' && !isClass(exported)) {
    // 允许导出工厂函数：返回对象
    try { gameplay = exported(); } catch (_) {}
  }
  validateGameplay(gameplay);
  return gameplay;
}

function validateGameplay(gameplay) {
  if (!gameplay || typeof gameplay !== 'object') {
    const err = new Error('玩法导出必须是对象或类实例');
    err.code = 'GAMEPLAY_INVALID_EXPORT';
    throw err;
  }
  const requiredFields = ['title', 'description', 'requiredDevices'];
  const requiredMethods = ['start', 'loop'];
  for (const k of requiredFields) {
    if (!(k in gameplay)) {
      const err = new Error(`玩法缺少必需字段: ${k}`);
      err.code = 'GAMEPLAY_MISSING_FIELD';
      throw err;
    }
  }
  for (const m of requiredMethods) {
    if (typeof gameplay[m] !== 'function') {
      const err = new Error(`玩法方法必须为函数: ${m}`);
      err.code = 'GAMEPLAY_MISSING_METHOD';
      throw err;
    }
  }
  if (!Array.isArray(gameplay.requiredDevices)) gameplay.requiredDevices = [];
}

// ===== 获取玩法元信息（不启动游戏） =====
function getGameplayMeta(configOrPath) {
  const abs = resolveGameAbsPath(configOrPath);
  if (!abs) {
    const err = new Error('玩法路径无效或不可解析');
    err.code = 'GAMEPLAY_PATH_INVALID';
    throw err;
  }
  const gp = loadGameplayFromFile(abs);
  const meta = {
    title: gp.title || '',
    description: gp.description || '',
    requiredDevices: Array.isArray(gp.requiredDevices) ? gp.requiredDevices : [],
    parameterSchema: (gp.parameterSchema && typeof gp.parameterSchema === 'object') ? gp.parameterSchema : undefined,
    parameter: Array.isArray(gp.parameter) ? gp.parameter : undefined,
  };
  return meta;
}

// ===== SSE 事件订阅（state/ui） =====
function onStateUpdate(cb) { if (typeof cb === 'function') state.stateUpdateCallbacks.add(cb); }
function offStateUpdate(cb) { if (typeof cb === 'function') state.stateUpdateCallbacks.delete(cb); }
function onUiUpdate(cb) { if (typeof cb === 'function') state.uiUpdateCallbacks.add(cb); }
function offUiUpdate(cb) { if (typeof cb === 'function') state.uiUpdateCallbacks.delete(cb); }
function notifyState(delta = {}) {
  try {
    if (!delta || typeof delta !== 'object') return;
    for (const cb of state.stateUpdateCallbacks) {
      try { cb(delta); } catch (e) { logService.warn('GamePlay', `stateUpdate callback error: ${e?.message || e}`); }
    }
  } catch (_) {}
}
function notifyUi(delta = {}) {
  try {
    if (!delta || typeof delta !== 'object') return;
    for (const cb of state.uiUpdateCallbacks) {
      try { cb(delta); } catch (e) { logService.warn('GamePlay', `uiUpdate callback error: ${e?.message || e}`); }
    }
  } catch (_) {}
}

// ===== 设备映射与依赖验证 =====
function applyDeviceMapping(deviceMapping = {}) {
  const map = {};
  for (const [logicalId, val] of Object.entries(deviceMapping || {})) {
    const arr = Array.isArray(val) ? val.filter(x => typeof x === 'string' && x.length > 0) : (typeof val === 'string' && val.length > 0 ? [val] : []);
    if (!arr.length) { sendLog('warn', '设备映射项无效，已忽略', { logicalId }); continue; }
    map[logicalId] = arr;
  }
  state.deviceManager.deviceMap = map;
  sendLog('info', '设备映射已应用', { count: Object.keys(map).length, map });
}

function validateDeviceDependencies() {
  const gp = state.currentGameplay;
  if (!gp) return;
  for (const item of gp.requiredDevices) {
    const { logicalId, required, interface: iface } = item || {};
    const ids = state.deviceManager.deviceMap[logicalId];
    const arr = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    if (required && arr.length === 0) {
      const err = new Error(`必需设备未映射: ${logicalId}`);
      err.code = 'DEVICE_MAPPING_MISSING';
      sendLog('error', err.message, { logicalId });
      throw err;
    }
    for (const deviceId of arr) {
      const dev = deviceService.getDeviceById(deviceId);
      if (!dev || dev.connected !== true) {
        const err = new Error(`必需设备离线或不存在: ${logicalId}`);
        err.code = 'DEVICE_OFFLINE';
        sendLog('error', err.message, { logicalId, deviceId });
        throw err;
      }
      if (iface && typeof dev?.type === 'string' && !hasInterface(dev.type, iface)) {
        const err = new Error(`必需设备接口不匹配: ${logicalId}`);
        err.code = 'DEVICE_INTERFACE_MISMATCH';
        sendLog('error', err.message, { logicalId, deviceId, interface: iface, type: dev.type });
        throw err;
      }
    }
  }
}

// ===== MQTT 与设备属性监听 =====
function makeReverseDeviceMap() {
  const rev = new Map();
  for (const [logicalId, ids] of Object.entries(state.deviceManager.deviceMap || {})) {
    const arr = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    for (const deviceId of arr) { if (deviceId) rev.set(deviceId, logicalId); }
  }
  return rev;
}

// 稳定的（单例）MQTT消息处理器：仅注册一次，始终根据当前 state 分发
function handleMqttMessage(message) {
  try {
    if (!state.isRunning || !state.currentGameplay) return;
    const topic = message?.topic;
    if (typeof topic !== 'string') return;
    const m = topic.match(/^\/dpub\/(.+)$/);
    if (!m) return; // 非设备上报主题，忽略
    const deviceId = m[1];
    const reverseMap = makeReverseDeviceMap();
    const logicalId = reverseMap.get(deviceId);
    if (!logicalId) return; // 不在当前玩法映射中，忽略
    // 解析 JSON
    const rawText = typeof message?.text === 'string' ? message.text : (message?.payload ? message.payload.toString('utf8') : '');
    let payloadObj;
    try { payloadObj = JSON.parse(rawText); } catch (_) { return; }
    if (!payloadObj || typeof payloadObj !== 'object' || !('method' in payloadObj)) return; // 无 method 忽略
    // 分发到注册的消息监听器
    const listeners = state.deviceManager._messageListeners.get(logicalId) || [];
    for (const fn of listeners) {
      try { fn(payloadObj, { logicalId, deviceId, topic }); } catch (e) { sendLog('warn', '设备消息监听器执行错误', { logicalId, error: e?.message || String(e) }); }
    }
  } catch (e) {
    sendLog('error', '设备消息处理失败', { error: e?.message || String(e) });
  }
}

// 稳定的（单例）设备属性变更处理器：仅注册一次，始终根据当前 state 分发
function handleDeviceDataChange(evt) {
  try {
    if (!state.isRunning || !state.currentGameplay) return;
    // 兼容 deviceService.emitDeviceDataChange 事件对象，以及潜在的多参形式
    let deviceId;
    let changes;
    if (evt && typeof evt === 'object' && ('deviceId' in evt || 'changes' in evt)) {
      deviceId = evt.deviceId;
      changes = evt.changes;
    } else {
      deviceId = arguments[0];
      changes = arguments[1];
    }
    const reverseMap = makeReverseDeviceMap();
    const logicalId = reverseMap.get(deviceId);
    if (!logicalId) return;
    const propMap = state.deviceManager._propertyListeners.get(logicalId);
    if (!propMap || !(propMap instanceof Map)) return;
    for (const [prop, change] of Object.entries(changes || {})) {
      const listeners = propMap.get(prop) || [];
      if (!listeners.length) continue;
      for (const fn of listeners) {
        try { fn(change?.new, change?.old, { logicalId, deviceId, property: prop }); } catch (e) { sendLog('warn', '属性监听器执行错误', { logicalId, property: prop, error: e?.message || String(e) }); }
      }
    }
  } catch (e) {
    sendLog('error', '设备属性变更处理失败', { error: e?.message || String(e) });
  }
}

// 仅注册一次稳定监听器
function ensureStableHandlers() {
  if (state.handlersInitialized) return;
  // 确保 MQTT 客户端已初始化
  try { mqttClient.init(); } catch (_) {}
  mqttClient.onMessage(handleMqttMessage);
  deviceService.onDeviceDataChange(handleDeviceDataChange);
  state.mqttMessageHandler = handleMqttMessage;
  state.deviceDataChangeHandler = handleDeviceDataChange;
  state.handlersInitialized = true;
  sendLog('info', '稳定MQTT与设备属性监听器已注册');
}

// ===== 玩法生命周期 =====
function startGameplay(config, deviceMapping = {}, parameters = {}) {
  if (state.isRunning) {
    const err = new Error('已有玩法在运行');
    err.code = 'GAMEPLAY_ALREADY_RUNNING';
    sendLog('error', err.message);
    throw err;
  }
  const absPath = resolveGameAbsPath(config);
  if (!absPath || !fs.existsSync(absPath)) {
    const err = new Error('玩法文件不存在或路径无效');
    err.code = 'GAMEPLAY_FILE_NOT_FOUND';
    sendLog('error', err.message, { config });
    throw err;
  }

  // 加载并校验玩法
  const gameplay = loadGameplayFromFile(absPath);
  state.currentGameplay = gameplay;
  state.gameplaySourcePath = absPath;
  // 注入日志接口
  state.deviceManager.log = (level, msg, extra) => sendLog(level, msg, extra);

  // 应用映射与依赖验证
  applyDeviceMapping(deviceMapping);
  validateDeviceDependencies();

  // 确保稳定监听器已注册（只注册一次）
  ensureStableHandlers();

  // 记录并启动
  state.parameters = parameters || {};
  state.isRunning = true;
  state.startTime = Date.now();
  sendLog('info', '玩法启动', { title: gameplay.title, description: gameplay.description });

  // 执行 start
  try {
    gameplay.start(state.deviceManager, state.parameters);
  } catch (e) {
    sendLog('error', '玩法 start 执行失败', { error: e?.message || String(e) });
    // 启动失败直接结束，抛错
    endGameplay();
    const err = new Error('玩法启动失败');
    err.code = 'GAMEPLAY_START_FAILED';
    throw err;
  }

  startGameLoop();
  return { ok: true, title: gameplay.title, startTime: state.startTime };
}

function startGameLoop() {
  clearInterval(state.gameLoopTimer);
  state.gameLoopTimer = setInterval(() => {
    if (!state.currentGameplay) return;
    const t0 = Date.now();
    try {
      const ret = state.currentGameplay.loop(state.deviceManager);
      const elapsed = Date.now() - t0;
      if (elapsed > 800) {
        sendLog('warn', '玩法循环耗时过长', { elapsed });
      }
      if (ret === false) {
        sendLog('info', '玩法 loop 返回 false，结束');
        endGameplay();
      }
    } catch (e) {
      sendLog('error', '玩法 loop 执行异常，结束', { error: e?.message || String(e) });
      endGameplay();
    }
  }, state.loopIntervalMs);
  sendLog('debug', '玩法循环已启动', { intervalMs: state.loopIntervalMs });
}

function endGameplay() {
  // 清理 interval 与监听器
  if (state.gameLoopTimer) { clearInterval(state.gameLoopTimer); state.gameLoopTimer = null; }

  const gp = state.currentGameplay;
  try {
    if (gp && typeof gp.end === 'function') gp.end(state.deviceManager);
  } catch (e) {
    sendLog('warn', '玩法 end 执行异常', { error: e?.message || String(e) });
  }

  // 重置状态
  state.currentGameplay = null;
  state.gameplaySourcePath = null;
  state.isRunning = false;
  const duration = state.startTime ? (Date.now() - state.startTime) : null;
  state.startTime = null;
  state.parameters = null;
  // 清空已注册回调集合
  state.deviceManager._messageListeners.clear();
  state.deviceManager._propertyListeners.clear();
  state.stateUpdateCallbacks.clear();
  state.uiUpdateCallbacks.clear();
  state.logCallbacks.clear();
  sendLog('info', '玩法已结束', { duration });
  return { ok: true, duration };
}

function stopGameplay() { return endGameplay(); }

function updateParameters(parameters = {}) {
  state.parameters = parameters || {};
  const gp = state.currentGameplay;
  try {
    if (gp && typeof gp.updateParameters === 'function') gp.updateParameters(state.parameters);
  } catch (e) {
    sendLog('warn', '玩法 updateParameters 执行异常', { error: e?.message || String(e) });
  }
}

function status() {
  return {
    running: state.isRunning,
    title: state.currentGameplay?.title || null,
    startTime: state.startTime,
    loopIntervalMs: state.loopIntervalMs,
    gameplaySourcePath: state.gameplaySourcePath,
  };
}

// ===== 页面 HTML 与动作处理、快照 =====
function getCurrentGameplay() { return state.currentGameplay || null; }
function getSnapshot() {
  return {
    running: state.isRunning,
    title: state.currentGameplay?.title || null,
    startTime: state.startTime,
    parameters: state.parameters || {},
    deviceMapping: { ...(state.deviceManager.deviceMap || {}) },
  };
}
function getHtmlString() {
  const gp = state.currentGameplay;
  if (!state.isRunning || !gp) {
    const err = new Error('当前无运行玩法');
    err.code = 'NO_GAME_RUNNING';
    throw err;
  }
  try {
    if (typeof gp.getHtml === 'function') {
      const html = gp.getHtml();
      if (typeof html === 'string' && html.length > 0) return html;
    }
    if (typeof gp.html === 'string' && gp.html.length > 0) return gp.html;
  } catch (e) {
    const err = new Error(e?.message || String(e));
    err.code = 'GAMEPLAY_HTML_NOT_AVAILABLE';
    throw err;
  }
  const err = new Error('玩法未提供 HTML');
  err.code = 'GAMEPLAY_HTML_NOT_AVAILABLE';
  throw err;
}
function performAction(action, payload) {
  const gp = state.currentGameplay;
  if (!state.isRunning || !gp) {
    const err = new Error('当前无运行玩法');
    err.code = 'NO_GAME_RUNNING';
    throw err;
  }
  if (typeof gp.onAction !== 'function') {
    const err = new Error('玩法未实现动作处理');
    err.code = 'GAMEPLAY_ACTION_NOT_SUPPORTED';
    throw err;
  }
  try {
    return gp.onAction(action, payload, state.deviceManager);
  } catch (e) {
    // 保留玩法自定义错误码（例如 GAMEPLAY_ACTION_NOT_SUPPORTED），否则使用通用失败码
    const err = new Error(e?.message || String(e));
    err.code = e?.code || 'GAMEPLAY_ACTION_FAILED';
    throw err;
  }
}

module.exports = {
  setLogCallback,
  addLogCallback,
  removeLogCallback,
  sendLog,
  startGameplay,
  endGameplay,
  stopGameplay,
  updateParameters,
  status,
  // 新增导出供路由使用
  onStateUpdate,
  offStateUpdate,
  onUiUpdate,
  offUiUpdate,
  getCurrentGameplay,
  getSnapshot,
  getHtmlString,
  performAction,
  getGameplayMeta,
};
