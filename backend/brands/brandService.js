/**
 * 品牌设备编排服务：统一管理蓝牙体感设备与遥控蓝牙设备的
 * 发现、连接、断开与控制指令下发，并把连接注册进既有 deviceConnectionService，
 * 从而复用设备映射（devicemap）、Bridge、玩法复位等现有能力。
 */
const deviceService = require('../services/deviceService');
const { DGLabConnection } = require('./dglabConnection');
const { YCYConnection } = require('./ycyConnection');
const { DGLabV2WebBleConnection } = require('./webBleConnection');
const { YcyWebBleConnection } = require('./ycyWebBleConnection');
const dglabV2 = require('./protocols/dglabV2');
const discovery = require('./discovery');
const ycyProto = require('./protocols/ycy');
const { brandLabel, typeLabel } = require('./brandLabels');

const SUPPORTED = ['dglab', 'ycy'];
const connections = new Map(); // deviceId -> connection adapter
// 连接状态机（基础连接状态管理，轻量）：
//   connecting | connected | disconnected | error
const connState = new Map(); // deviceId -> { status, lastError, lastChange, reconnecting, userClosed }

const STATUS = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
};

// 受控连接（后端持有链路）允许轻量自动重连；V2 webble 的 GATT 句柄在渲染进程，后端不可重连。
function isReconnectable(kind) {
  return kind !== 'brandBle';
}

function setState(deviceId, status, detail = {}) {
  const prev = connState.get(deviceId) || {};
  connState.set(deviceId, {
    status,
    lastError: detail.error !== undefined ? detail.error : prev.lastError,
    lastChange: Date.now(),
    reconnecting: detail.reconnecting !== undefined ? detail.reconnecting : (prev.reconnecting || false),
    userClosed: detail.userClosed !== undefined ? detail.userClosed : (prev.userClosed || false),
  });
}

function getState(deviceId) {
  return connState.get(deviceId) || { status: STATUS.DISCONNECTED, lastChange: 0 };
}

const MAX_RECONNECT = 3;
const RECONNECT_DELAY = 5000;

function getConnection(deviceId) {
  return connections.get(deviceId) || null;
}

/** 设备类型推断：根据品牌与发现的型号决定 registry 中的 type */
function resolveDeviceType(brand, { model, mode, type } = {}) {
  if (brand === 'dglab') return 'DGLAB';
  if (brand === 'ycy') {
    // 前端显式选择优先（杯 / 灌肠机 / 电击器 / 玩具 等）
    if (type) return type;
    if (mode === 'ble') {
      if (model && /灌肠|enema/i.test(model)) return 'YCY_ENEMA';
      if (model && /杯|cup|fjb/i.test(model)) return 'YCY_CUP';
      if (model && /toy|玩具|电机/i.test(model)) return 'YCY_TOY';
      return 'YCY_EMS';
    }
    // 桥接模式默认按电击器；若名称暗示杯/灌肠则细分
    if (model && /灌肠|enema/i.test(model)) return 'YCY_ENEMA';
    if (model && /杯|cup|fjb/i.test(model)) return 'YCY_CUP';
    return 'YCY_EMS';
  }
  return 'base';
}

function ensureBrand(brand) {
  if (!SUPPORTED.includes(brand)) throw new Error(`不支持的品牌: ${brand}`);
}

// ============ 发现 ============

