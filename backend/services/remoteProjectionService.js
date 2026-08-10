const mqtt = require('mqtt');
const { randomUUID } = require('crypto');
const deviceService = require('./deviceService');
const roomApi = require('./roomApiService');
const logService = require('./logService');

const PROTOCOL_VERSION = 1;
const DEFAULT_TTL_SEC = 3600;
const DEFAULT_LIMITS = Object.freeze({ voltage: 20, power: 128 });
const HEARTBEAT_MS = 10000;
const CREDENTIAL_REFRESH_EARLY_MS = 2 * 60 * 1000;
const MAX_SEEN_MESSAGE_IDS = 1024;

function normalizePositiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeLimits(input = {}) {
  return {
    voltage: normalizePositiveInt(input.voltage, DEFAULT_LIMITS.voltage, 0, 100),
    power: normalizePositiveInt(input.power, DEFAULT_LIMITS.power, 0, 255),
  };
}

function parseJson(payload) {
  try {
    return JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload));
  } catch (_) {
    return null;
  }
}

class RemoteProjectionService {
  constructor({
    devices = deviceService,
    api = roomApi,
    mqttConnect = mqtt.connect,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    setRepeating = setInterval,
    clearRepeating = clearInterval,
  } = {}) {
    this.devices = devices;
    this.api = api;
    this.mqttConnect = mqttConnect;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.setRepeating = setRepeating;
    this.clearRepeating = clearRepeating;
    this.session = null;

    this.devices.onDeviceDataChange?.((event) => this._onLocalDataChange(event));
    this.devices.onDeviceRawMessage?.((event) => this._onLocalRawMessage(event));
  }

  getStatus() {
    const session = this.session;
    if (!session) {
      return { active: false, apiBaseUrl: this.api.getBaseUrl?.() || null };
    }
    const listedDevices = session.role === 'owner'
      ? this._ownerDevices().map((device) => this._deviceDescriptor(device, session))
      : [...session.remoteDeviceIds].map((id) => this.devices.getDeviceForApi?.(id)).filter(Boolean);
    return {
      active: true,
      role: session.role,
      roomId: session.room.id,
      joinCode: session.role === 'owner' ? session.room.joinCode : null,
      connected: session.connected,
      expired: session.expired,
      controlTtlSec: session.controlTtlSec,
      controlExpiresAt: new Date(session.controlExpiresAt).toISOString(),
      limits: { ...session.limits },
      devices: listedDevices,
      operatorCount: session.role === 'owner'
        ? [...session.operatorsOnline.values()].filter(Boolean).length
        : undefined,
      lastError: session.lastError,
      apiBaseUrl: this.api.getBaseUrl?.() || null,
    };
  }

  async create({ token, controlTtlSec = DEFAULT_TTL_SEC, limits, capacity = 8 } = {}) {
    if (!token) throw this._error('MISSING_TOKEN', '请先登录账号');
    await this.stop({ skipApi: false });
    const ttl = normalizePositiveInt(controlTtlSec, DEFAULT_TTL_SEC, 60, 24 * 60 * 60);
    const normalizedLimits = normalizeLimits(limits);
    const room = await this.api.createRoom(token, normalizePositiveInt(capacity, 8, 2, 32));
    let session = null;
    try {
      await this.api.activateRoom(token, room.id);
      const credential = await this.api.getMqttCredential(token, room.id);
      session = this._newSession({
        role: 'owner', token, room, credential,
        controlTtlSec: ttl,
        limits: normalizedLimits,
      });
      this.session = session;
      await this._connect(session);
      this._startOwnerTimers(session);
      return this.getStatus();
    } catch (error) {
      this.session = null;
      if (session) {
        this._clearTimers(session);
        await this._endClient(session, true);
      }
      await this.api.closeRoom(token, room.id).catch(() => {});
      throw error;
    }
  }

