const fileStorage = require('../utils/fileStorage');
const logger = require('./logService');
const deviceService = require('./deviceService');
const { SerialLineParser, encodeCommand } = require('../transports/serialProtocol');

const SETTINGS_KEY = 'serial-connection-settings';
const ENUMERATION_INTERVAL_MS = 1000;
const PROBE_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 3000;
const BACKOFF_MS = [5000, 10000, 20000, 40000, 60000];

function serviceError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function loadSerialPort() {
  // Kept lazy so installations without the native binding can still start with
  // serial auto-connect disabled and report a useful error on first use.
  return require('serialport').SerialPort;
}

function callbackOperation(action) {
  return new Promise((resolve, reject) => {
    action((error) => (error ? reject(error) : resolve()));
  });
}

class SerialConnectionService {
  constructor(options = {}) {
    this.SerialPortClass = options.SerialPortClass || null;
    this.listPortsImpl = options.listPorts || null;
    this.deviceService = options.deviceService || deviceService;
    this.storage = options.storage || fileStorage;
    this.now = options.now || (() => Date.now());
    this.setIntervalFn = options.setInterval || setInterval;
    this.clearIntervalFn = options.clearInterval || clearInterval;
    this.setTimeoutFn = options.setTimeout || setTimeout;
    this.clearTimeoutFn = options.clearTimeout || clearTimeout;

    this.settings = this.loadSettings();
    this.portInfo = new Map();
    this.sessions = new Map();
    this.devicePaths = new Map();
    this.pendingConnections = new Map();
    this.probes = new Map();
    this.pollTimer = null;
    this.polling = false;
    this.stopping = false;
  }