async function discover(brand, opts = {}) {
  ensureBrand(brand);
  if (brand === 'dglab') {
    const hosts = Array.isArray(opts.hosts) ? opts.hosts : (opts.host ? [opts.host] : []);
    const probed = await discovery.discoverDGLab({ hosts, port: opts.port, WebSocketClass: opts.WebSocketClass });
    return probed.map((p, i) => ({
      brand: 'dglab',
      host: p.host,
      port: p.port,
      reachable: p.ok,
      error: p.error,
      suggestedDeviceId: `dglab-${p.host}`,
      suggestedName: `蓝牙体感设备 ${p.host}`,
    }));
  }
  if (brand === 'ycy') {
    if (opts.mode === 'ble') {
      const devices = await discovery.scanYcyBle({ timeoutMs: opts.timeoutMs || 5000 });
      return devices.map((d) => ({
        brand: 'ycy',
        mode: 'ble',
        deviceId: d.id,
        name: d.name,
        address: d.address,
        rssi: d.rssi,
        suggestedDeviceId: `ycy-${d.id}`,
        suggestedName: `遥控蓝牙设备 ${d.id}`,
      }));
    }
    // bridge 模式
    const probe = await discovery.probeYcyBridge({ host: opts.host, port: opts.port, WebSocketClass: opts.WebSocketClass });
    return [{
      brand: 'ycy',
      mode: 'bridge',
      host: probe.host,
      port: probe.port,
      reachable: probe.ok,
      error: probe.error,
      suggestedDeviceId: `ycy-bridge-${probe.host}`,
      suggestedName: `遥控蓝牙设备(桥接) ${probe.host}`,
    }];
  }
  return [];
}

// ============ 连接 ============

async function connect(brand, opts = {}) {
  ensureBrand(brand);
  const {
    deviceId,
    name,
    model,
    WebSocketClass = null,
  } = opts;

  let connection;
  let type;
  let finalDeviceId;
  let finalName;
  let kind = 'brand';

  if (brand === 'dglab') {
    const host = opts.host;
    const port = opts.port;
    if (!host) throw new Error('蓝牙体感设备连接需要 host');
    finalDeviceId = deviceId || `dglab-${host}`;
    finalName = name || `蓝牙体感设备 ${host}`;
    type = 'DGLAB';
    connection = new DGLabConnection({ deviceId: finalDeviceId, host, port, WebSocketClass });
  } else if (brand === 'ycy') {
    const mode = opts.mode === 'ble' ? 'ble' : 'bridge';
    finalDeviceId = deviceId || (mode === 'ble' ? `ycy-${opts.address || opts.deviceId}` : `ycy-bridge-${opts.host || '127.0.0.1'}`);
    finalName = name || (mode === 'ble' ? `遥控蓝牙设备 ${opts.name || finalDeviceId}` : `遥控蓝牙设备(桥接) ${opts.host || '127.0.0.1'}`);
    type = resolveDeviceType('ycy', { model, mode, type: opts.type });
    connection = new YCYConnection({ deviceId: finalDeviceId, mode, WebSocketClass });
  }

  // 标记用户主动发起连接（用于区分主动断开与异常掉线，决定是否重连）
  setState(finalDeviceId, STATUS.CONNECTING, { userClosed: false, reconnecting: false, error: null });
  await safeConnect(connection, brand, opts, finalDeviceId, type, finalName, kind);
  return { device: deviceService.getDeviceById(finalDeviceId), connection: connection.toMetadata(), brand, type };
}

// 真正建立连接、注册进 deviceService，并挂接 onStatus 回调（close/error → 状态机 + 轻量重连）。
async function safeConnect(connection, brand, opts, finalDeviceId, type, finalName, kind) {
  const attemptConnect = async () => {
    if (brand === 'dglab') {
      await connection.connect();
    } else if (brand === 'ycy') {
      await connection.connect({ connectCode: opts.connectCode, uid: opts.uid, token: opts.token, host: opts.host, port: opts.port, serviceUuid: opts.serviceUuid, writeUuid: opts.writeUuid });
    }
  };
  await attemptConnect();

  // 适配器上报状态（close/error）。重连由 brandService 控制，适配器仅负责链路层回调。
  if (typeof connection.onStatus === 'function') {
    connection.onStatus((status, detail = {}) => {
      if (status === 'close') {
        handleLinkDown(finalDeviceId, kind, detail.error);
      } else if (status === 'error') {
        setState(finalDeviceId, STATUS.ERROR, { error: detail.error });
      }
    });
  }

  const transport = {
    kind,
    send: (msg) => connection.send(msg),
    disconnect: () => connection.disconnect(),
  };
  deviceService.connectTransportDevice(
    {
      id: finalDeviceId,
      name: finalName,
      type,
      connectionType: kind,
      transportMetadata: connection.toMetadata(),
    },
    transport,
  );

  connections.set(finalDeviceId, connection);
  setState(finalDeviceId, STATUS.CONNECTED);
}