  async join({ token, joinCode } = {}) {
    if (!token) throw this._error('MISSING_TOKEN', '请先登录账号');
    const code = String(joinCode || '').trim();
    if (!code) throw this._error('JOIN_CODE_REQUIRED', '请输入房间码');
    await this.stop({ skipApi: false });
    const room = await this.api.joinRoom(token, code);
    let session = null;
    try {
      const credential = await this.api.getMqttCredential(token, room.id);
      session = this._newSession({
        role: 'operator', token, room, credential,
        controlTtlSec: DEFAULT_TTL_SEC,
        limits: DEFAULT_LIMITS,
      });
      this.session = session;
      await this._connect(session);
      return this.getStatus();
    } catch (error) {
      this.session = null;
      if (session) {
        this._clearTimers(session);
        await this._endClient(session, true);
      }
      await this.api.leaveRoom(token, room.id).catch(() => {});
      throw error;
    }
  }

  async stop({ skipApi = false } = {}) {
    const session = this.session;
    if (!session) return { active: false };
    this.session = null;
    this._clearTimers(session);
    if (session.role === 'owner') await this._safeStop(session, 'projection-stop');
    await this._publishPresence(session, 'offline').catch(() => {});
    await this._endClient(session);
    this._removeRemoteDevices(session);
    if (!skipApi) {
      const closeCall = session.role === 'owner' ? this.api.closeRoom : this.api.leaveRoom;
      await closeCall.call(this.api, session.token, session.room.id).catch((error) => {
        session.lastError = error?.message || String(error);
      });
    }
    return { active: false };
  }

  async shutdown() {
    return this.stop({ skipApi: true });
  }

  _newSession({ role, token, room, credential, controlTtlSec, limits }) {
    const startedAt = this.now();
    return {
      role,
      token,
      room,
      roomSessionId: `${room.id}:${room.hostEpoch}`,
      credential,
      client: null,
      connected: false,
      expired: false,
      stopped: false,
      lastError: null,
      controlTtlSec,
      controlExpiresAt: startedAt + controlTtlSec * 1000,
      limits: { ...limits },
      sequences: new Map(),
      seenMessageIds: new Set(),
      remoteDeviceIds: new Set(),
      operatorsOnline: new Map(),
      timers: { ttl: null, heartbeat: null, credential: null },
    };
  }

