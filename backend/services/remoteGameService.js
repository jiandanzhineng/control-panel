const mqtt = require('mqtt');
const { randomUUID } = require('crypto');
const manifest = require('../game-runtime/cores/surge-edging-manifest');

const PROTOCOL_VERSION = 1;
const MAX_SEEN_MESSAGE_IDS = 1024;
const HEARTBEAT_MS = 10000;
const COMMAND_TIMEOUT_MS = 8000;
const COMMANDS = new Set([
  'client.snapshot.request',
  'game.start',
  'game.setParams',
  'game.pause',
  'game.resume',
  'game.stop',
  'game.action',
]);

function parseJson(payload) {
  try {
    return JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload));
  } catch (_) {
    return null;
  }
}

function defaultListGames() {
  const hostGame = {
    id: manifest.GAME_ID,
    title: manifest.TITLE,
    version: manifest.VERSION,
    runtimeMode: 'host',
    devices: manifest.DEVICES,
    params: manifest.PARAMS,
  };
  let rows = [];
  try {
    rows = require('./gameService').listGames().map((game) => ({
      id: game.id,
      title: game.name || game.title || game.id,
      version: game.version || '1.0.0',
      runtimeMode: game.id === manifest.GAME_ID ? 'host' : 'iframe',
      devices: game.devices || [],
      params: game.params || [],
    }));
  } catch (_) {}
  const byId = new Map(rows.map((row) => [row.id, row]));
  byId.set(hostGame.id, { ...(byId.get(hostGame.id) || {}), ...hostGame });
  return [...byId.values()];
}

class RemoteGameService {
  constructor({
    host,
    api,
    mqttConnect = mqtt.connect,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    setRepeating = setInterval,
    clearRepeating = clearInterval,
    listGames = defaultListGames,
    listDevices = null,
  } = {}) {
    this.host = host || require('../game-runtime/gameHostService');
    this.api = api || require('./roomApiService');
    this.mqttConnect = mqttConnect;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.setRepeating = setRepeating;
    this.clearRepeating = clearRepeating;
    this.listGames = listGames;
    this.listDevices = listDevices;
    this.session = null;
  }

  getStatus() {
    const session = this.session;
    if (!session) {
      return {
        active: false,
        authorized: false,
        devices: [],
        games: [],
        apiBaseUrl: this.api.getBaseUrl?.() || null,
      };
    }
    const hostStatus = session.role === 'owner' ? this._hostStatus() : null;
    return {
      active: true,
      role: session.role,
      roomId: session.room.id,
      joinCode: session.role === 'owner' ? session.room.joinCode : null,
      connected: session.connected,
      authorized: !!session.authorized,
      operatorOnline: session.role === 'owner'
        ? [...session.operatorsOnline.values()].some(Boolean)
        : undefined,
      games: session.role === 'owner' ? this.listGames() : session.games,
      devices: session.role === 'owner' ? this._deviceList() : session.devices,
      snapshot: session.role === 'owner' ? hostStatus?.snapshot || null : session.gameSnapshot,
      lastError: session.lastError,
      apiBaseUrl: this.api.getBaseUrl?.() || null,
    };
  }