// 链路断开（close）：非用户主动断开的受控连接尝试轻量重连，否则置为 disconnected。
function handleLinkDown(deviceId, kind, error) {
  const st = getState(deviceId);
  if (st.userClosed) {
    setState(deviceId, STATUS.DISCONNECTED, { error });
    return;
  }
  if (!isReconnectable(kind)) {
    setState(deviceId, STATUS.DISCONNECTED, { error });
    return;
  }
  scheduleReconnect(deviceId, kind, error);
}

function scheduleReconnect(deviceId, kind, error) {
  const st = getState(deviceId);
  const attempts = st.reconnectAttempts || 0;
  if (attempts >= MAX_RECONNECT) {
    setState(deviceId, STATUS.ERROR, { error: error || '连接断开且重连失败', reconnecting: false });
    return;
  }
  setState(deviceId, STATUS.ERROR, { error: error || '连接断开，重连中', reconnecting: true });
  const delay = RECONNECT_DELAY * (attempts + 1);
  setTimeout(async () => {
    const cur = getState(deviceId);
    if (cur.userClosed || cur.status === STATUS.CONNECTED) return;
    const connection = connections.get(deviceId);
    if (!connection) return;
    try {
      const meta = connection.toMetadata();
      const st2 = connState.get(deviceId) || {};
      connState.set(deviceId, { ...st2, reconnectAttempts: (st2.reconnectAttempts || 0) + 1 });
      // 复用适配器自身重连；若不支持则重建连接对象。
      if (typeof connection.reconnect === 'function') {
        await connection.reconnect();
      } else {
        const fresh = rebuildConnection(deviceId, meta);
        connections.set(deviceId, fresh);
        await fresh.connect();
        if (typeof fresh.onStatus === 'function') {
          fresh.onStatus((status, detail = {}) => {
            if (status === 'close') handleLinkDown(deviceId, kind, detail.error);
            else if (status === 'error') setState(deviceId, STATUS.ERROR, { error: detail.error });
          });
        }
      }
      setState(deviceId, STATUS.CONNECTED, { reconnecting: false });
    } catch (e) {
      scheduleReconnect(deviceId, kind, e?.message || String(e));
    }
  }, delay);
}

// 依据既有 metadata 重建一个同类适配器（用于无原生 reconnect 的连接）。
function rebuildConnection(deviceId, meta) {
  if (meta.brand === 'dglab') {
    return new DGLabConnection({ deviceId, host: meta.host, port: meta.port });
  }
  if (meta.brand === 'ycy') {
    return new YCYConnection({ deviceId, mode: meta.mode });
  }
  return new DGLabV2WebBleConnection({ deviceId, send: () => {} });
}

// ============ 控制 ============

/** 直接下发品牌命令到指定连接 */
function control(deviceId, brandCommand) {
  const connection = getConnection(deviceId);
  if (!connection) throw new Error('设备未连接');
  return connection.send(brandCommand);
}

// —— 蓝牙体感设备高层控制 ——
function dglabSetPattern(deviceId, { pattern = '经典', intensity = 100, ticks = -1 } = {}) {
  return control(deviceId, { brand: 'dglab', cmd: 'setPattern', pattern, intensity, ticks });
}
function dglabStop(deviceId) {
  return control(deviceId, { brand: 'dglab', cmd: 'stopPattern' });
}
function dglabSetMaxIntensity(deviceId, { delta = 0 } = {}) {
  return control(deviceId, { brand: 'dglab', cmd: 'setMaxIntensity', delta });
}
function dglabSetBackground(deviceId, opts = {}) {
  return control(deviceId, { brand: 'dglab', cmd: 'setBackground', ...opts });
}