  _connect(session) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const client = this.mqttConnect(session.credential.brokerUrl, {
        protocolVersion: 5,
        clean: true,
        clientId: session.credential.clientId,
        username: session.credential.username,
        password: session.credential.password,
        reconnectPeriod: 2000,
        will: {
          topic: this._presenceTopic(session),
          payload: JSON.stringify({ status: 'offline' }),
          qos: 1,
          retain: true,
        },
      });
      session.client = client;
      client.on('message', (topic, payload) => this._onMessage(session, topic, payload));
      client.on('error', (error) => {
        session.lastError = error?.message || String(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      client.on('close', () => {
        session.connected = false;
        if (this.session !== session) return;
        if (session.role === 'owner') {
          void this._safeStop(session, 'mqtt-disconnected');
        } else {
          this._removeRemoteDevices(session);
        }
      });
      client.on('connect', () => {
        this._afterConnect(session).then(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, (error) => {
          session.lastError = error?.message || String(error);
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      });
    });
  }

  async _afterConnect(session) {
    if (this.session !== session) return;
    const base = `rooms/${session.room.id}`;
    const topics = session.role === 'owner'
      ? [`${base}/commands/+`, `${base}/presence/+`]
      : [`${base}/events`, `${base}/presence/${session.room.hostUserId}`];
    await this._subscribe(session, topics);
    await this._publishPresence(session, 'online');
    session.connected = true;
    session.lastError = null;
    this._scheduleCredentialRefresh(session);
    if (session.role === 'operator') {
      await this._publishEnvelope(session, `commands/${session.credential.userId}`, 'projection.device-list.request', {});
    }
  }

  _subscribe(session, topics) {
    return new Promise((resolve, reject) => {
      session.client.subscribe(topics, { qos: 1 }, (error) => error ? reject(error) : resolve());
    });
  }

  _publish(session, topic, payload, options = { qos: 1, retain: false }) {
    return new Promise((resolve, reject) => {
      if (!session.client) return reject(this._error('ROOM_DISCONNECTED', '房间连接不可用'));
      session.client.publish(topic, payload, options, (error) => error ? reject(error) : resolve());
    });
  }

  _publishEnvelope(session, suffix, type, payload) {
    const sequence = (session.sequences.get(suffix) || 0) + 1;
    session.sequences.set(suffix, sequence);
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      roomSessionId: session.roomSessionId,
      messageId: randomUUID(),
      type,
      senderConnectionEpoch: session.credential.clientId,
      sequence,
      timestamp: new Date(this.now()).toISOString(),
      payload,
    };
    return this._publish(
      session,
      `rooms/${session.room.id}/${suffix}`,
      JSON.stringify(envelope),
    ).catch((error) => {
      session.lastError = error?.message || String(error);
      throw error;
    });
  }

  _publishPresence(session, status) {
    if (!session.client) return Promise.resolve();
    return this._publish(
      session,
      this._presenceTopic(session),
      JSON.stringify({ status }),
      { qos: 1, retain: true },
    );
  }

  _presenceTopic(session) {
    return `rooms/${session.room.id}/presence/${session.credential.userId}`;
  }

  _onMessage(session, topic, rawPayload) {
    if (this.session !== session) return;
    const base = `rooms/${session.room.id}/`;
    if (!topic.startsWith(base)) return;
    const suffix = topic.slice(base.length);
    if (suffix.startsWith('presence/')) {
      this._onPresence(session, suffix.slice('presence/'.length), parseJson(rawPayload));
      return;
    }
    const envelope = parseJson(rawPayload);
    if (!envelope || envelope.protocolVersion !== PROTOCOL_VERSION
        || envelope.roomSessionId !== session.roomSessionId) return;
    if (typeof envelope.messageId !== 'string' || !envelope.messageId
        || session.seenMessageIds.has(envelope.messageId)) return;
    session.seenMessageIds.add(envelope.messageId);
    if (session.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
      session.seenMessageIds.delete(session.seenMessageIds.values().next().value);
    }
    if (session.role === 'owner' && suffix.startsWith('commands/')) {
      this._onOwnerCommand(session, suffix.slice('commands/'.length), envelope);
    } else if (session.role === 'operator' && suffix === 'events') {
      this._onOperatorEvent(session, envelope);
    }
  }

  _onPresence(session, userId, payload) {
    const online = payload?.status === 'online';
    if (session.role === 'owner') {
      if (!userId || userId === session.credential.userId) return;
      session.operatorsOnline.set(userId, online);
      if (online) {
        void this._publishDeviceList(session).catch(() => {});
      } else if (![...session.operatorsOnline.values()].some(Boolean)) {
        void this._safeStop(session, 'all-operators-offline');
      }
    } else if (userId === session.room.hostUserId && !online) {
      this._removeRemoteDevices(session);
    }
  }

  _onOwnerCommand(session, userId, envelope) {
    if (!userId) return;
    if (envelope.type === 'projection.device-list.request') {
      void this._publishDeviceList(session).catch(() => {});
      return;
    }
    if (envelope.type !== 'projection.write') {
      return;
    }
    if (session.expired || this.now() >= session.controlExpiresAt) {
      if (this._expireOwnerSession(session, 'control-ttl-expired-on-write')) {
        void this._publishEnvelope(session, 'events', 'projection.expired', {}).catch(() => {});
      }
      return;
    }
    const input = envelope.payload;
    if (!input || typeof input !== 'object' || typeof input.deviceId !== 'string'
        || !input.message || typeof input.message !== 'object' || Array.isArray(input.message)) return;
    const device = this.devices.getDeviceForApi?.(input.deviceId);
    if (!device || !this._hasLocalConnection(device)) return;
    const message = this._clampMessage(input.message, session.limits);
    try {
      this.devices.publishDeviceMessage(input.deviceId, message);
    } catch (error) {
      session.lastError = error?.message || String(error);
    }
  }

  _onOperatorEvent(session, envelope) {
    const payload = envelope.payload;
    if (envelope.type === 'projection.device-list') {
      this._applyDeviceList(session, payload);
    } else if (envelope.type === 'projection.device-state') {
      if (!payload || !session.remoteDeviceIds.has(payload.deviceId)) return;
      this.devices.handleTransportMessage(
        payload.deviceId,
        { method: 'update', ...(payload.data || {}) },
        'remote',
      );
    } else if (envelope.type === 'projection.device-message') {
      if (!payload || !session.remoteDeviceIds.has(payload.deviceId)) return;
      this.devices.handleTransportMessage(payload.deviceId, payload.message, 'remote');
    } else if (envelope.type === 'projection.expired') {
      session.expired = true;
      this._removeRemoteDevices(session);
    }
  }

  _applyDeviceList(session, payload) {
    if (!payload || !Array.isArray(payload.devices)) return;
    session.controlExpiresAt = Date.parse(payload.controlExpiresAt) || session.controlExpiresAt;
    session.controlTtlSec = Number(payload.controlTtlSec) || session.controlTtlSec;
    session.limits = normalizeLimits(payload.limits);
    if (session.expired || this.now() >= session.controlExpiresAt) {
      session.expired = true;
      this._removeRemoteDevices(session);
      return;
    }
    const nextIds = new Set();
    for (const item of payload.devices) {
      if (!item || typeof item.deviceId !== 'string' || typeof item.deviceType !== 'string') continue;
      nextIds.add(item.deviceId);
      const adapter = {
        kind: 'remote',
        send: (message) => {
          if (this.session !== session || !session.connected) {
            throw this._error('ROOM_DISCONNECTED', '房间连接不可用');
          }
          if (session.expired || this.now() >= session.controlExpiresAt) {
            session.expired = true;
            this._removeRemoteDevices(session);
            throw this._error('CONTROL_EXPIRED', '远程控制已过期');
          }
          void this._publishEnvelope(
            session,
            `commands/${session.credential.userId}`,
            'projection.write',
            { deviceId: item.deviceId, message },
          ).catch(() => {});
          return { queued: true };
        },
      };
      this.devices.connectTransportDevice({
        id: item.deviceId,
        name: item.name,
        type: item.deviceType,
        connectionType: 'remote',
        data: item.data || {},
        transportMetadata: { roomId: session.room.id, ownerUserId: session.room.hostUserId },
      }, adapter);
    }
    for (const oldId of session.remoteDeviceIds) {
      if (!nextIds.has(oldId)) this.devices.disconnectTransportDevice(oldId, 'remote');
    }
    session.remoteDeviceIds = nextIds;
  }

  _publishDeviceList(session) {
    if (session.expired || this.now() >= session.controlExpiresAt) {
      this._expireOwnerSession(session, 'control-ttl-expired-on-device-list');
      return this._publishEnvelope(session, 'events', 'projection.expired', {});
    }
    return this._publishEnvelope(session, 'events', 'projection.device-list', {
      devices: this._ownerDevices().map((device) => this._deviceDescriptor(device, session)),
      limits: session.limits,
      controlTtlSec: session.controlTtlSec,
      controlExpiresAt: new Date(session.controlExpiresAt).toISOString(),
    });
  }

  _deviceDescriptor(device) {
    return {
      deviceId: device.id,
      deviceType: device.type,
      name: device.nickname || device.name,
      connectionType: device.connectionType,
      data: device.data || {},
    };
  }

  _ownerDevices() {
    return (this.devices.listDevicesForApi?.() || []).filter((device) => (
      device.connected && this._hasLocalConnection(device)
    ));
  }

  _hasLocalConnection(device) {
    return Array.isArray(device.connections)
      && device.connections.some((connection) => connection.type !== 'remote' && connection.connected !== false);
  }

  _clampMessage(message, limits) {
    const output = { ...message };
    if (output.shock && !Object.prototype.hasOwnProperty.call(output, 'voltage')) {
      output.voltage = 0;
    }
    for (const [key, maximum] of Object.entries(limits)) {
      if (!Object.prototype.hasOwnProperty.call(output, key)) continue;
      const value = Number(output[key]);
      output[key] = Number.isFinite(value) ? Math.min(maximum, Math.max(0, value)) : 0;
    }
    return output;
  }

  _onLocalDataChange({ deviceId, device, nextData }) {
    const session = this.session;
    if (!session || session.role !== 'owner' || !this._hasLocalConnection(this.devices.getDeviceForApi?.(deviceId) || device)) return;
    void this._publishEnvelope(session, 'events', 'projection.device-state', {
      deviceId,
      data: nextData || device?.data || {},
    }).catch(() => {});
  }

  _onLocalRawMessage({ deviceId, payload }) {
    const session = this.session;
    if (!session || session.role !== 'owner' || payload?.method === 'report' || payload?.method === 'update') return;
    const device = this.devices.getDeviceForApi?.(deviceId);
    if (!device || !this._hasLocalConnection(device)) return;
    void this._publishEnvelope(session, 'events', 'projection.device-message', {
      deviceId,
      message: payload,
    }).catch(() => {});
  }

  _startOwnerTimers(session) {
    const delay = Math.max(0, session.controlExpiresAt - this.now());
    session.timers.ttl = this.setTimer(() => {
      if (this.session !== session) return;
      if (this._expireOwnerSession(session, 'control-ttl-expired')) {
        void this._publishEnvelope(session, 'events', 'projection.expired', {}).catch(() => {});
      }
    }, delay);
    session.timers.heartbeat = this.setRepeating(() => {
      if (this.session !== session) return;
      void this.api.heartbeat(session.token, session.room.id).catch((error) => {
        session.lastError = error?.message || String(error);
      });
      void this._publishDeviceList(session).catch(() => {});
    }, HEARTBEAT_MS);
  }

  _scheduleCredentialRefresh(session) {
    if (session.timers.credential) this.clearTimer(session.timers.credential);
    const expiresAt = Date.parse(session.credential.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const delay = Math.max(1000, expiresAt - this.now() - CREDENTIAL_REFRESH_EARLY_MS);
    session.timers.credential = this.setTimer(() => {
      void this._refreshCredential(session);
    }, delay);
  }

  async _refreshCredential(session) {
    if (this.session !== session || !session.client) return;
    try {
      const credential = await this.api.getMqttCredential(
        session.token,
        session.room.id,
        session.credential.clientId,
      );
      session.credential = credential;
      Object.assign(session.client.options, {
        username: credential.username,
        password: credential.password,
        clientId: credential.clientId,
      });
      session.client.reconnect();
      this._scheduleCredentialRefresh(session);
    } catch (error) {
      session.lastError = error?.message || String(error);
      session.timers.credential = this.setTimer(() => this._refreshCredential(session), 30000);
    }
  }

  async _safeStop(session, reason) {
    if (session.role !== 'owner') return;
    for (const device of this._ownerDevices()) {
      try { this.devices.invokeDeviceClose(device.id); } catch (_) {}
    }
    logService.info('RemoteProjection', `safe stop: ${reason}`);
  }

  _expireOwnerSession(session, reason) {
    if (session.expired) return false;
    session.expired = true;
    void this._safeStop(session, reason);
    return true;
  }

  _removeRemoteDevices(session) {
    for (const deviceId of session.remoteDeviceIds) {
      this.devices.disconnectTransportDevice(deviceId, 'remote');
    }
    session.remoteDeviceIds.clear();
  }

  _clearTimers(session) {
    if (session.timers.ttl) this.clearTimer(session.timers.ttl);
    if (session.timers.credential) this.clearTimer(session.timers.credential);
    if (session.timers.heartbeat) this.clearRepeating(session.timers.heartbeat);
    session.timers = { ttl: null, heartbeat: null, credential: null };
  }

  _endClient(session, force = false) {
    if (!session.client) return Promise.resolve();
    const client = session.client;
    session.client = null;
    return new Promise((resolve) => {
      try { client.end(force, {}, resolve); } catch (_) { resolve(); }
    });
  }

  _error(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
}

const remoteProjectionService = new RemoteProjectionService();

module.exports = remoteProjectionService;
module.exports.RemoteProjectionService = RemoteProjectionService;
module.exports.normalizeLimits = normalizeLimits;
