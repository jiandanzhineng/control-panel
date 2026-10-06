const mqtt = require('mqtt');
const { randomUUID, randomBytes } = require('crypto');
const manifests = [
  require('../game-runtime/cores/surge-edging-manifest'),
  require('../game-runtime/cores/pressure-edging-v2-manifest'),
];
const deviceRegistry = require('../devices/registry');

const PROTOCOL_VERSION = 1;
const MAX_SEEN_MESSAGE_IDS = 1024;
const HEARTBEAT_MS = 10000;
const SNAPSHOT_MS = 500;
const COMMAND_TIMEOUT_MS = 8000;
// 所有 MQTT 操作都必须有上限，否则 ACL 拒绝（broker 135 踢线）会让回调永不触发
const PUBLISH_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 12000;
const END_TIMEOUT_MS = 3000;
// MQTT JWT 固定 600s，到期 broker 强断；提前 2 分钟换新凭据并重连
const CREDENTIAL_REFRESH_EARLY_MS = 2 * 60 * 1000;
const CREDENTIAL_RETRY_MS = 30000;
// 操作方容忍房主 presence 离线的宽限期；宽限内房主回来即恢复
const HOST_OFFLINE_GRACE_MS = 60000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 20000];
const GAME_SESSION_COMMANDS = new Set(['game.setParams', 'game.pause', 'game.resume', 'game.stop', 'game.action']);
// 这些连接类型的设备断开后会自动重连，无法保持断开，不谎报成功
const UNSUPPORTED_DISCONNECT_TYPES = new Set(['mqtt', 'virtual']);
const COMMANDS = new Set([
  'client.hello',
  'client.snapshot.request',
  'client.workspace.set',
  'games.list',
  'game.meta',
  'game.config.get',
  'game.config.set',
  'game.start',
  'game.setParams',
  'game.pause',
  'game.resume',
  'game.stop',
  'game.action',
  'devices.list',
  'devices.scan.start',
  'devices.scan.stop',
  'devices.connect',
  'devices.disconnect',
  'devices.rename',
  'devices.controlConnection.set',
  'devices.invoke',
  'devices.stop',
]);

function parseJson(payload) {
  try {
    return JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload));
  } catch (_) {
    return null;
  }
}

// 输出安全层：优先用注入的实现（测试/替换），否则直接 require 真实模块。
// 刻意没有「模块缺失就放行」的降级分支：这是电击类硬件的最后一道限幅，
// 安全层加载失败必须让服务整体起不来（fail-closed），不能降级成透传。
function loadOutputGuard(provided) {
  return provided || require('./remoteOutputGuard');
}

function defaultListGames() {
  return manifests.map((manifest) => ({
    id: manifest.GAME_ID,
    title: manifest.TITLE,
    version: manifest.VERSION,
    runtimeMode: 'host',
    devices: manifest.DEVICES,
    params: manifest.PARAMS,
  }));
}

class RemoteGameService {
  constructor({
    host,
    api,
    beforeHostStart = null,
    mqttConnect = mqtt.connect,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    setRepeating = setInterval,
    clearRepeating = clearInterval,
    listGames = defaultListGames,
    listDevices = null,
    outputGuard = null,
    publishTimeoutMs = PUBLISH_TIMEOUT_MS,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    endTimeoutMs = END_TIMEOUT_MS,
    commandTimeoutMs = COMMAND_TIMEOUT_MS,
    hostOfflineGraceMs = HOST_OFFLINE_GRACE_MS,
    credentialRefreshEarlyMs = CREDENTIAL_REFRESH_EARLY_MS,
    credentialRetryMs = CREDENTIAL_RETRY_MS,
    reconnectBackoffMs = RECONNECT_BACKOFF_MS,
  } = {}) {
    this.host = host || require('../game-runtime/gameHostService');
    this.api = api || require('./roomApiService');
    this.beforeHostStart = beforeHostStart;
    this.mqttConnect = mqttConnect;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.setRepeating = setRepeating;
    this.clearRepeating = clearRepeating;
    this.listGames = listGames;
    this.listDevices = listDevices;
    this.outputGuard = loadOutputGuard(outputGuard);
    this.publishTimeoutMs = publishTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.endTimeoutMs = endTimeoutMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.hostOfflineGraceMs = hostOfflineGraceMs;
    this.credentialRefreshEarlyMs = credentialRefreshEarlyMs;
    this.credentialRetryMs = credentialRetryMs;
    this.reconnectBackoffMs = reconnectBackoffMs;
    this.watchdog = this._createWatchdog();
    this.session = null;
  }

  _createWatchdog() {
    return this.outputGuard.createOutputWatchdog({
      stopDevice: async (deviceId) => {
        // 锁存输出兜底停机：按设备类型走 invokeClose（品牌设备是品牌停止帧）
        try { await this._deviceService().stopExecutionDeviceAndWait(deviceId); } catch (_) {}
      },
    });
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
    const authorized = !!session.authorized;
    const base = {
      active: true,
      role: session.role,
      roomId: session.room.id,
      joinCode: session.role === 'owner' ? session.room.joinCode : null,
      connected: session.connected,
      authorized,
      gameSessionId: session.role === 'owner'
        ? hostStatus?.sessionId || null
        : session.gameSessionId || null,
      lastError: session.lastError,
      apiBaseUrl: this.api.getBaseUrl?.() || null,
    };
    if (session.role === 'owner') {
      const online = [...session.operatorsOnline.values()].filter((item) => item.online);
      return {
        ...base,
        operatorOnline: online.length > 0,
        operators: this._operatorList(session),
        members: session.members || [],
        games: this.listGames(),
        devices: this._deviceList(),
        snapshot: hostStatus?.snapshot || null,
      };
    }
    // 操作方：未授权只给最小状态（不给设备清单与游戏快照，避免泄露本机设备/局势）
    if (!authorized) {
      return {
        ...base,
        waitingForHost: !!session.waitingForHost,
        operatorUserId: session.credential?.userId || null,
        games: session.games,
        devices: [],
        snapshot: null,
      };
    }
    return {
      ...base,
      operatorUserId: session.credential?.userId || null,
      games: session.games,
      devices: session.devices,
      snapshot: session.gameSnapshot,
    };
  }