// —— 遥控蓝牙设备高层控制 ——
function ycyTrigger(deviceId, commandId, token) {
  return control(deviceId, { brand: 'ycy', cmd: 'triggerInstruction', commandId, token });
}
function ycyStop(deviceId) {
  return control(deviceId, { brand: 'ycy', cmd: 'stopAll' });
}
function ycySetStrength(deviceId, { channel = 'A', value = 0 } = {}) {
  return control(deviceId, { brand: 'ycy', cmd: 'setStrength', channel, value });
}
function ycySetMode(deviceId, { channel = 'A', mode = 1 } = {}) {
  return control(deviceId, { brand: 'ycy', cmd: 'setMode', channel, mode });
}
function ycySetSpeed(deviceId, { motor = 'A', speed = 0 } = {}) {
  return control(deviceId, { brand: 'ycy', cmd: 'setSpeed', motor, speed });
}
function ycySetFjb(deviceId, { stroke = 0, vibe = 0, axis = 0 } = {}) {
  return control(deviceId, { brand: 'ycy', cmd: 'setFjb', stroke, vibe, axis });
}
function ycySetToyMode(deviceId, { motor = 'A', mode = 1 } = {}) {
  return control(deviceId, { brand: 'ycy', cmd: 'setToyMode', motor, mode });
}

// ============ 断开 / 列表 ============

function disconnect(deviceId) {
  const connection = getConnection(deviceId);
  if (!connection) return false;
  // 标记用户主动断开：抑制自动重连。
  const st = connState.get(deviceId) || {};
  connState.set(deviceId, { ...st, userClosed: true, reconnecting: false });
  try { connection.disconnect(); } catch (_) {}
  connections.delete(deviceId);
  connState.delete(deviceId);
  // V2 WebBLE 以 'brandBle' 注册；dglab/ycy 以 'brand' 注册。两者尝试性解注册即可。
  try { deviceService.disconnectTransportDevice(deviceId, 'brand'); } catch (_) {}
  try { deviceService.disconnectTransportDevice(deviceId, 'brandBle'); } catch (_) {}
  return true;
}

// ============ 蓝牙体感设备（直连版）Web Bluetooth 直连 ============
// 设备由渲染进程经 WebBT 连接后，通过主进程 brandBle:connected 注入 send 闭包，
// 再调用本方法将适配器登记进品牌框架与 deviceService。

function attachWebBle(metadata, send) {
  if (!metadata?.id) throw new TypeError('WebBLE 元数据缺少 id');
  const ycyType = metadata.type && String(metadata.type).startsWith('YCY')
    ? metadata.type
    : resolveDeviceType('ycy', { mode: 'ble', model: metadata.name, type: metadata.type });
  const isYcy = metadata.brand === 'ycy' || String(metadata.type || '').startsWith('YCY')
    || /FJB|YCY|YYC|YOKO|TDD/i.test(metadata.name || '');
  let connection = connections.get(metadata.id);
  if (!connection) {
    connection = isYcy
      ? new YcyWebBleConnection({ deviceId: metadata.id, send, type: ycyType })
      : new DGLabV2WebBleConnection({ deviceId: metadata.id, send });
    connections.set(metadata.id, connection);
  }
  const type = isYcy ? ycyType : 'DGLAB';
  const brand = isYcy ? 'ycy' : 'dglab';
  deviceService.connectTransportDevice(
    {
      id: metadata.id,
      name: metadata.name || `${isYcy ? '役次元' : '蓝牙体感设备'} ${String(metadata.id).slice(-4)}`,
      type,
      connectionType: 'brandBle',
      transportMetadata: connection.toMetadata(),
      data: metadata.data || {},
    },
    { kind: 'brandBle', send },
  );
  setState(metadata.id, STATUS.CONNECTED, { userClosed: false, reconnecting: false, error: null });
  return {
    device: deviceService.getDeviceById(metadata.id),
    connection: connection.toMetadata(),
    brand,
    type,
  };
}