  loadSettings() {
    try {
      const raw = this.storage.getItem(SETTINGS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return { autoConnect: parsed?.autoConnect === true };
    } catch (_) {
      return { autoConnect: false };
    }
  }

  saveSettings() {
    this.storage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
  }

  getSerialPortClass() {
    if (!this.SerialPortClass) this.SerialPortClass = loadSerialPort();
    return this.SerialPortClass;
  }

  async listNativePorts() {
    if (this.listPortsImpl) return this.listPortsImpl();
    return this.getSerialPortClass().list();
  }

  getSettings() {
    return { ...this.settings };
  }

  async setSettings(patch = {}) {
    if (typeof patch.autoConnect !== 'boolean') {
      throw serviceError('AUTO_CONNECT_REQUIRED', 'autoConnect must be a boolean', 400);
    }
    this.settings.autoConnect = patch.autoConnect;
    this.saveSettings();
    if (this.settings.autoConnect) await this.startAutoConnect();
    else await this.stopAutoConnect({ cancelProbes: true });
    return this.getSettings();
  }

  async start() {
    if (this.settings.autoConnect) await this.startAutoConnect();
    return this.getSettings();
  }

  async startAutoConnect() {
    if (this.pollTimer) return;
    await this.pollPorts();
    this.pollTimer = this.setIntervalFn(() => {
      this.pollPorts().catch((error) => {
        logger.warn('Serial', `串口枚举失败: ${error?.message || error}`);
      });
    }, ENUMERATION_INTERVAL_MS);
  }

  async stopAutoConnect(options = {}) {
    if (this.pollTimer) {
      this.clearIntervalFn(this.pollTimer);
      this.pollTimer = null;
    }
    if (options.cancelProbes) {
      for (const probe of this.probes.values()) {
        if (probe.automatic) probe.cancel();
      }
      await Promise.allSettled([...this.pendingConnections.values()]);
    }
  }

  async listPorts() {
    await this.refreshPortList();
    return this.serializePorts();
  }

  serializePorts() {
    const now = this.now();
    return [...this.portInfo.values()]
      .map((info) => {
        const session = this.sessions.get(info.path);
        const pending = this.pendingConnections.has(info.path);
        const inBackoff = !session && !pending && info.nextRetryAt > now;
        return {
          ...info.port,
          path: info.path,
          status: session ? 'connected' : pending ? 'probing' : inBackoff ? 'backoff' : 'idle',
          deviceId: session?.deviceId || null,
          firmwareVersion: session?.firmwareVersion || null,
          retryAt: inBackoff ? new Date(info.nextRetryAt).toISOString() : null,
          lastError: info.lastError || null,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async refreshPortList() {
    let ports;
    try {
      ports = await this.listNativePorts();
    } catch (error) {
      throw serviceError('SERIAL_ENUMERATION_FAILED', error?.message || 'Unable to enumerate serial ports', 500);
    }

    const present = new Set();
    for (const port of ports) {
      if (!port?.path) continue;
      present.add(port.path);
      const previous = this.portInfo.get(port.path);
      this.portInfo.set(port.path, {
        path: port.path,
        port: { ...port },
        failures: previous?.failures || 0,
        nextRetryAt: previous?.nextRetryAt || 0,
        lastError: previous?.lastError || null,
      });
    }

    for (const path of [...this.portInfo.keys()]) {
      if (present.has(path)) continue;
      this.portInfo.delete(path);
      const session = this.sessions.get(path);
      if (session) await this.closeSession(session, 'removed');
    }
    return ports;
  }

  async pollPorts() {
    if (this.polling || !this.settings.autoConnect) return;
    this.polling = true;
    try {
      await this.refreshPortList();
      const now = this.now();
      for (const info of this.portInfo.values()) {
        if (this.sessions.has(info.path) || this.pendingConnections.has(info.path)) continue;
        if (info.nextRetryAt > now) continue;
        this.connect(info.path, { automatic: true }).catch(() => {});
      }
    } finally {
      this.polling = false;
    }
  }

  async connect(path, options = {}) {
    const normalizedPath = typeof path === 'string' ? path.trim() : '';
    if (!normalizedPath) throw serviceError('SERIAL_PATH_REQUIRED', 'Serial port path is required', 400);
    if (this.stopping) throw serviceError('SERIAL_SERVICE_STOPPING', 'Serial service is stopping', 409);

    const existing = this.sessions.get(normalizedPath);
    if (existing) return this.deviceService.getDeviceForApi(existing.deviceId);
    if (this.pendingConnections.has(normalizedPath)) return this.pendingConnections.get(normalizedPath);

    const info = this.portInfo.get(normalizedPath) || {
      path: normalizedPath,
      port: { path: normalizedPath },
      failures: 0,
      nextRetryAt: 0,
      lastError: null,
    };
    this.portInfo.set(normalizedPath, info);
    if (!options.automatic) info.nextRetryAt = 0;

    const pending = this.openAndProbe(info, options)
      .catch((error) => {
        this.recordFailure(info, error);
        throw error;
      })
      .finally(() => this.pendingConnections.delete(normalizedPath));
    this.pendingConnections.set(normalizedPath, pending);
    return pending;
  }

  recordFailure(info, error) {
    const index = Math.min(info.failures, BACKOFF_MS.length - 1);
    info.failures += 1;
    info.nextRetryAt = this.now() + BACKOFF_MS[index];
    info.lastError = error?.message || String(error);
  }

  async openAndProbe(info, options = {}) {
    const SerialPortClass = this.getSerialPortClass();
    let port;
    try {
      port = new SerialPortClass({
        path: info.path,
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false,
      });
    } catch (error) {
      throw serviceError('SERIAL_OPEN_FAILED', error?.message || 'Unable to create serial port', 409);
    }

    const parser = new SerialLineParser();
    let settled = false;
    let probeTimer = null;
    let timeoutTimer = null;
    const bufferedChunks = [];
    let bufferIncoming = null;

    const closePort = async () => {
      if (!port.isOpen) return;
      try { await callbackOperation((done) => port.close(done)); } catch (_) {}
    };

    try {
      await callbackOperation((done) => port.open(done));
    } catch (error) {
      throw serviceError('SERIAL_OPEN_FAILED', error?.message || 'Unable to open serial port', 409);
    }
    if (this.stopping || (options.automatic && !this.settings.autoConnect)) {
      await closePort();
      throw serviceError('SERIAL_PROBE_CANCELLED', 'Serial probe was cancelled', 409);
    }

    const identity = await new Promise((resolve, reject) => {
      let cleanupProbeListeners = () => {};
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (probeTimer) this.clearIntervalFn(probeTimer);
        if (timeoutTimer) this.clearTimeoutFn(timeoutTimer);
        this.probes.delete(info.path);
        if (!error) {
          bufferIncoming = (chunk) => bufferedChunks.push(chunk);
          port.on('data', bufferIncoming);
        }
        cleanupProbeListeners();
        if (error) reject(error);
        else resolve(value);
      };
      const onData = (chunk) => {
        const events = parser.push(chunk);
        for (let index = 0; index < events.length; index += 1) {
          const event = events[index];
          if (event.type === 'ready') {
            return finish(null, { ...event, remainingEvents: events.slice(index + 1) });
          }
          if (event.type === 'invalid-ready') {
            return finish(serviceError('SERIAL_IDENTITY_INVALID', '设备串口身份无效或固件协议过旧', 409));
          }
        }
      };
      const onError = (error) => finish(serviceError('SERIAL_PROBE_FAILED', error?.message || 'Serial probe failed', 409));
      const onClose = () => finish(serviceError('SERIAL_PROBE_CLOSED', 'Serial port closed during probe', 409));
      port.on('data', onData);
      port.once('error', onError);
      port.once('close', onClose);

      cleanupProbeListeners = () => {
        port.off('data', onData);
        port.off('error', onError);
        port.off('close', onClose);
      };
      this.probes.set(info.path, {
        automatic: !!options.automatic,
        cancel: () => finish(serviceError('SERIAL_PROBE_CANCELLED', 'Serial probe was cancelled', 409)),
      });

      const sendStart = () => {
        if (!port.isOpen) return;
        port.write('@DEBUG START\r\n', (error) => {
          if (error) finish(serviceError('SERIAL_PROBE_FAILED', error.message, 409));
        });
      };
      sendStart();
      probeTimer = this.setIntervalFn(sendStart, PROBE_INTERVAL_MS);
      timeoutTimer = this.setTimeoutFn(() => finish(
        serviceError('SERIAL_PROBE_TIMEOUT', '设备在 3 秒内未返回有效串口身份', 408),
      ), PROBE_TIMEOUT_MS);
    }).catch(async (error) => {
      this.probes.delete(info.path);
      if (bufferIncoming) port.off('data', bufferIncoming);
      await closePort();
      throw error;
    });

    if (this.devicePaths.has(identity.deviceId)) {
      await closePort();
      throw serviceError('SERIAL_DEVICE_ALREADY_CONNECTED', '该设备已有串口连接', 409);
    }

    const session = {
      path: info.path,
      port,
      parser,
      deviceId: identity.deviceId,
      firmwareVersion: identity.firmwareVersion,
      closing: false,
      writeQueue: Promise.resolve(),
      onData: null,
      onError: null,
      onClose: null,
    };
    session.adapter = {
      kind: 'serial',
      send: (message) => {
        this.enqueueWrite(session, message).catch((error) => {
          logger.warn('Serial', `串口 ${session.path} 写入失败: ${error?.message || error}`);
          this.closeSession(session, 'write-error').catch(() => {});
        });
      },
      disconnect: () => this.closeSession(session, 'device-removed'),
    };

    session.onData = (chunk) => this.handleSessionData(session, chunk);
    session.onError = (error) => {
      logger.warn('Serial', `串口 ${session.path} 错误: ${error?.message || error}`);
      this.closeSession(session, 'error').catch(() => {});
    };
    session.onClose = () => this.handlePortClosed(session);
    port.on('data', session.onData);
    port.on('error', session.onError);
    port.on('close', session.onClose);
    if (bufferIncoming) port.off('data', bufferIncoming);

    this.sessions.set(info.path, session);
    this.devicePaths.set(identity.deviceId, info.path);
    info.failures = 0;
    info.nextRetryAt = 0;
    info.lastError = null;

    const apiDevice = this.deviceService.connectTransportDevice({
      id: identity.deviceId,
      type: 'base',
      connectionType: 'serial',
      firmwareVersion: identity.firmwareVersion,
      transportMetadata: { portPath: info.path },
      data: { ver: identity.firmwareVersion },
    }, session.adapter);
    for (const event of identity.remainingEvents || []) this.handleSessionEvent(session, event);
    for (const chunk of bufferedChunks) this.handleSessionData(session, chunk);
    return this.deviceService.getDeviceForApi(identity.deviceId) || apiDevice;
  }

  handleSessionData(session, chunk) {
    for (const event of session.parser.push(chunk)) {
      this.handleSessionEvent(session, event);
    }
  }

  handleSessionEvent(session, event) {
    if (event.type === 'message') {
      this.deviceService.handleTransportMessage(session.deviceId, event.message, 'serial');
    }
  }

  enqueueWrite(session, message) {
    const encoded = encodeCommand(message);
    const write = async () => {
      if (session.closing || !session.port.isOpen) {
        throw serviceError('SERIAL_CONNECTION_CLOSED', 'Serial connection is closed', 409);
      }
      await callbackOperation((done) => session.port.write(encoded, done));
      if (typeof session.port.drain === 'function') {
        await callbackOperation((done) => session.port.drain(done));
      }
    };
    const result = session.writeQueue.then(write);
    session.writeQueue = result.catch(() => {});
    return result;
  }

  async disconnectDevice(deviceId) {
    const path = this.devicePaths.get(deviceId);
    if (!path) return false;
    await this.closeSession(this.sessions.get(path), 'manual');
    return true;
  }

  async closeSession(session, reason) {
    if (!session || session.closing) return;
    await session.writeQueue.catch(() => {});
    session.closing = true;
    this.sessions.delete(session.path);
    this.devicePaths.delete(session.deviceId);
    this.deviceService.disconnectTransportDevice(session.deviceId, 'serial');
    session.port.off('data', session.onData);
    session.port.off('error', session.onError);
    session.port.off('close', session.onClose);
    if (session.port.isOpen) {
      try { await callbackOperation((done) => session.port.close(done)); } catch (_) {}
    }
    logger.info('Serial', `串口 ${session.path} 已断开 (${reason})`);
  }

  handlePortClosed(session) {
    if (session.closing) return;
    session.closing = true;
    this.sessions.delete(session.path);
    this.devicePaths.delete(session.deviceId);
    this.deviceService.disconnectTransportDevice(session.deviceId, 'serial');
  }

  async shutdown() {
    this.stopping = true;
    await this.stopAutoConnect();
    for (const probe of this.probes.values()) probe.cancel();
    await Promise.allSettled([...this.pendingConnections.values()]);
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => this.closeSession(session, 'shutdown')));
    this.stopping = false;
  }

  resetForTests() {
    this.stopAutoConnect();
    this.portInfo.clear();
    this.sessions.clear();
    this.devicePaths.clear();
    this.pendingConnections.clear();
    this.probes.clear();
    this.stopping = false;
  }
}

const serialConnectionService = new SerialConnectionService();

module.exports = serialConnectionService;
module.exports.SerialConnectionService = SerialConnectionService;
module.exports.constants = {
  SETTINGS_KEY,
  ENUMERATION_INTERVAL_MS,
  PROBE_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  BACKOFF_MS,
};