  _operatorList(session) {
    const rows = [];
    for (const [userId, entry] of session.operatorsOnline.entries()) {
      if (userId === session.credential.userId) continue;
      rows.push({
        userId,
        online: !!entry.online,
        authorized: session.authorizedUserId === userId,
      });
    }
    return rows;
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
        const ended = !!status?.snapshot?.ended || !!status?.ended;
        session.gameSnapshot = status?.snapshot || null;
        if (status?.sessionId) session.gameSessionId = status.sessionId;
        if (!session.connected) return;
        const nowMs = this.now();
        // 结束快照必须可靠送达，不能被节流吞掉
        if (!ended && session.lastPublishAt && nowMs - session.lastPublishAt < 200) return;
        session.lastPublishAt = nowMs;
        void this._publishGameSnapshot(session, { force: ended }).catch(() => {});
      });
      await this._connect(session);
      session.timers.heartbeat = this.setRepeating(() => {
        void this.api.heartbeat(session.token, session.room.id).catch(() => {});
      }, HEARTBEAT_MS);
      session.timers.snapshot = this.setRepeating(() => {
        void this._publishGameSnapshot(session).catch(() => {});
      }, SNAPSHOT_MS);
      this._scheduleCredentialRefresh(session);
      void this._refreshMembers(session).then(() => this._publishClientSnapshot(session)).catch(() => {});
      return this.getStatus();
    } catch (error) {
      this.session = null;
      if (session) {
        session.closedByUs = true;
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
      this._scheduleCredentialRefresh(session);
      return this.getStatus();
    } catch (error) {
      this.session = null;
      if (session) {
        session.closedByUs = true;
        this._clearTimers(session);
        await this._endClient(session, true);
      }
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

  // 房主把成员移出房间；服务端踢线未接线，本地立刻拒绝该 userId 的命令
  async kick({ userId } = {}) {
    const session = this.session;
    if (!session || session.role !== 'owner') throw this._error('NOT_OWNER', '只有主机可以移出成员');
    const target = String(userId || '').trim();
    if (!target) throw this._error('USER_ID_REQUIRED', '缺少用户 ID');
    if (target === session.credential.userId) throw this._error('CANNOT_KICK_SELF', '不能移出自己');
    const roomId = session.room.id;
    if (typeof this.api.kickMember === 'function') {
      await this.api.kickMember(session.token, roomId, target);
    }
    session.kicked.add(target);
    session.operatorsOnline.delete(target);
    if (session.authorizedUserId === target) session.authorizedUserId = null;
    session.authorized = false;
    // 服务端还断不掉对方的 MQTT，先停掉它起的手动输出
    await this._stopOperatorOutputs();
    await this._refreshMembers(session);
    await this._publishClientSnapshot(session);
    return this.getStatus();
  }

  async getRoom() {
    const session = this.session;
    if (!session) throw this._error('NOT_ACTIVE', '当前没有远程房间');
    return this._refreshMembers(session);
  }

  async _refreshMembers(session) {
    if (typeof this.api.getRoom !== 'function') return session.members;
    try {
      const room = await this.api.getRoom(session.token, session.room.id);
      session.members = Array.isArray(room?.members)
        ? room.members.map((member) => ({
          userId: member.userId,
          role: member.role,
          status: member.status,
        }))
        : session.members;
      for (const member of session.members) {
        if (member.status === 'kicked') session.kicked.add(member.userId);
      }
    } catch (error) {
      session.lastError = error?.message || String(error);
    }
    return session.members;
  }

  async _setAuthorized(authorized) {
    const session = this.session;
    if (!session || session.role !== 'owner') throw this._error('NOT_OWNER', '只有主机可以授权');
    session.authorized = authorized;
    if (authorized) {
      // 授权绑定到具体成员：优先当前在线的操作方，否则取第一个已加入的非房主成员
      // 被移出的成员可能仍连着 MQTT 并发 presence，必须排除
      const eligible = (userId) => userId && !session.kicked.has(userId);
      const online = [...session.operatorsOnline.entries()].find(([id, item]) => item.online && eligible(id));
      const member = (session.members || []).find(
        (item) => item.userId !== session.credential.userId && item.status === 'joined' && eligible(item.userId),
      );
      const previous = eligible(session.authorizedUserId) ? session.authorizedUserId : null;
      session.authorizedUserId = online?.[0] || member?.userId || previous;
      if (!session.authorizedUserId) {
        session.authorized = false;
        throw this._error('NO_OPERATOR', '没有可授权的成员');
      }
    } else {
      session.authorizedUserId = null;
    }
    if (!authorized) await this._stopOperatorOutputs();
    await this._publishEnvelope(session, 'events', 'client.authorization', {
      authorized: session.authorized,
      operatorUserId: session.authorizedUserId,
    });
    await this._publishClientSnapshot(session);
    await this._publishGameSnapshot(session, { force: true });
    return this.getStatus();
  }

  // 授权绑定校验：绑定对象必须是同一个 userId；尚未绑定则认领第一个发起控制命令的操作方
  _authorizedSenderMatches(session, senderUserId) {
    if (!session.authorized) return false;
    if (!senderUserId) return false;
    if (!session.authorizedUserId) {
      session.authorizedUserId = senderUserId;
      return true;
    }
    return session.authorizedUserId === senderUserId;
  }

  // 撤权/踢人/操作方掉线后：立刻停掉其手动锁存输出（运行中的游戏继续跑，符合 ADR）
  async _stopOperatorOutputs() {
    try {
      const touched = this.watchdog.touched?.();
      if (touched && touched.size) this._log(`stopping operator outputs: ${[...touched].join(',')}`);
      await this.watchdog.stopAll();
    } catch (_) {}
  }

  async command({ type, payload } = {}) {
    const session = this.session;
    if (!session) throw this._error('NOT_OPERATOR', '当前不是远程客户端');
    if (!COMMANDS.has(type)) throw this._error('COMMAND_NOT_ALLOWED', '命令不在白名单');
    if (session.role === 'owner') {
      const result = await this._dispatch(type, payload || {});
      await this._publishClientSnapshot(session);
      await this._publishGameSnapshot(session);
      return { ok: true, result };
    }
    const messageId = randomUUID();
    const response = new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        session.pending.delete(messageId);
        reject(this._error('COMMAND_TIMEOUT', '命令超时'));
      }, this.commandTimeoutMs);
      session.pending.set(messageId, { resolve, reject, timer });
    });
    try {
      await this._publishEnvelope(session, `commands/${session.credential.userId}`, type, payload || {}, messageId);
    } catch (error) {
      const pending = session.pending.get(messageId);
      session.pending.delete(messageId);
      if (pending) this.clearTimer(pending.timer);
      throw error;
    }
    return response;
  }

  async stop({ skipApi = false, reason = 'room-closed' } = {}) {
    const session = this.session;
    if (!session) return this.getStatus();
    this.session = null;
    this._clearTimers(session);
    session.hostUnsub?.();
    session.hostUnsub = null;
    session.closedByUs = true;
    this._failPending(session, this._error('ROOM_DISCONNECTED', '房间连接不可用'));
    // 只有房主（owner）有 events 发布权限；操作方发 session.revoked 会被 ACL 拒绝并踢线
    if (session.connected && session.role === 'owner') {
      await this._publishEnvelope(session, 'events', 'session.revoked', { reason }).catch(() => {});
    }
    await this._publishPresence(session, 'offline').catch(() => {});
    await this._endClient(session);
    await this._stopOperatorOutputs();
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

  _newSession({ role, token, room, credential }) {
    return {
      role,
      token,
      room,
      credential,
      roomSessionId: `${room.id}:${room.hostEpoch}`,
      // 连接代次用随机值，不泄露 MQTT clientId（clientId 可被冒用顶下线）
      connectionEpoch: `epoch_${randomBytes(9).toString('base64url')}`,
      client: null,
      connected: false,
      authorized: false,
      authorizedUserId: null,
      kicked: new Set(),
      members: [],
      operatorsOnline: new Map(),
      waitingForHost: false,
      hostOfflineTimer: null,
      reconnecting: false,
      reconnectAttempt: 0,
      closedByUs: false,
      gameSessionId: null,
      lastError: null,
      sequences: new Map(),
      receivedSequences: new Map(),
      seenMessageIds: new Set(),
      pending: new Map(),
      games: [],
      devices: [],
      gameSnapshot: null,
      timers: { heartbeat: null, snapshot: null, credential: null },
      hostUnsub: null,
      responseCache: new Map(),
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
        reconnectPeriod: 0,
        will: {
          topic: this._presenceTopic(session),
          payload: JSON.stringify({ status: 'offline' }),
          qos: 1,
          retain: true,
        },
      });
      session.client = client;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      // 连接超时：join/create 必须能结束，不能永久挂起
      const connectTimer = this.setTimer(() => {
        session.lastError = 'MQTT 连接超时';
        settle(this._error('ROOM_DISCONNECTED', 'MQTT 连接超时'));
      }, this.connectTimeoutMs);
      session.connectTimer = connectTimer;
      client.on('message', (topic, payload) => {
        // 事件处理器必须自己兜住异常，否则会冒泡成 unhandled error
        try {
          void this._onMessage(session, topic, payload).catch((error) => {
            session.lastError = error?.message || String(error);
          });
        } catch (error) {
          session.lastError = error?.message || String(error);
        }
      });
      client.on('error', (error) => {
        session.lastError = error?.message || String(error);
        settle(error);
      });
      client.on('close', () => {
        session.connected = false;
        if (this.session !== session) return;
        if (session.closedByUs || session.restarting) return;
        this._failPending(session, this._error('ROOM_DISCONNECTED', '房间连接不可用'));
        if (session.closedByUs) return;
        settle(this._error('ROOM_DISCONNECTED', '房间连接不可用'));
        this._onUnexpectedClose(session);
      });
      client.on('connect', () => {
        this._afterConnect(session).then(() => {
          this.clearTimer(connectTimer);
          settle();
        }, (error) => {
          session.lastError = error?.message || String(error);
          settle(error);
        });
      });
    });
  }

  // 异常断线（含凭据到期被 broker 断开）：换新凭据重连，不算会话结束
  _onUnexpectedClose(session) {
    if (this.session !== session || session.closedByUs || session.restarting) return;
    if (session.reconnecting) return;
    session.reconnecting = true;
    session.connected = false;
    session.reconnectAttempt += 1;
    const backoff = this.reconnectBackoffMs;
    const delay = backoff[Math.min(session.reconnectAttempt - 1, backoff.length - 1)];
    session.timers.reconnect = this.setTimer(() => {
      void this._reconnect(session);
    }, delay);
  }

  // 主动重建连接：期间忽略 close 事件，避免被当成异常断线再排一次重连。
  // 必须优雅断开（force=false）：broker 才会丢弃 LWT，对端不会看到一次假的 offline presence。
  async _restartClient(session) {
    session.restarting = true;
    try {
      await this._endClient(session, false);
      if (this.session !== session || session.closedByUs) return;
      await this._connect(session);
    } finally {
      session.restarting = false;
    }
  }

  async _reconnect(session) {
    if (this.session !== session || session.closedByUs) return;
    const attempt = session.reconnectAttempt;
    try {
      const credential = await this.api.getMqttCredential(
        session.token,
        session.room.id,
        session.credential.clientId,
      );
      if (this.session !== session || session.closedByUs) return;
      session.credential = credential;
      await this._restartClient(session);
      if (this.session !== session || session.closedByUs) return;
      session.reconnecting = false;
      session.reconnectAttempt = 0;
      session.lastError = null;
      this._log(`reconnected after unexpected close (attempt ${attempt})`);
      this._scheduleCredentialRefresh(session);
    } catch (error) {
      session.lastError = error?.message || String(error);
      session.reconnecting = false;
      this._log(`reconnect failed (attempt ${attempt}): ${session.lastError}`);
      this._onUnexpectedClose(session);
    }
  }

  // 凭据到期前 2 分钟主动换新并重连（不得触发任何「会话结束」语义）
  _scheduleCredentialRefresh(session) {
    if (session.timers.credential) this.clearTimer(session.timers.credential);
    const expiresAt = Date.parse(session.credential?.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const delay = Math.max(1000, expiresAt - this.now() - this.credentialRefreshEarlyMs);
    session.timers.credential = this.setTimer(() => {
      void this._refreshCredential(session);
    }, delay);
  }

  async _refreshCredential(session) {
    if (this.session !== session || session.closedByUs) return;
    try {
      const credential = await this.api.getMqttCredential(
        session.token,
        session.room.id,
        session.credential.clientId,
      );
      if (this.session !== session || session.closedByUs) return;
      session.credential = credential;
      await this._restartClient(session);
      if (this.session !== session || session.closedByUs) return;
      this._log('credential refreshed and reconnected');
      this._scheduleCredentialRefresh(session);
    } catch (error) {
      session.lastError = error?.message || String(error);
      session.timers.credential = this.setTimer(() => this._refreshCredential(session), this.credentialRetryMs);
    }
  }

  async _afterConnect(session) {
    if (this.session !== session) return;
    const base = `rooms/${session.room.id}`;
    const topics = session.role === 'owner'
      ? [`${base}/commands/+`, `${base}/presence/+`]
      : [`${base}/events`, `${base}/presence/${session.room.hostUserId}`];
    await this._subscribe(session, topics);
    if (session.role === 'operator' && session.waitingForHost) {
      // 房主还离线：join 已成功，保持「等待房主」，不结束客户端
      session.connected = true;
      session.lastError = null;
      return;
    }
    await this._publishPresence(session, 'online');
    session.connected = true;
    session.lastError = null;
    if (session.role === 'owner') {
      void this._refreshMembers(session).then(() => this._publishClientSnapshot(session)).catch(() => {});
      return;
    }
    await this._publishEnvelope(session, `commands/${session.credential.userId}`, 'client.snapshot.request', {});
  }

  _subscribe(session, topics) {
    return new Promise((resolve, reject) => {
      if (!session.client) return reject(this._error('ROOM_DISCONNECTED', '房间连接不可用'));
      let settled = false;
      const timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        reject(this._error('ROOM_DISCONNECTED', '订阅超时'));
      }, this.publishTimeoutMs);
      const done = (error) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        if (error) reject(error);
        else resolve();
      };
      try {
        session.client.subscribe(topics, { qos: 1 }, (error) => done(error));
      } catch (error) {
        done(error);
      }
    });
  }

  _publish(session, topic, payload, options = { qos: 1, retain: false }) {
    return new Promise((resolve, reject) => {
      if (!session.client) return reject(this._error('ROOM_DISCONNECTED', '房间连接不可用'));
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        try { session.client?.removeListener?.('close', onClose); } catch (_) {}
        if (error) reject(error);
        else resolve();
      };
      const timer = this.setTimer(() => finish(this._error('PUBLISH_TIMEOUT', '消息发送超时')), this.publishTimeoutMs);
      // ACL 拒绝时 broker 直接断线、回调永不触发：close 也要让 promise 结算
      const onClose = () => finish(this._error('ROOM_DISCONNECTED', '房间连接不可用'));
      session.client.once?.('close', onClose);
      try {
        session.client.publish(topic, payload, options, (error) => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  }

  _publishEnvelope(session, suffix, type, payload, messageId = randomUUID()) {
    const envelope = this._buildEnvelope(session, suffix, type, payload, messageId);
    return this._publish(session, `rooms/${session.room.id}/${suffix}`, JSON.stringify(envelope));
  }

  _buildEnvelope(session, suffix, type, payload, messageId = randomUUID()) {
    const sequence = (session.sequences.get(suffix) || 0) + 1;
    session.sequences.set(suffix, sequence);
    return {
      protocolVersion: PROTOCOL_VERSION,
      roomSessionId: session.roomSessionId,
      messageId,
      type,
      senderConnectionEpoch: session.connectionEpoch,
      sequence,
      timestamp: new Date(this.now()).toISOString(),
      payload,
    };
  }

  _publishPresence(session, status) {
    if (!session.client) return Promise.resolve();
    const envelope = this._buildEnvelope(
      session,
      `presence/${session.credential.userId}`,
      'client.presence',
      { status },
    );
    return this._publish(
      session,
      this._presenceTopic(session),
      JSON.stringify(envelope),
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
      const payload = parseJson(rawPayload);
      const envelope = payload?.protocolVersion === PROTOCOL_VERSION ? payload : null;
      if (envelope && !this._acceptIncoming(session, suffix, envelope)) return;
      this._onPresence(session, suffix.slice('presence/'.length), envelope ? envelope.payload : payload);
      return;
    }
    const envelope = parseJson(rawPayload);
    if (session.role === 'owner' && suffix.startsWith('commands/')) {
      const senderUserId = suffix.slice('commands/'.length);
      if (!senderUserId || senderUserId.includes('/')) return;
      const cached = session.responseCache.get(envelope?.messageId);
      if (cached) {
        await this._publishEnvelope(session, 'events', 'client.response', cached);
        return;
      }
    }
    if (!this._acceptIncoming(session, suffix, envelope)) return;
    if (session.role === 'owner' && suffix.startsWith('commands/')) {
      // 身份以 topic 为准，不信 payload 自报
      envelope.senderUserId = suffix.slice('commands/'.length);
      await this._onOwnerCommand(session, envelope);
    } else if (session.role === 'operator' && suffix === 'events') {
      this._onOperatorEvent(session, envelope);
    }
  }

  _onPresence(session, userId, payload) {
    const online = payload?.status === 'online';
    if (session.role === 'owner') {
      if (!userId || userId === session.credential.userId) return;
      session.operatorsOnline.set(userId, { online, at: this.now() });
      if (session.kicked.has(userId)) return;
      if (online) void this._publishClientSnapshot(session).catch(() => {});
      // 授权对象掉线：立刻停掉它起的手动锁存输出，但游戏继续（ADR）
      if (!online && session.authorizedUserId === userId) void this._stopOperatorOutputs();
      return;
    }
    if (userId !== session.room.hostUserId) return;
    if (online) {
      this._onHostBack(session);
      return;
    }
    this._onHostOffline(session);
  }

  // 房主离线：宽限期内保持等待；超时才结束会话
  _onHostOffline(session) {
    if (this.session !== session || session.closedByUs) return;
    if (session.hostOfflineTimer) return;
    session.waitingForHost = true;
    this._log(`operator waiting for host (grace ${this.hostOfflineGraceMs}ms)`);
    session.hostOfflineTimer = this.setTimer(() => {
      session.hostOfflineTimer = null;
      if (this.session !== session) return;
      this._log('host offline grace expired: tearing down operator session');
      this._endOperatorSession(session, 'host-offline');
    }, this.hostOfflineGraceMs);
  }

  _onHostBack(session) {
    if (this.session !== session) return;
    if (session.hostOfflineTimer) {
      this.clearTimer(session.hostOfflineTimer);
      session.hostOfflineTimer = null;
    }
    if (!session.waitingForHost) return;
    session.waitingForHost = false;
    // 房主回来：重新取一次快照，会话继续
    void this._publishEnvelope(session, `commands/${session.credential.userId}`, 'client.snapshot.request', {}).catch(() => {});
  }

  _endOperatorSession(session, reason) {
    if (this.session !== session) return;
    this.session = null;
    this._clearTimers(session);
    this._failPending(session, this._error('SESSION_REVOKED', '远程会话已结束'));
    session.authorized = false;
    session.devices = [];
    session.games = [];
    session.gameSnapshot = null;
    void this._endClient(session, true);
  }

  async _onOwnerCommand(session, envelope) {
    const type = envelope.type;
    const senderUserId = String(envelope.senderUserId || '').trim();
    if (!COMMANDS.has(type)) {
      await this._respond(session, envelope.messageId, { ok: false, code: 'COMMAND_NOT_ALLOWED', message: '命令不在白名单' });
      return;
    }
    // 被踢成员的命令本地直接拒绝（服务端尚未强制断开 MQTT）
    if (session.kicked.has(senderUserId)) {
      await this._respond(session, envelope.messageId, { ok: false, code: 'CONTROL_NOT_AUTHORIZED', message: '已被移出房间' });
      return;
    }
    if (type !== 'client.snapshot.request' && !this._authorizedSenderMatches(session, senderUserId)) {
      await this._respond(session, envelope.messageId, {
        ok: false,
        code: 'CONTROL_NOT_AUTHORIZED',
        message: '未授权远控',
      });
      return;
    }
    try {
      const result = await this._dispatch(type, envelope.payload || {}, { senderUserId });
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

  async _dispatch(type, payload, context = {}) {
    if (type === 'client.hello' || type === 'client.workspace.set') return this.getStatus();
    if (type === 'client.snapshot.request') return this.getStatus();
    if (type === 'games.list') return { games: this.listGames() };
    if (type === 'game.meta') return { games: this.listGames() };
    if (type === 'game.config.get') return this._hostStatus()?.snapshot?.params || {};
    if (type === 'game.config.set') return this.host.setParams(payload.params || payload);
    if (type === 'game.start') {
      this._validateStart(payload);
      if (this.beforeHostStart) await this.beforeHostStart();
      const started = await this.host.start({
        gameId: payload.gameId,
        deviceMap: payload.deviceMap,
        params: payload.params,
        source: 'remote',
      });
      this._applyGameSession(started);
      return started;
    }
    if (GAME_SESSION_COMMANDS.has(type)) this._assertGameSession(payload);
    if (type === 'game.setParams') return this.host.setParams(payload.params || payload);
    if (type === 'game.pause') return this.host.pause();
    if (type === 'game.resume') return this.host.resume();
    if (type === 'game.stop') {
      const result = await this.host.stop({ reason: 'remote-stop' });
      this._applyGameSession(null);
      return result;
    }
    if (type === 'game.action') return this.host.action(payload.action, payload.payload);
    if (type === 'devices.list') return {
      devices: this._deviceList(),
      actions: { scan: false, connect: false, disconnect: true, rename: true, invoke: true, stop: true },
    };
    if (type === 'devices.rename') return this._renameDevice(payload);
    if (type === 'devices.controlConnection.set') return this._setControlConnection(payload);
    if (type === 'devices.invoke') return this._invokeDevice(payload, context);
    if (type === 'devices.stop') return this._stopDevice(payload);
    if (type === 'devices.disconnect') return this._disconnectDevice(payload);
    if (type === 'devices.scan.start' || type === 'devices.scan.stop' || type === 'devices.connect') {
      throw this._error('DEVICE_ACTION_UNSUPPORTED', '该主机未开放远程扫描或连接');
    }
    throw this._error('COMMAND_NOT_ALLOWED', '命令不在白名单');
  }

  _currentGameSessionId() {
    return this._hostStatus()?.sessionId || null;
  }

  _applyGameSession(started) {
    const session = this.session;
    if (!session) return;
    session.gameSessionId = started?.sessionId || this._currentGameSessionId();
  }

  // 游戏控制命令必须带当前 gameSessionId，防止旧局命令误停/误改新局
  _assertGameSession(payload) {
    const session = this.session;
    if (!session || session.role !== 'owner') return;
    const provided = payload?.gameSessionId;
    // 兼容尚未携带 gameSessionId 的旧客户端（如移动端）：不带时按旧协议放行
    if (!provided) return;
    const expected = this._currentGameSessionId();
    if (!expected || String(provided) !== String(expected)) {
      throw this._error('STALE_GAME_SESSION', '游戏已更换，请刷新后重试');
    }
  }

  _deviceService() {
    return this.host?.devices || require('./deviceService');
  }

  _requireDeviceId(payload) {
    const deviceId = String(payload?.deviceId || '').trim();
    if (!deviceId) throw this._error('DEVICE_ID_REQUIRED', '缺少设备 ID');
    const device = this._deviceService().getDeviceForApi?.(deviceId);
    if (!device) throw this._error('DEVICE_NOT_FOUND', '设备不存在');
    return { deviceId, device };
  }

  _isMappedToRunningGame(deviceId) {
    const status = this._hostStatus();
    if (!status?.active || !status?.deviceMap) return false;
    return Object.values(status.deviceMap).some((ids) => Array.isArray(ids) && ids.includes(deviceId));
  }

  async _stopRunningGameForDevice(deviceId, reason) {
    if (this._isMappedToRunningGame(deviceId)) {
      await this.host.stop({ reason });
    }
  }

  _renameDevice(payload) {
    const { deviceId } = this._requireDeviceId(payload);
    const name = String(payload?.name || '').trim();
    if (!name) throw this._error('DEVICE_NAME_REQUIRED', '设备名称不能为空');
    return this._deviceService().updateDeviceMeta(deviceId, { name });
  }

  _setControlConnection(payload) {
    const { deviceId } = this._requireDeviceId(payload);
    const connectionType = String(payload?.connectionType || '').trim();
    if (!connectionType) throw this._error('CONNECTION_TYPE_REQUIRED', '缺少控制连接类型');
    return this._deviceService().setControlConnection(deviceId, connectionType);
  }

  async _invokeDevice(payload, context = {}) {
    const { deviceId, device } = this._requireDeviceId(payload);
    const capability = String(payload?.capability || '').trim();
    const action = String(payload?.action || '').trim();
    if (!capability || !action) throw this._error('DEVICE_INVOKE_INVALID', '缺少能力或动作');
    if (this._isRemoteDevice(device)) {
      throw this._error('DEVICE_ACTION_UNSUPPORTED', '不能远程控制由其他客户端投影来的设备');
    }
    const rawInput = payload?.input && typeof payload.input === 'object'
      ? payload.input
      : (payload?.params && typeof payload.params === 'object' ? payload.params : {});
    if (action !== 'stop' && this._isMappedToRunningGame(deviceId)) {
      throw this._error('DEVICE_BUSY', '设备正被运行中的游戏占用');
    }
    // 远程手动输出统一走安全层：按能力限幅、未知字段拒绝
    const limits = this.outputGuard.DEFAULT_REMOTE_LIMITS || {};
    const sanitized = this.outputGuard.sanitizeCapabilityInvoke({
      device, capability, action, input: rawInput, limits,
    });
    if (!sanitized || sanitized.ok === false) {
      throw this._error(sanitized?.code || 'DEVICE_INVOKE_REJECTED', sanitized?.message || '设备指令被安全层拒绝');
    }
    const input = sanitized.input || {};
    const latched = this.outputGuard.isLatchedOutput({ device, capability, action, input });
    if (action === 'stop' || !latched?.latched) {
      try { this.watchdog.clear(deviceId); } catch (_) {}
    }
    const result = await this._deviceService().invokeDeviceCapabilityAndWait(deviceId, capability, action, input);
    // 锁存输出（电击等）由看门狗兜底自动停止，操作方掉线/撤权也会被 stopAll 停掉
    if (latched?.latched && action !== 'stop') {
      try { this.watchdog.arm(deviceId, latched.maxMs); } catch (_) {}
      this._rememberOperatorOutput(context.senderUserId, deviceId);
    }
    return result;
  }

  _rememberOperatorOutput(userId, deviceId) {
    const session = this.session;
    if (!session || !userId) return;
    if (!session.operatorOutputs) session.operatorOutputs = new Map();
    const set = session.operatorOutputs.get(userId) || new Set();
    set.add(deviceId);
    session.operatorOutputs.set(userId, set);
  }

  _isRemoteDevice(device) {
    if (!device) return false;
    if (String(device.controlConnection || device.connectionType || '') === 'remote') return true;
    return Array.isArray(device.connections)
      && device.connections.some((connection) => connection?.type === 'remote');
  }

  async _stopDevice(payload) {
    const { deviceId } = this._requireDeviceId(payload);
    try { this.watchdog.clear(deviceId); } catch (_) {}
    await this._stopRunningGameForDevice(deviceId, 'remote-device-stop');
    return this._deviceService().stopExecutionDeviceAndWait(deviceId);
  }

  async _disconnectDevice(payload) {
    const { deviceId, device } = this._requireDeviceId(payload);
    if (this._isRemoteDevice(device)) {
      throw this._error('DEVICE_ACTION_UNSUPPORTED', '不能断开由其他客户端投影来的设备');
    }
    const connectionType = String(
      payload?.connectionType ?? device.controlConnection ?? '',
    ).trim();
    if (!connectionType) {
      throw this._error('CONNECTION_TYPE_REQUIRED', '缺少可断开的控制连接');
    }
    // mqtt/虚拟设备会自动重连，断开只是假象：如实拒绝，不谎报成功
    if (UNSUPPORTED_DISCONNECT_TYPES.has(connectionType)) {
      throw this._error('DEVICE_ACTION_UNSUPPORTED', '该连接类型（MQTT/虚拟设备）会自动重连，无法保持断开；请改用「停止设备」');
    }
    // 其他连接：先停掉该设备上的输出，再断开
    try { this.watchdog.clear(deviceId); } catch (_) {}
    await this._deviceService().stopExecutionDeviceAndWait(deviceId).catch(() => {});
    await this._stopRunningGameForDevice(deviceId, 'remote-device-disconnect');
    await this._deviceService().disconnectDeviceConnections(deviceId, connectionType);
    return { ok: true, deviceId };
  }

  _validateStart(payload) {
    const game = this.listGames().find((item) => item.id === payload.gameId && item.runtimeMode === 'host');
    if (!game) throw this._error('GAME_NOT_HOSTED', '该游戏暂不支持远程启动');
    const available = new Map(this._deviceList().map((device) => [device.id, device]));
    for (const role of game.devices || []) {
      const ids = payload.deviceMap?.[role.id] || [];
      if (!Array.isArray(ids) || (role.required && ids.length === 0)) {
        throw this._error('DEVICE_MAPPING_REQUIRED', `${role.label || role.id}未映射`);
      }
      for (const id of ids) {
        const device = available.get(id);
        if (!device || device.connected === false) throw this._error('DEVICE_OFFLINE', `${role.label || role.id}设备不在线`);
        if ((role.capabilities || []).some((capability) => !device.capabilities?.includes(capability))) {
          throw this._error('DEVICE_CAPABILITY_MISMATCH', `${role.label || role.id}设备能力不匹配`);
        }
      }
    }
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
      session.gameSessionId = envelope.payload?.gameSessionId || null;
      session.gameSnapshot = envelope.payload?.snapshot || session.gameSnapshot;
      return;
    }
    if (envelope.type === 'client.authorization') {
      session.authorized = !!envelope.payload?.authorized;
      if (!session.authorized) {
        session.devices = [];
        session.games = [];
        session.gameSnapshot = null;
      }
      return;
    }
    if (envelope.type === 'game.snapshot') {
      session.gameSnapshot = envelope.payload || null;
      if (envelope.payload?.gameSessionId) session.gameSessionId = envelope.payload.gameSessionId;
      return;
    }
    if (envelope.type === 'session.revoked') {
      this._endOperatorSession(session, envelope.payload?.reason || 'session-revoked');
    }
  }

  async _respond(session, requestId, payload) {
    const response = { requestId, ...payload };
    session.responseCache.set(requestId, response);
    if (session.responseCache.size > MAX_SEEN_MESSAGE_IDS) {
      session.responseCache.delete(session.responseCache.keys().next().value);
    }
    await this._publishEnvelope(session, 'events', 'client.response', response);
  }

  _acceptIncoming(session, suffix, envelope) {
    if (!envelope || envelope.protocolVersion !== PROTOCOL_VERSION
      || envelope.roomSessionId !== session.roomSessionId) return false;
    if (typeof envelope.messageId !== 'string' || !envelope.messageId
      || session.seenMessageIds.has(envelope.messageId)) return false;
    if (envelope.senderConnectionEpoch != null && typeof envelope.senderConnectionEpoch !== 'string') return false;
    if (envelope.sequence != null) {
      const sequence = Number(envelope.sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 1) return false;
      const key = `${suffix}:${envelope.senderConnectionEpoch || ''}`;
      const previous = session.receivedSequences.get(key) || 0;
      if (sequence <= previous) return false;
      session.receivedSequences.set(key, sequence);
    }
    session.seenMessageIds.add(envelope.messageId);
    if (session.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
      session.seenMessageIds.delete(session.seenMessageIds.values().next().value);
    }
    return true;
  }

  async _publishClientSnapshot(session) {
    if (!session?.client || session.role !== 'owner') return;
    const hostStatus = this._hostStatus();
    await this._publishEnvelope(session, 'events', 'client.snapshot', {
      authorized: !!session.authorized,
      operatorUserId: session.authorizedUserId || null,
      games: this.listGames(),
      devices: this._deviceList(),
      snapshot: hostStatus?.snapshot || null,
      gameSessionId: hostStatus?.sessionId || null,
      operatorOnline: [...session.operatorsOnline.values()].some((item) => item.online),
    });
  }

  async _publishGameSnapshot(session, { force = false } = {}) {
    if (!session?.client || session.role !== 'owner') return;
    const hostStatus = this._hostStatus();
    const snapshot = hostStatus?.snapshot;
    if (!snapshot) return;
    // 结束快照绝不能被 5Hz 节流丢掉
    if (!force && session.lastSnapshotKey === this._snapshotKey(snapshot)) return;
    session.lastSnapshotKey = this._snapshotKey(snapshot);
    await this._publishEnvelope(session, 'events', 'game.snapshot', {
      ...snapshot,
      gameSessionId: hostStatus?.sessionId || null,
    });
    const logs = Array.isArray(snapshot.logs) ? snapshot.logs.slice(0, 5) : [];
    if (logs.length) await this._publishEnvelope(session, 'events', 'game.log', { logs });
  }

  _snapshotKey(snapshot) {
    if (!snapshot) return null;
    return [
      snapshot.running ? 1 : 0,
      snapshot.ended ? 1 : 0,
      snapshot.paused ? 1 : 0,
      snapshot.phase || '',
      snapshot.currentIntensity ?? '',
      snapshot.targetIntensity ?? '',
      snapshot.edgingCount ?? '',
      snapshot.shockCount ?? '',
      snapshot.isShocking ? 1 : 0,
      Math.round(Number(snapshot.currentPressure || 0) * 10),
    ].join(':');
  }

  _hostStatus() {
    try { return this.host.getStatus?.() || null; } catch (_) { return null; }
  }

  _deviceList() {
    const rows = this.listDevices
      ? this.listDevices()
      : (this.host.devices?.listDevicesForApi?.() || []).map((device) => ({
        id: device.id,
        name: device.nickname || device.name || device.id,
        type: device.type,
        connected: !!device.connected,
        connectionType: device.controlConnection || device.connectionType || null,
        connections: device.connections || [],
        capabilities: deviceRegistry.getDeviceCapabilities(device.type),
      }));
    // 从别的客户端投影来的设备不参与远程游戏（不能经 A 控制 C 的设备）
    return rows.filter((device) => !this._isRemoteDevice(device));
  }

  _failPending(session, error) {
    for (const pending of session.pending.values()) {
      this.clearTimer(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
  }

  _clearTimers(session) {
    if (!session?.timers) return;
    if (session.timers.heartbeat) this.clearRepeating(session.timers.heartbeat);
    if (session.timers.snapshot) this.clearRepeating(session.timers.snapshot);
    if (session.timers.credential) this.clearTimer(session.timers.credential);
    if (session.timers.reconnect) this.clearTimer(session.timers.reconnect);
    if (session.connectTimer) this.clearTimer(session.connectTimer);
    if (session.hostOfflineTimer) this.clearTimer(session.hostOfflineTimer);
    session.connectTimer = null;
    session.hostOfflineTimer = null;
    session.timers = { heartbeat: null, snapshot: null, credential: null, reconnect: null };
  }

  _endClient(session, force = false) {
    if (!session.client) return Promise.resolve();
    const client = session.client;
    session.client = null;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const timer = this.setTimer(finish, this.endTimeoutMs);
      try {
        client.end(force, {}, () => { this.clearTimer(timer); finish(); });
      } catch (_) {
        this.clearTimer(timer);
        finish();
      }
    });
  }

  _error(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  _log(message) {
    try { require('../utils/logger').info('RemoteGame', message); } catch (_) {}
  }
}

const remoteGameService = new RemoteGameService({
  beforeHostStart: async () => {
    await require('./localAppProcessService').stopAll();
    try { require('./bridgeService').exitCurrent(); } catch (_) {}
  },
});

module.exports = remoteGameService;
module.exports.RemoteGameService = RemoteGameService;