  async create({ token } = {}) {
    if (!token) throw this._error('MISSING_TOKEN', '请先登录账号');
    await this.stop({ skipApi: false, reason: 'replaced' });
    const room = await this.api.createRoom(token, 2, { gameId: 'remote-game', gameVersion: '1.0.0' });
    let session = null;
    try {
      await this.api.activateRoom(token, room.id);
      const credential = await this.api.getMqttCredential(token, room.id);
      session = this._newSession({ role: 'owner', token, room, credential });
      this.session = session;
      session.hostUnsub = this.host.subscribe?.((status) => {
        session.gameSnapshot = status?.snapshot || null;
        if (!session.connected) return;
        const nowMs = this.now();
        if (session.lastPublishAt && nowMs - session.lastPublishAt < 200) return;
        session.lastPublishAt = nowMs;
        void this._publishGameSnapshot(session).catch(() => {});
      });
      await this._connect(session);
      session.timers.heartbeat = this.setRepeating(() => {
        void this.api.heartbeat(session.token, session.room.id).catch(() => {});
      }, HEARTBEAT_MS);
      return this.getStatus();
    } catch (error) {
      this.session = null;
      if (session) {
        this._clearTimers(session);
        session.hostUnsub?.();
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
    await this.stop({ skipApi: false, reason: 'replaced' });
    const room = await this.api.joinRoom(token, code);
    let session = null;
    try {
      const credential = await this.api.getMqttCredential(token, room.id);
      session = this._newSession({ role: 'operator', token, room, credential });
      this.session = session;
      await this._connect(session);
      return this.getStatus();
    } catch (error) {
      this.session = null;
      if (session) await this._endClient(session, true);
      await this.api.leaveRoom(token, room.id).catch(() => {});
      throw error;
    }
  }

  async authorize() {
    return this._setAuthorized(true);
  }

  async revoke() {
    return this._setAuthorized(false);
  }

  async command({ type, payload } = {}) {
    const session = this.session;
    if (!session || session.role !== 'operator') throw this._error('NOT_OPERATOR', '当前不是远程客户端');
    if (!COMMANDS.has(type)) throw this._error('COMMAND_NOT_ALLOWED', '命令不在白名单');
    const messageId = randomUUID();
    const response = new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        session.pending.delete(messageId);
        reject(this._error('COMMAND_TIMEOUT', '命令超时'));
      }, COMMAND_TIMEOUT_MS);
      session.pending.set(messageId, { resolve, reject, timer });
    });
    await this._publishEnvelope(session, `commands/${session.room.hostUserId}`, type, payload || {}, messageId);
    return response;
  }

  async stop({ skipApi = false, reason = 'room-closed' } = {}) {
    const session = this.session;
    if (!session) return this.getStatus();
    this.session = null;
    this._clearTimers(session);
    session.hostUnsub?.();
    session.hostUnsub = null;
    this._failPending(session, this._error('ROOM_DISCONNECTED', '房间连接不可用'));
    if (session.connected) {
      await this._publishEnvelope(session, 'events', 'session.revoked', { reason }).catch(() => {});
    }
    await this._publishPresence(session, 'offline').catch(() => {});
    await this._endClient(session);
    if (!skipApi) {
      const closeCall = session.role === 'owner' ? this.api.closeRoom : this.api.leaveRoom;
      await closeCall.call(this.api, session.token, session.room.id).catch((error) => {
        session.lastError = error?.message || String(error);
      });
    }
    return { active: false, authorized: false, devices: [], games: [] };
  }

  shutdown() {
    return this.stop({ skipApi: true, reason: 'backend-shutdown' });
  }

  async _setAuthorized(authorized) {
    const session = this.session;
    if (!session || session.role !== 'owner') throw this._error('NOT_OWNER', '只有主机可以授权');
    session.authorized = authorized;
    await this._publishEnvelope(session, 'events', 'client.authorization', { authorized });
    await this._publishClientSnapshot(session);
    return this.getStatus();
  }

  _newSession({ role, token, room, credential }) {
    return {
      role,
      token,
      room,
      credential,
      roomSessionId: `${room.id}:${room.hostEpoch}`,
      client: null,
      connected: false,
      authorized: false,
      lastError: null,
      sequences: new Map(),
      seenMessageIds: new Set(),
      operatorsOnline: new Map(),
      pending: new Map(),
      games: [],
      devices: [],
      gameSnapshot: null,
      timers: { heartbeat: null },
      hostUnsub: null,
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
      client.on('message', (topic, payload) => { void this._onMessage(session, topic, payload); });
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
        this._failPending(session, this._error('ROOM_DISCONNECTED', '房间连接不可用'));
        if (session.role === 'operator') session.devices = [];
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
      ? [`${base}/commands/${session.room.hostUserId}`, `${base}/presence/+`]
      : [`${base}/events`, `${base}/presence/${session.room.hostUserId}`];
    await this._subscribe(session, topics);
    await this._publishPresence(session, 'online');
    session.connected = true;
    session.lastError = null;
    if (session.role === 'operator') {
      await this._publishEnvelope(session, `commands/${session.room.hostUserId}`, 'client.snapshot.request', {});
    } else {
      await this._publishClientSnapshot(session);
    }
  }

  _subscribe(session, topics) {
    return new Promise((resolve, reject) => {
      session.client.subscribe(topics, { qos: 1 }, (error) => (error ? reject(error) : resolve()));
    });
  }

  _publish(session, topic, payload, options = { qos: 1, retain: false }) {
    return new Promise((resolve, reject) => {
      if (!session.client) return reject(this._error('ROOM_DISCONNECTED', '房间连接不可用'));
      session.client.publish(topic, payload, options, (error) => (error ? reject(error) : resolve()));
    });
  }

  _publishEnvelope(session, suffix, type, payload, messageId = randomUUID()) {
    const sequence = (session.sequences.get(suffix) || 0) + 1;
    session.sequences.set(suffix, sequence);
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      roomSessionId: session.roomSessionId,
      messageId,
      type,
      senderConnectionEpoch: session.credential.clientId,
      sequence,
      timestamp: new Date(this.now()).toISOString(),
      payload,
    };
    return this._publish(session, `rooms/${session.room.id}/${suffix}`, JSON.stringify(envelope));
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

  async _onMessage(session, topic, rawPayload) {
    if (this.session !== session) return;
    const base = `rooms/${session.room.id}/`;
    if (!String(topic).startsWith(base)) return;
    const suffix = String(topic).slice(base.length);
    if (suffix.startsWith('presence/')) {
      this._onPresence(session, suffix.slice('presence/'.length), parseJson(rawPayload));
      return;
    }
    const envelope = parseJson(rawPayload);
    if (!envelope || envelope.protocolVersion !== PROTOCOL_VERSION || envelope.roomSessionId !== session.roomSessionId) return;
    if (typeof envelope.messageId !== 'string' || !envelope.messageId || session.seenMessageIds.has(envelope.messageId)) return;
    session.seenMessageIds.add(envelope.messageId);
    if (session.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
      session.seenMessageIds.delete(session.seenMessageIds.values().next().value);
    }
    if (session.role === 'owner' && suffix === `commands/${session.room.hostUserId}`) {
      await this._onOwnerCommand(session, envelope);
    } else if (session.role === 'operator' && suffix === 'events') {
      this._onOperatorEvent(session, envelope);
    }
  }

  _onPresence(session, userId, payload) {
    const online = payload?.status === 'online';
    if (session.role === 'owner') {
      if (!userId || userId === session.credential.userId) return;
      session.operatorsOnline.set(userId, online);
      if (online) void this._publishClientSnapshot(session).catch(() => {});
      return;
    }
    if (userId === session.room.hostUserId && !online) {
      this._onOperatorEvent(session, { type: 'session.revoked', payload: { reason: 'host-offline' } });
    }
  }

  async _onOwnerCommand(session, envelope) {
    const type = envelope.type;
    if (!COMMANDS.has(type)) {
      await this._respond(session, envelope.messageId, { ok: false, code: 'COMMAND_NOT_ALLOWED', message: '命令不在白名单' });
      return;
    }
    if (type !== 'client.snapshot.request' && !session.authorized) {
      await this._respond(session, envelope.messageId, {
        ok: false,
        code: 'CONTROL_NOT_AUTHORIZED',
        message: '未授权远控',
      });
      return;
    }
    try {
      const result = await this._dispatch(type, envelope.payload || {});
      await this._respond(session, envelope.messageId, { ok: true, result });
      await this._publishClientSnapshot(session);
      await this._publishGameSnapshot(session);
    } catch (error) {
      await this._respond(session, envelope.messageId, {
        ok: false,
        code: error?.code || 'COMMAND_FAILED',
        message: error?.message || '命令执行失败',
      });
    }
  }

  async _dispatch(type, payload) {
    if (type === 'client.snapshot.request') return this.getStatus();
    if (type === 'game.start') {
      return this.host.start({
        gameId: payload.gameId,
        deviceMap: payload.deviceMap,
        params: payload.params,
        source: 'remote',
      });
    }
    if (type === 'game.setParams') return this.host.setParams(payload.params || payload);
    if (type === 'game.pause') return this.host.pause();
    if (type === 'game.resume') return this.host.resume();
    if (type === 'game.stop') return this.host.stop({ reason: 'remote-stop' });
    if (type === 'game.action') return this.host.action(payload.action, payload.payload);
    throw this._error('COMMAND_NOT_ALLOWED', '命令不在白名单');
  }

  _onOperatorEvent(session, envelope) {
    if (envelope.type === 'client.response') {
      const pending = session.pending.get(envelope.payload?.requestId);
      if (!pending) return;
      session.pending.delete(envelope.payload.requestId);
      this.clearTimer(pending.timer);
      pending.resolve(envelope.payload);
      return;
    }
    if (envelope.type === 'client.snapshot') {
      session.authorized = !!envelope.payload?.authorized;
      session.games = envelope.payload?.games || [];
      session.devices = envelope.payload?.devices || [];
      session.gameSnapshot = envelope.payload?.snapshot || session.gameSnapshot;
      return;
    }
    if (envelope.type === 'client.authorization') {
      session.authorized = !!envelope.payload?.authorized;
      return;
    }
    if (envelope.type === 'game.snapshot') {
      session.gameSnapshot = envelope.payload || null;
      return;
    }
    if (envelope.type === 'session.revoked') {
      session.authorized = false;
      session.devices = [];
      session.games = [];
      session.gameSnapshot = null;
      this._failPending(session, this._error('SESSION_REVOKED', '远程会话已结束'));
      if (this.session === session) this.session = null;
    }
  }

  async _respond(session, requestId, payload) {
    await this._publishEnvelope(session, 'events', 'client.response', { requestId, ...payload });
  }

  async _publishClientSnapshot(session) {
    if (!session?.client || session.role !== 'owner') return;
    const hostStatus = this._hostStatus();
    await this._publishEnvelope(session, 'events', 'client.snapshot', {
      authorized: !!session.authorized,
      games: this.listGames(),
      devices: this._deviceList(),
      snapshot: hostStatus?.snapshot || null,
      operatorOnline: [...session.operatorsOnline.values()].some(Boolean),
    });
  }

  async _publishGameSnapshot(session) {
    if (!session?.client || session.role !== 'owner') return;
    const snapshot = this._hostStatus()?.snapshot;
    if (!snapshot) return;
    await this._publishEnvelope(session, 'events', 'game.snapshot', snapshot);
    const logs = Array.isArray(snapshot.logs) ? snapshot.logs.slice(0, 5) : [];
    if (logs.length) await this._publishEnvelope(session, 'events', 'game.log', { logs });
  }

  _hostStatus() {
    try { return this.host.getStatus?.() || null; } catch (_) { return null; }
  }

  _deviceList() {
    if (this.listDevices) return this.listDevices();
    const rows = this.host.devices?.listDevicesForApi?.() || [];
    return rows.map((device) => ({
      id: device.id,
      name: device.nickname || device.name || device.id,
      type: device.type,
      capabilities: device.capabilities || [],
    }));
  }

  _failPending(session, error) {
    for (const pending of session.pending.values()) {
      this.clearTimer(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
  }

  _clearTimers(session) {
    if (session.timers?.heartbeat) this.clearRepeating(session.timers.heartbeat);
    if (session.timers) session.timers.heartbeat = null;
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

const remoteGameService = new RemoteGameService();

module.exports = remoteGameService;
module.exports.RemoteGameService = RemoteGameService;