function detachWebBle(deviceId) {
  const connection = getConnection(deviceId);
  if (!connection) return false;
  const st = connState.get(deviceId) || {};
  connState.set(deviceId, { ...st, userClosed: true, reconnecting: false });
  try { connection.disconnect(); } catch (_) {}
  connections.delete(deviceId);
  connState.delete(deviceId);
  try { deviceService.disconnectTransportDevice(deviceId, 'brandBle'); } catch (_) {}
  return true;
}

// —— 蓝牙体感设备（直连版）高层控制 ——
function dglabV2SetStrength(deviceId, { a = 0, b = 0 } = {}) {
  return control(deviceId, { brand: 'dglab', cmd: 'v2_setStrength', a: Number(a) || 0, b: Number(b) || 0 });
}
function dglabV2SetWaveform(deviceId, { channel = 'A', x = 5, y = 200, z = 0 } = {}) {
  return control(deviceId, { brand: 'dglab', cmd: 'v2_setWaveform', channel, x: Number(x) || 0, y: Number(y) || 0, z: Number(z) || 0 });
}
function dglabV2Stop(deviceId) {
  return control(deviceId, { brand: 'dglab', cmd: 'v2_stop' });
}
function dglabV2ReadBattery(deviceId) {
  return control(deviceId, { brand: 'dglab', cmd: 'v2_readBattery' });
}

// —— 原版 V2 强度位布局（标定用，运行时切换）——
function getV2StrengthLayout() {
  return dglabV2.getStrengthLayout();
}
function setV2StrengthLayout(layout) {
  if (layout !== 'official' && layout !== 'coyote2') {
    throw new Error('非法布局，仅支持 official / coyote2');
  }
  return dglabV2.setStrengthLayout(layout);
}

function list() {
  return [...connections.entries()].map(([deviceId, connection]) => {
    const meta = connection.toMetadata();
    const dev = deviceService.getDeviceById(deviceId);
    const st = getState(deviceId);
    return {
      deviceId,
      brand: meta.brand,
      brandLabel: brandLabel(meta.brand),
      mode: meta.mode,
      kind: meta.kind,
      type: dev?.type,
      typeLabel: typeLabel(dev?.type),
      name: dev?.name,
      // 返回真实连接状态，而非写死 true
      connected: st.status === STATUS.CONNECTED,
      status: st.status,
      lastError: st.lastError || null,
      lastChange: st.lastChange || 0,
      reconnecting: st.reconnecting || false,
      metadata: meta,
      data: dev?.data || {},
    };
  });
}

function getStatus() {
  return {
    supported: SUPPORTED,
    activeCount: connections.size,
    devices: list(),
  };
}

module.exports = {
  SUPPORTED,
  getConnection,
  discover,
  connect,
  control,
  disconnect,
  list,
  getStatus,
  resolveDeviceType,
  // 蓝牙体感设备
  dglabSetPattern,
  dglabStop,
  dglabSetMaxIntensity,
  dglabSetBackground,
  // 蓝牙体感设备（直连版）（Web Bluetooth 直连）
  attachWebBle,
  detachWebBle,
  dglabV2SetStrength,
  dglabV2SetWaveform,
  dglabV2Stop,
  dglabV2ReadBattery,
  getV2StrengthLayout,
  setV2StrengthLayout,
  // 遥控蓝牙设备
  ycyTrigger,
  ycyStop,
  ycySetStrength,
  ycySetMode,
  ycySetSpeed,
  ycySetFjb,
  ycySetToyMode,
  YCY_GLOBAL_STOP: ycyProto.GLOBAL_STOP_COMMAND,
};
