/**
 * 品牌设备编排服务：统一管理郊狼（DGLab）与役次元（YCY）设备的
 * 发现、连接、断开与控制指令下发，并把连接注册进既有 deviceConnectionService，
 * 从而复用设备映射（devicemap）、Bridge、玩法复位等现有能力。
 */
const deviceService = require('../services/deviceService');
const { DGLabConnection } = require('./dglabConnection');
const { YCYConnection } = require('./ycyConnection');
const discovery = require('./discovery');
const ycyProto = require('./protocols/ycy');

const SUPPORTED = ['dglab', 'ycy'];
const connections = new Map(); // deviceId -> connection adapter

function getConnection(deviceId) {
  return connections.get(deviceId) || null;
}

/** 设备类型推断：根据品牌与发现的型号决定 registry 中的 type */
function resolveDeviceType(brand, { model, mode } = {}) {
  if (brand === 'dglab') return 'DGLAB';
  if (brand === 'ycy') {
    if (mode === 'ble') return (model && /toy|玩具|电机|杯|fjb/i.test(model)) ? 'YCY_TOY' : 'YCY_EMS';
    return 'YCY_EMS'; // 桥接模式默认按电击器处理
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
      suggestedName: `郊狼 ${p.host}`,
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
        suggestedName: `役次元 ${d.name || d.id}`,
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
      suggestedName: `役次元(桥接) ${probe.host}`,
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

  if (brand === 'dglab') {
    const host = opts.host;
    const port = opts.port;
    if (!host) throw new Error('郊狼连接需要 host');
    finalDeviceId = deviceId || `dglab-${host}`;
    finalName = name || `郊狼 ${host}`;
    type = 'DGLAB';
    connection = new DGLabConnection({ deviceId: finalDeviceId, host, port, WebSocketClass });
    await connection.connect();
  } else if (brand === 'ycy') {
    const mode = opts.mode === 'ble' ? 'ble' : 'bridge';
    finalDeviceId = deviceId || (mode === 'ble' ? `ycy-${opts.address || opts.deviceId}` : `ycy-bridge-${opts.host || '127.0.0.1'}`);
    finalName = name || (mode === 'ble' ? `役次元 ${opts.name || finalDeviceId}` : `役次元(桥接) ${opts.host || '127.0.0.1'}`);
    type = resolveDeviceType('ycy', { model, mode });
    connection = new YCYConnection({ deviceId: finalDeviceId, mode, WebSocketClass });
    await connection.connect({ connectCode: opts.connectCode, uid: opts.uid, token: opts.token, host: opts.host, port: opts.port, serviceUuid: opts.serviceUuid, writeUuid: opts.writeUuid });
  }

  // 注册进既有设备连接体系（复用 devicemap / Bridge / 玩法复位）
  const transport = {
    kind: 'brand',
    send: (msg) => connection.send(msg),
    disconnect: () => connection.disconnect(),
  };
  const device = deviceService.connectTransportDevice(
    {
      id: finalDeviceId,
      name: finalName,
      type,
      connectionType: 'brand',
      transportMetadata: connection.toMetadata(),
    },
    transport,
  );

  connections.set(finalDeviceId, connection);
  return { device, connection: connection.toMetadata(), brand, type };
}

// ============ 控制 ============

/** 直接下发品牌命令到指定连接 */
function control(deviceId, brandCommand) {
  const connection = getConnection(deviceId);
  if (!connection) throw new Error('设备未连接');
  return connection.send(brandCommand);
}

// —— 郊狼高层控制 ——
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

// —— 役次元高层控制 ——
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
function ycySetToyMode(deviceId, { motor = 'A', mode = 1 } = {}) {
  return control(deviceId, { brand: 'ycy', cmd: 'setToyMode', motor, mode });
}

// ============ 断开 / 列表 ============

function disconnect(deviceId) {
  const connection = getConnection(deviceId);
  if (!connection) return false;
  try { connection.disconnect(); } catch (_) {}
  connections.delete(deviceId);
  try { deviceService.disconnectTransportDevice(deviceId, 'brand'); } catch (_) {}
  return true;
}

function list() {
  return [...connections.entries()].map(([deviceId, connection]) => {
    const meta = connection.toMetadata();
    const dev = deviceService.getDeviceById(deviceId);
    return {
      deviceId,
      brand: meta.brand,
      mode: meta.mode,
      kind: meta.kind,
      type: dev?.type,
      name: dev?.name,
      connected: true,
      metadata: meta,
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
  // 郊狼
  dglabSetPattern,
  dglabStop,
  dglabSetMaxIntensity,
  dglabSetBackground,
  // 役次元
  ycyTrigger,
  ycyStop,
  ycySetStrength,
  ycySetMode,
  ycySetSpeed,
  ycySetToyMode,
  YCY_GLOBAL_STOP: ycyProto.GLOBAL_STOP_COMMAND,
};
