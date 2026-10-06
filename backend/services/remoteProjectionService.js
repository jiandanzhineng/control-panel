const mqtt = require('mqtt');
const { randomUUID, randomBytes } = require('crypto');
const deviceService = require('./deviceService');
const roomApi = require('./roomApiService');
const logService = require('./logService');
const outputGuard = require('./remoteOutputGuard');
const { createOutputWatchdog } = outputGuard;

const PROTOCOL_VERSION = 1;
const DEFAULT_TTL_SEC = 3600;
const DEFAULT_LIMITS = outputGuard.DEFAULT_REMOTE_LIMITS;
const HEARTBEAT_MS = 10000;
const MEMBERS_REFRESH_MS = 30000;
const CREDENTIAL_REFRESH_EARLY_MS = 2 * 60 * 1000;
const MAX_SEEN_MESSAGE_IDS = 1024;
const WRITE_ACK_TIMEOUT_MS = 8000;

function normalizePositiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

// 持有方上限：字段与默认值由 remoteOutputGuard 统一（含 intensity 品牌刻度）。
function normalizeLimits(input = {}) {
  return outputGuard.normalizeLimits(input);
}

function newConnectionEpoch() {
  return `epoch_${randomBytes(9).toString('base64url')}`;
}

// setTimeout 超过 2^31-1 ms 会被压成 1ms 立即触发（凭据过期时间远时会出现）。
// 所有长延时都夹到 [1s, 24h]。
const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;
function safeTimerDelay(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return MAX_TIMER_DELAY_MS;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(1000, Math.round(value)));
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
    // 编排层（remoteSessionService）订阅的事件出口，避免它去读私有字段。
    this.eventHandlers = new Set();

    // 锁存输出看门狗：远程写入登记，到点自动停机（审查报告 §3.3）。
    this.watchdog = createOutputWatchdog({
      stopDevice: (deviceId) => this._stopRemoteOutput(deviceId),
      setTimer,
      clearTimer,
    });
    this.devices.onDeviceDataChange?.((event) => this._onLocalDataChange(event));
    this.devices.onDeviceRawMessage?.((event) => this._onLocalRawMessage(event));
    this.devices.onDeviceListChange?.(() => this._onLocalDeviceListChange());
  }

  /** 编排层订阅事件（operation / phase / peer / write-result）。返回取消订阅函数。 */
  onEvent(handler) {
    if (typeof handler !== 'function') return () => {};
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  _emitEvent(event) {
    for (const handler of this.eventHandlers) {
      try { handler({ source: 'projection', ...event }); } catch (_) {}
    }
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
      // 授权只认显式指定的 userId（默认无授权，审查报告 §2.3）。
      authorizedUserId: session.role === 'owner' ? session.authorizedUserId : null,
      authorized: session.role === 'owner'
        ? !!session.authorizedUserId
        : session.authorizedUserId === session.credential.userId,
      // 仅房主可见：在线成员 + 授权状态 + 最近一次房间成员拉取错误。
      members: session.role === 'owner' ? this._memberList(session) : undefined,
      lastError: session.lastError,
      apiBaseUrl: this.api.getBaseUrl?.() || null,
    };
  }

  _memberList(session) {
    const known = new Map(session.members.map((member) => [member.userId, member]));
    for (const [userId, online] of session.operatorsOnline) {
      if (!known.has(userId)) {
        known.set(userId, { userId, online, authorized: false });
      }
    }
    return [...known.values()]
      .filter((member) => member.userId !== session.credential.userId)
      .map((member) => ({
        ...member,
        online: member.online === true || session.operatorsOnline.get(member.userId) === true,
        authorized: member.userId === session.authorizedUserId,
      }));
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
      await this._refreshMembers(session);
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
      // 操作方默认无授权：不发设备清单请求，等房主显式授权（房主授权后主动推清单）。
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
    this._failPendingWrites(session, this._error('ROOM_DISCONNECTED', '房间连接不可用'));
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

  /**
   * 主控端兜底：把本机设备表里属于本会话投影房间的 remote 设备摘掉。
   *
   * 正常路径是「收到空设备清单 → _applyDeviceList 解除 remote 连接」；房主离线、
   * 只关掉自己那侧房间（被控端 stop/踢出）或撤权清单丢失时这一步不会发生，
   * 远端设备就会一直挂在主控端设备表里。编排层在会话收尾时调这里核对一次。
   */
  async pruneRemoteDevices(reason = 'projection-prune') {
    const session = this.session;
    if (session) {
      this._removeRemoteDevices(session);
      return { active: true, removed: 0 };
    }
    // 会话对象已不在：按设备表里遗留的 remote 连接判定（本机只可能有一条投影链路）
    const list = this.devices.listDevicesForApi?.() || [];
    let removed = 0;
    for (const device of list) {
      const connections = device.connections || [];
      if (!connections.some((connection) => connection?.type === 'remote')) continue;
      try {
        if (this.devices.disconnectTransportDevice(device.id, 'remote')) removed += 1;
      } catch (_) {}
    }
    if (removed) logService.info(`[projection] pruned ${removed} leftover remote devices (${reason})`);
    return { active: false, removed };
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
      // 授权绑定具体 userId：新加入的操作方默认未授权（审查报告 §2.3）。
      authorizedUserId: null,
      members: [],
      kickedUserIds: new Set(),
      // userId → 它写过的设备集合，用于按人停机（审查报告 §4.1）。
      operatorOutputs: new Map(),
      pendingWrites: new Map(),
      // 每次连接一个随机代次，绝不外泄 MQTT clientId（审查报告 §4.3）。
      connectionEpoch: newConnectionEpoch(),
      refreshing: false,
      timers: { ttl: null, heartbeat: null, credential: null, members: null },
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
        if (session.refreshing) {
          // 主动换凭据导致的断开不算异常：不清设备、不急停（审查报告 §3.2）。
          return;
        }
        if (session.role === 'owner') {
          void this._safeStop(session, 'mqtt-disconnected');
        } else {
          this._failPendingWrites(session, this._error('ROOM_DISCONNECTED', '房间连接不可用'));
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
          // 已 settle 后（首连成功、后续换凭据重连）失败不能抛出去：
          // 外层 Promise 没人接，会变成 unhandledRejection。
          if (settled) return;
          settled = true;
          reject(error);
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
    if (session.role === 'owner') {
      await this._refreshMembers(session);
      // 重连后若已有授权操作方在线，立刻恢复推送设备清单。
      if (session.authorizedUserId && session.operatorsOnline.get(session.authorizedUserId)) {
        await this._publishDeviceList(session).catch(() => {});
      }
    } else {
      // 编排层（主控端）据此确认自己仍在投影房间里；重连（MQTT 掉线/换凭据）时
      // 也要重发一次，否则会话侧以为链路还在、实际已经不在了。
      this._emitEvent({
        type: 'peer',
        role: 'operator',
        joinCode: session.room.joinCode || null,
        roomId: session.room.id,
        hostUserId: session.room.hostUserId || null,
      });
      if (session.authorizedUserId === session.credential.userId) {
        // 仅已授权操作方在重连后重新请求清单；未授权时等房主授权再推。
        await this._publishEnvelope(session, `commands/${session.credential.userId}`, 'projection.device-list.request', {});
      }
    }
  }

  _subscribe(session, topics) {
    return new Promise((resolve, reject) => {
      const client = session.client;
      if (!client) return reject(this._error('ROOM_DISCONNECTED', '房间连接不可用'));
      // ACL 拒绝订阅时 broker 会直接断线，回调永不触发；close 也要让 Promise 结算
      let settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        try { client.removeListener?.('close', onClose); } catch (_) {}
        if (error) reject(error);
        else resolve();
      };
      const onClose = () => done(this._error('ROOM_DISCONNECTED', '房间连接不可用'));
      client.once?.('close', onClose);
      try {
        client.subscribe(topics, { qos: 1 }, done);
      } catch (error) {
        done(error);
      }
    });
  }

  _publish(session, topic, payload, options = { qos: 1, retain: false }) {
    return new Promise((resolve, reject) => {
      if (!session.client) return reject(this._error('ROOM_DISCONNECTED', '房间连接不可用'));
      session.client.publish(topic, payload, options, (error) => error ? reject(error) : resolve());
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
      senderConnectionEpoch: session.connectionEpoch,
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
      void this._onOwnerCommand(session, suffix.slice('commands/'.length), envelope);
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
        // 只有被授权的操作方上线才推设备清单（审查报告 §4.3：无授权方不收任何状态）。
        if (session.authorizedUserId === userId) {
          void this._publishDeviceList(session).catch(() => {});
        }
        void this._refreshMembers(session).catch(() => {});
      } else if (session.authorizedUserId === userId) {
        // 被授权者离线：立即停掉它写过的输出，不等全离线判定（审查报告 §3.3）。
        void this._stopOperatorOutputs(session, userId, 'operator-offline');
      }
    } else if (userId === session.room.hostUserId && !online) {
      this._removeRemoteDevices(session);
    }
  }

  async _onOwnerCommand(session, userId, envelope) {
    if (!userId) return;
    if (envelope.type === 'projection.device-list.request') {
      if (session.authorizedUserId === userId) {
        void this._publishDeviceList(session).catch(() => {});
      }
      return;
    }
    if (envelope.type !== 'projection.write') {
      return;
    }
    // 授权绑定 userId：未授权/已被移出的成员拿不到设备清单，也不能写。
    if (session.authorizedUserId !== userId || session.kickedUserIds.has(userId)) {
      this._emitOperation(userId, envelope.payload?.deviceId, 'rejected', {
        code: 'CONTROL_NOT_AUTHORIZED',
        message: '房主未授权本账号控制设备',
      });
      // 未授权/已被移出的成员：不发设备清单、不写设备，只回一条拒绝结果。
      await this._publishWriteResult(session, envelope.messageId, {
        ok: false,
        code: 'CONTROL_NOT_AUTHORIZED',
        message: '房主未授权本账号控制设备',
      }).catch(() => {});
      return;
    }
    if (session.expired || this.now() >= session.controlExpiresAt) {
      if (this._expireOwnerSession(session, 'control-ttl-expired-on-write')) {
        void this._publishEnvelope(session, 'events', 'projection.expired', {}).catch(() => {});
      }
      this._emitOperation(userId, envelope.payload?.deviceId, 'rejected', {
        code: 'CONTROL_EXPIRED',
        message: '远程控制已过期',
      });
      await this._publishWriteResult(session, envelope.messageId, {
        ok: false,
        code: 'CONTROL_EXPIRED',
        message: '远程控制已过期',
      }).catch(() => {});
      return;
    }
    const input = envelope.payload;
    if (!input || typeof input !== 'object' || typeof input.deviceId !== 'string'
        || !input.message || typeof input.message !== 'object' || Array.isArray(input.message)) {
      this._emitOperation(userId, input?.deviceId, 'rejected', {
        code: 'INVALID_WRITE',
        message: '远程控制指令格式无效',
      });
      await this._publishWriteResult(session, envelope.messageId, {
        ok: false,
        code: 'INVALID_WRITE',
        message: '远程控制指令格式无效',
      }).catch(() => {});
      return;
    }
    const device = this.devices.getDeviceForApi?.(input.deviceId);
    if (!device || !this._hasLocalConnection(device)) {
      this._emitOperation(userId, input.deviceId, 'rejected', {
        code: 'DEVICE_OFFLINE',
        message: '共享设备已离线',
      });
      await this._publishWriteResult(session, envelope.messageId, {
        deviceId: input.deviceId,
        ok: false,
        code: 'DEVICE_OFFLINE',
        message: '共享设备已离线',
      }).catch(() => {});
      return;
    }
    // 逐字段钳制：覆盖品牌协议字段，未知字段/命令一律拒绝（审查报告 §2.1）。
    // 本地玩法运行中（或被顶替后主控端尚未重新登记占用）：只放行停止/归零，
    // 防止主控端页面式游戏的残余写入继续驱动被控端设备。
    const sanitized = outputGuard.sanitizeProjectionMessage({
      device,
      message: input.message,
      limits: session.limits,
    });
    // 本地玩法运行中：只放行「确实是停止/归零」的写入；脏字段的停止帧丢弃多余字段后照发，
    // 其余（含无法解析的报文）一律拒绝，避免把未知写入透传到真实设备。
    if (this._isPlayOccupied()) {
      if (!sanitized.ok) {
        this._emitOperation(userId, input.deviceId, 'rejected', {
          code: sanitized.code,
          message: sanitized.message,
          requested: input.message,
        });
        await this._publishWriteResult(session, envelope.messageId, {
          deviceId: input.deviceId,
          ok: false,
          code: sanitized.code,
          message: sanitized.message,
        }).catch(() => {});
        return;
      }
      if (outputGuard.isLatchedProjectionMessage({ device, message: sanitized.message }).latched) {
        this._emitOperation(userId, input.deviceId, 'rejected', {
          code: 'HOST_PLAY_ACTIVE',
          message: '被控端正在运行本地玩法',
          requested: input.message,
        });
        await this._publishWriteResult(session, envelope.messageId, {
          deviceId: input.deviceId,
          ok: false,
          code: 'HOST_PLAY_ACTIVE',
          message: '被控端正在运行本地玩法',
        }).catch(() => {});
        return;
      }
    }
    if (!sanitized.ok) {
      this._emitOperation(userId, input.deviceId, 'rejected', {
        code: sanitized.code,
        message: sanitized.message,
        requested: input.message,
      });
      await this._publishWriteResult(session, envelope.messageId, {
        deviceId: input.deviceId,
        ok: false,
        code: sanitized.code,
        message: sanitized.message,
      }).catch(() => {});
      return;
    }
    const message = sanitized.message;
    try {
      if (typeof this.devices.sendDeviceMessageAndWait === 'function') {
        await this.devices.sendDeviceMessageAndWait(input.deviceId, message);
      } else {
        await Promise.resolve(this.devices.publishDeviceMessage(input.deviceId, message));
      }
      this._trackOperatorOutput(session, userId, input.deviceId, device, message);
      this._emitOperation(
        userId,
        input.deviceId,
        this._isClamped(input.message, message) ? 'clamped' : 'ok',
        { requested: input.message, applied: message },
      );
      await this._publishWriteResult(session, envelope.messageId, {
        deviceId: input.deviceId,
        ok: true,
      });
    } catch (error) {
      session.lastError = error?.message || String(error);
      this._emitOperation(userId, input.deviceId, 'rejected', {
        code: error?.code || 'DEVICE_WRITE_FAILED',
        message: error?.message || String(error),
        requested: input.message,
      });
      await this._publishWriteResult(session, envelope.messageId, {
        deviceId: input.deviceId,
        ok: false,
        code: error?.code || 'DEVICE_WRITE_FAILED',
        message: error?.message || String(error),
      }).catch(() => {});
    }
  }

  /** 归一化后的报文与原始报文是否不同（安全层钳制过）。 */
  _isClamped(requested, applied) {
    try {
      return JSON.stringify(requested) !== JSON.stringify(applied);
    } catch (_) {
      return false;
    }
  }

  /** 操作记录事件：编排层据此写被控端操作日志。 */
  _emitOperation(userId, deviceId, outcome, detail = {}) {
    this._emitEvent({
      type: 'operation',
      userId: userId || null,
      kind: 'projection.write',
      target: deviceId || null,
      outcome,
      detail,
    });
  }


  /** 记录「哪个操作方写了哪台设备」，供撤权/掉线时只停它写过的设备。 */
  _trackOperatorOutput(session, userId, deviceId, device, message) {
    if (!session.operatorOutputs.has(userId)) session.operatorOutputs.set(userId, new Set());
    session.operatorOutputs.get(userId).add(deviceId);
    const latch = outputGuard.isLatchedProjectionMessage({ device, message });
    if (latch.latched) this.watchdog.arm(deviceId, latch.maxMs);
    else this.watchdog.clear(deviceId);
  }

  /** 撤权/移出后告诉操作方：没有设备，且本账号已不再被授权。 */
  _publishRevokedDeviceList(session) {
    return this._publishEnvelope(session, 'events', 'projection.device-list', {
      devices: [],
      limits: session.limits,
      controlTtlSec: session.controlTtlSec,
      controlExpiresAt: new Date(session.controlExpiresAt).toISOString(),
      authorizedFor: null,
    }).catch(() => {});
  }

  /** 停掉某个操作方写过的设备（撤权 / 掉线 / 被移出房间）。 */
  async _stopOperatorOutputs(session, userId, reason) {
    const deviceIds = new Set(session.operatorOutputs.get(userId) || []);
    session.operatorOutputs.delete(userId);
    for (const [otherId, ids] of session.operatorOutputs) {
      for (const deviceId of ids) deviceIds.add(deviceId);
    }
    for (const deviceId of deviceIds) {
      this.watchdog.clear(deviceId);
    }
    await Promise.all([...deviceIds].map((deviceId) => this._stopRemoteOutput(deviceId)));
    if (deviceIds.size) {
      logService.info('RemoteProjection', `operator outputs stopped: ${reason} (${deviceIds.size})`);
    }
  }

  /** 单台设备的兜底停机（watchdog 到点 / 操作方掉线）。 */
  async _stopRemoteOutput(deviceId) {
    try {
      await Promise.resolve(this.devices.invokeDeviceClose?.(deviceId));
    } catch (_) { /* 设备可能已离线，忽略 */ }
  }

  _publishWriteResult(session, requestId, result) {
    return this._publishEnvelope(session, 'events', 'projection.write-result', {
      requestId,
      ...result,
    });
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
    } else if (envelope.type === 'projection.write-result') {
      if (!payload || typeof payload.requestId !== 'string') return;
      if (payload.ok === true) {
        this._finishPendingWrite(session, payload.requestId);
      } else {
        this._finishPendingWrite(
          session,
          payload.requestId,
          this._error(
            typeof payload.code === 'string' ? payload.code : 'DEVICE_WRITE_FAILED',
            typeof payload.message === 'string' ? payload.message : '远程设备执行失败',
          ),
        );
      }
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
    // 收到设备清单即按房主给的对象判定授权：authorizedFor 命中本账号才授权；
    // 老房主（无该字段）回退到「清单非空即已授权」，保持与移动端兼容。
    if (typeof payload.authorizedFor === 'string') {
      session.authorizedUserId = payload.authorizedFor === session.credential.userId
        ? session.credential.userId
        : null;
    } else {
      session.authorizedUserId = payload.devices.length > 0 ? session.credential.userId : null;
    }
    const nextIds = new Set();
    for (const item of payload.devices) {
      if (!item || typeof item.deviceId !== 'string' || typeof item.deviceType !== 'string') continue;
      nextIds.add(item.deviceId);
      const adapter = {
        kind: 'remote',
        send: (message) => this._sendRemoteWrite(session, item.deviceId, message),
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
      // 显式授权标记：操作方据此判断自己是否被授权（空设备清单不等于未授权）。
      // 老客户端（移动端）忽略未知字段，兼容。
      authorizedFor: session.authorizedUserId || null,
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

  _sendRemoteWrite(session, deviceId, message) {
    if (this.session !== session || !session.connected) {
      throw this._error('ROOM_DISCONNECTED', '房间连接不可用');
    }
    if (session.expired || this.now() >= session.controlExpiresAt) {
      session.expired = true;
      this._removeRemoteDevices(session);
      throw this._error('CONTROL_EXPIRED', '远程控制已过期');
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        this._finishPendingWrite(
          session,
          requestId,
          this._error('DEVICE_WRITE_TIMEOUT', '等待共享设备执行结果超时'),
        );
      }, WRITE_ACK_TIMEOUT_MS);
      session.pendingWrites.set(requestId, { resolve, reject, timer });
      this._publishEnvelope(
        session,
        `commands/${session.credential.userId}`,
        'projection.write',
        { deviceId, message },
        requestId,
      ).catch((error) => this._finishPendingWrite(session, requestId, error));
    });
  }

  _finishPendingWrite(session, requestId, error = null) {
    const pending = session.pendingWrites.get(requestId);
    if (!pending) return;
    session.pendingWrites.delete(requestId);
    this.clearTimer(pending.timer);
    if (error) {
      this._emitEvent({ type: 'write-result', requestId, ok: false, code: error.code || null });
      pending.reject(error);
    } else {
      this._emitEvent({ type: 'write-result', requestId, ok: true });
      pending.resolve({ ok: true });
    }
  }

  _failPendingWrites(session, error) {
    for (const requestId of [...session.pendingWrites.keys()]) {
      this._finishPendingWrite(session, requestId, error);
    }
  }

  _onLocalDeviceListChange() {
    const session = this.session;
    if (!session || session.role !== 'owner' || !session.connected || session.expired) return;
    // 无已授权且在线的操作方时不推设备清单（审查报告 §4.3）。
    if (!this._hasActiveOperator(session)) return;
    void this._publishDeviceList(session).catch((error) => {
      session.lastError = error?.message || String(error);
    });
  }

  /** 远端设备状态/原始报文只推给已授权且在线的操作方（审查报告 §4.3）。 */
  _hasActiveOperator(session) {
    if (!session.authorizedUserId) return false;
    return session.operatorsOnline.get(session.authorizedUserId) === true;
  }

  /** 编排层用：某个 userId 是否已在这个投影房间里（成员列表或 presence）。 */
  hasMember(userId) {
    const session = this.session;
    if (!session || session.role !== 'owner') return false;
    const target = String(userId || '').trim();
    if (!target) return false;
    if (session.kickedUserIds.has(target)) return false;
    const member = session.members.find((item) => item.userId === target);
    if (member && (!member.status || member.status === 'joined')) return true;
    return session.operatorsOnline.get(target) === true;
  }

  /**
   * 续期远程控制 TTL：只延长截止时间，不动已授权成员、不复位设备、不重连。
   * 返回是否真的改过（已过期或已结束的会话不复活）。
   */
  extendControl({ controlTtlSec } = {}) {
    const session = this.session;
    if (!session || session.role !== 'owner' || session.expired || this.now() >= session.controlExpiresAt) {
      return { ok: false, reason: 'CONTROL_EXPIRED' };
    }
    const ttl = normalizePositiveInt(controlTtlSec, session.controlTtlSec, 60, 24 * 60 * 60);
    session.controlTtlSec = ttl;
    session.controlExpiresAt = this.now() + ttl * 1000;
    if (session.timers.ttl) this.clearTimer(session.timers.ttl);
    session.timers.ttl = this.setTimer(() => {
      if (this.session !== session) return;
      if (this._expireOwnerSession(session, 'control-ttl-expired')) {
        void this._publishEnvelope(session, 'events', 'projection.expired', {}).catch(() => {});
      }
    }, safeTimerDelay(session.controlExpiresAt - this.now()));
    this._emitEvent({ type: 'control-extended', controlExpiresAt: session.controlExpiresAt });
    return { ok: true, controlTtlSec: ttl, controlExpiresAt: session.controlExpiresAt };
  }

  /** 编排层急停：停掉远程操作方写过的设备，会话继续（不撤权、不结束房间）。 */
  async emergencyStop() {
    const session = this.session;
    if (!session || session.role !== 'owner') {
      throw this._error('NOT_OWNER', '只有房主可以急停');
    }
    await this._safeStop(session, 'remote-emergency-stop');
    return this.getStatus();
  }

  /**
   * 编排层设置「被控端本地玩法占用」的实时判定源。
   * 由 remoteSessionService 注入：本地玩法在跑、或顶替后主控端尚未重新登记占用 → true。
   */
  setPlayOccupiedSource(source) {
    this.playOccupiedSource = typeof source === 'function' ? source : null;
    return { ok: true };
  }

  /** 当前是否处于「只允许停止/归零」的投影写入状态（未注入判定源时视为不占用）。 */
  _isPlayOccupied() {
    try {
      if (typeof this.playOccupiedSource === 'function') return this.playOccupiedSource() === true;
    } catch (_) { /* 判定源异常时按不占用，与旧行为一致 */ }
    return false;
  }

  _onLocalDataChange({ deviceId, device, nextData }) {
    const session = this.session;
    if (!session || session.role !== 'owner' || !this._hasActiveOperator(session)) return;
    if (!this._hasLocalConnection(this.devices.getDeviceForApi?.(deviceId) || device)) return;
    void this._publishEnvelope(session, 'events', 'projection.device-state', {
      deviceId,
      data: nextData || device?.data || {},
    }).catch(() => {});
  }

  _onLocalRawMessage({ deviceId, payload }) {
    const session = this.session;
    if (!session || session.role !== 'owner' || !this._hasActiveOperator(session)) return;
    if (payload?.method === 'report' || payload?.method === 'update') return;
    const device = this.devices.getDeviceForApi?.(deviceId);
    if (!device || !this._hasLocalConnection(device)) return;
    void this._publishEnvelope(session, 'events', 'projection.device-message', {
      deviceId,
      message: payload,
    }).catch(() => {});
  }

  _startOwnerTimers(session) {
    // TTL 可能到 24h，超过 setTimeout 的 2^31-1 上限会被压成 1ms 立即触发。
    const delay = safeTimerDelay(session.controlExpiresAt - this.now());
    session.timers.ttl = this.setTimer(() => {
      if (this.session !== session) return;
      if (this._expireOwnerSession(session, 'control-ttl-expired')) {
        void this._publishEnvelope(session, 'events', 'projection.expired', {}).catch(() => {});
      }
    }, delay);
    session.timers.heartbeat = this.setRepeating(() => {
      if (this.session !== session) return;
      // 偶发超时不打扰用户：连续失败 3 次才报错，成功即清零
      void this.api.heartbeat(session.token, session.room.id).then(() => {
        session.heartbeatFailures = 0;
      }, (error) => {
        session.heartbeatFailures = (session.heartbeatFailures || 0) + 1;
        if (session.heartbeatFailures >= 3) session.lastError = error?.message || String(error);
      });
      // 无人在线时不推设备清单（审查报告 §4.3）。
      if (this._hasActiveOperator(session)) {
        void this._publishDeviceList(session).catch(() => {});
      }
    }, HEARTBEAT_MS);
    // 周期性拉成员列表，撤权/被踢能被及时察觉（服务端踢线未接线，本地兜底）。
    session.timers.members = this.setRepeating(() => {
      if (this.session !== session) return;
      void this._refreshMembers(session).catch(() => {});
    }, MEMBERS_REFRESH_MS);
  }

  /** 拉取房间成员，识别「被移出房间」的已授权操作方并立刻撤权 + 停机。 */
  async _refreshMembers(session) {
    if (this.session !== session || session.role !== 'owner' || !session.token) return;
    let room = null;
    try {
      room = await this.api.getRoom(session.token, session.room.id);
    } catch (error) {
      session.lastError = error?.message || String(error);
      return;
    }
    if (this.session !== session || !room || !Array.isArray(room.members)) return;
    session.members = room.members
      .filter((member) => member && typeof member.userId === 'string' && member.userId !== session.credential.userId)
      .map((member) => ({
        userId: member.userId,
        role: member.role || 'player',
        status: member.status || 'joined',
      }));
    const authorized = session.authorizedUserId;
    if (!authorized) return;
    const member = session.members.find((item) => item.userId === authorized);
    const gone = !member || (member.status && member.status !== 'joined');
    if (gone) {
      await this.revoke({ reason: 'operator-left-room' });
    }
  }

  _scheduleCredentialRefresh(session) {
    if (session.timers.credential) this.clearTimer(session.timers.credential);
    const expiresAt = Date.parse(session.credential.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const delay = safeTimerDelay(expiresAt - this.now() - CREDENTIAL_REFRESH_EARLY_MS);
    session.timers.credential = this.setTimer(() => {
      void this._refreshCredential(session);
    }, delay);
  }

  /**
   * 换凭据重连。关键：session.refreshing 置位期间 close 走「主动重建」分支，
   * 不触发 _safeStop —— 否则每次刷新都会复位设备、把自动锁开一次（审查报告 §3.2）。
   */
  async _refreshCredential(session) {
    if (this.session !== session || !session.client || session.refreshing) return;
    try {
      const credential = await this.api.getMqttCredential(
        session.token,
        session.room.id,
        session.credential.clientId,
      );
      if (this.session !== session || !session.client) return;
      session.credential = credential;
      // mqtt.js 的 options 是只读 getter，重连用新 client 的 options，无需原地改
      session.refreshing = true;
      try {
        await this._endClient(session);
        // stop()/leave 可能在 end() 等待期间把会话结束掉：不能再建连接（僵尸重连）
        if (this.session !== session) return;
        await this._connect(session);
      } finally {
        session.refreshing = false;
      }
      this._scheduleCredentialRefresh(session);
    } catch (error) {
      session.refreshing = false;
      session.lastError = error?.message || String(error);
      session.timers.credential = this.setTimer(() => this._refreshCredential(session), 30000);
    }
  }

  /** 授权一个具体 userId（房主操作）。未授权方拿不到设备清单，写也被拒。 */
  async authorize(userId) {
    const session = this.session;
    if (!session || session.role !== 'owner') {
      throw this._error('NOT_OWNER', '只有房主可以授权');
    }
    const target = String(userId || '').trim();
    if (!target || target === session.credential.userId) {
      throw this._error('INVALID_OPERATOR', '请选择要授权的成员');
    }
    const member = session.members.find((item) => item.userId === target);
    // 已拉取到成员列表时以列表为准；列表为空（拉取失败/尚未拉到）回退到 presence。
    const knownJoined = member && (!member.status || member.status === 'joined');
    const onlineByPresence = session.operatorsOnline.get(target) === true
      && !session.kickedUserIds.has(target);
    if (session.members.length > 0 ? !knownJoined : !onlineByPresence) {
      throw this._error('OPERATOR_NOT_IN_ROOM', '该成员不在房间里');
    }
    if (session.authorizedUserId && session.authorizedUserId !== target) {
      // 换人授权：先撤旧、停旧操作方写过的设备，再授权新成员。
      await this.revoke({ reason: 'authorized-operator-changed' });
    }
    session.authorizedUserId = target;
    if (session.operatorsOnline.get(target) !== true) {
      await this._refreshMembers(session);
    }
    await this._publishDeviceList(session).catch(() => {});
    return this.getStatus();
  }

  /** 撤销授权并立刻停掉被撤权操作方写过的设备。 */
  async revoke({ reason = 'revoked' } = {}) {
    const session = this.session;
    if (!session || session.role !== 'owner') {
      throw this._error('NOT_OWNER', '只有房主可以撤权');
    }
    const userId = session.authorizedUserId;
    session.authorizedUserId = null;
    if (userId) {
      await this._stopOperatorOutputs(session, userId, reason);
    }
    // 撤权后操作方不应再看到任何设备。
    await this._publishRevokedDeviceList(session);
    return this.getStatus();
  }

  /** 把成员移出房间：服务端踢人 + 本地立即拒绝（服务端踢线未接线）。 */
  async kick(userId) {
    const session = this.session;
    if (!session || session.role !== 'owner') {
      throw this._error('NOT_OWNER', '只有房主可以移出成员');
    }
    const target = String(userId || '').trim();
    if (!target || target === session.credential.userId) {
      throw this._error('INVALID_OPERATOR', '请选择要移出的成员');
    }
    if (session.authorizedUserId === target) {
      session.authorizedUserId = null;
      await this._stopOperatorOutputs(session, target, 'kicked');
      await this._publishRevokedDeviceList(session);
    }
    session.kickedUserIds.add(target);
    session.members = session.members.filter((member) => member.userId !== target);
    try {
      await this.api.kickMember(session.token, session.room.id, target);
    } catch (error) {
      session.lastError = error?.message || String(error);
      throw error;
    }
    return this.getStatus();
  }

  /**
   * 兜底停机：只复位远程操作方写过的设备（watchdog 登记过 / operatorOutputs 记录过），
   * 不再无条件复位本机全部设备（审查报告 §4.1）。
   */
  async _safeStop(session, reason) {
    if (session.role !== 'owner') return;
    const deviceIds = new Set(this.watchdog.touched());
    for (const ids of session.operatorOutputs.values()) {
      for (const id of ids) deviceIds.add(id);
    }
    for (const deviceId of deviceIds) {
      this.watchdog.clear(deviceId);
    }
    session.operatorOutputs.clear();
    await Promise.all([...deviceIds].map((deviceId) => this._stopRemoteOutput(deviceId)));
    logService.info('RemoteProjection', `safe stop: ${reason} (${deviceIds.size})`);
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
    if (session.timers.members) this.clearRepeating(session.timers.members);
    if (session.timers.heartbeat) this.clearRepeating(session.timers.heartbeat);
    session.timers = { ttl: null, heartbeat: null, credential: null, members: null };
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
