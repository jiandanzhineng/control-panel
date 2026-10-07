const mqtt = require('mqtt');
const { randomUUID, randomBytes } = require('crypto');
// 已接入 HostRuntime 的游戏清单来自统一解析器（内置 core + 游戏包里的分离式 core）
const coreResolver = require('../game-runtime/gameCoreResolver');
const { GameStateStream } = require('../game-runtime/gameStateStream');
const { apply: applyPatch } = require('../public/game-state-patch');
const deviceRegistry = require('../devices/registry');
const playCarrierBus = require('./playCarrierBus');

const PROTOCOL_VERSION = 1;
const MAX_SEEN_MESSAGE_IDS = 1024;
const HEARTBEAT_MS = 10000;
// 旧客户端（移动端）兼容：只认全量 game.snapshot，低频推一份，保证它们不掉队
const LEGACY_SNAPSHOT_MS = 5000;
// 画面同步增量：50ms 窗口合并（上限约 20 条/秒），无变化零流量
const STREAM_WINDOW_MS = 50;
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
  'client.ping',
  'client.snapshot.request',
  // 主控端画面丢包 / 重连后补一次全量 game.snapshot（已授权者才放行，见 _onOwnerCommand）
  'game.snapshot.request',
  'session.projection-invite.request',
  'session.emergency-stop',
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
  'play.occupy',
  'play.release',
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
  return coreResolver.listHostGames();
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
    streamWindowMs = STREAM_WINDOW_MS,
    legacySnapshotMs = LEGACY_SNAPSHOT_MS,
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
    this.streamWindowMs = streamWindowMs;
    this.legacySnapshotMs = legacySnapshotMs;
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
    // 画面增量流有两条，diff 基准必须两端一致：
    //   stream     —— 本机页面的状态文档（getStatus()），被控端/主控端各自一份，走 SSE
    //   gameStream —— 房主发给主控端的游戏快照文档（{...snapshot, gameSessionId}），走 MQTT game.patch
    // 两端的 status 文档结构不同（role/authorized/connected…），不能互相套用 ops。
    const streamOptions = {
      windowMs: streamWindowMs,
      now: this.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
    };
    this.stream = new GameStateStream(streamOptions);
    this.gameStream = new GameStateStream(streamOptions);
    // 编排层（remoteSessionService）订阅的事件出口，避免它去读私有字段。
    this.eventHandlers = new Set();
    // 本机玩法载体（bridge / HostRuntime）事件：本机开始时被控端优先，顶掉主控端页面式游戏
    this.carrierUnsub = playCarrierBus.onPlayCarrierChange((event) => {
      try { this._onCarrierEvent(event); } catch (_) {}
    });
  }

  /** 本机开始/结束玩法：被控端本地优先（ADR-0004「后启动者顶掉前者并复位」）。 */
  _onCarrierEvent(event) {
    const session = this.session;
    if (!session || !event) return;
    if (session.role === 'operator') {
      // 主控端自己的页面式玩法载体退出（显式退出 / 浏览器 origin 退出 / ADR-0005 60 秒宽限超时）：
      // 占用不能挂在一个已经不在跑的玩法上，向被控端释放。
      // 'replaced' 除外：那是新玩法顶掉旧玩法，启动路径刚登记过新占用。
      if (event.action === 'exit' && event.kind === 'bridge' && event.reason !== 'replaced') {
        void this._releaseOperatorPlayOnCarrierExit();
      }
      return;
    }
    if (session.role !== 'owner') return;
    if (event.action === 'start') {
      // 被控端自己启动的 HostRuntime 游戏不算「本地占用」，它正是主控端起的玩法
      if (event.kind === 'host' && event.source === 'remote') return;
      void this._preemptForLocalPlay(event);
      return;
    }
    // 被控端自己的玩法退出：占用解除；主控端起的 HostRuntime 游戏退出则通知主控端停止本地游戏
    const remoteGame = event.kind === 'host' && event.source === 'remote';
    void this._onCarrierExit(session, event, remoteGame);
  }

  /** 本机玩法开始：紧急停主控端输出 + 清除占用 + 通知主控端停掉它的游戏（被控端优先）。 */
  async _preemptForLocalPlay(event) {
    const session = this.session;
    if (!session || !session.playOccupancy) return;
    const gameId = session.playOccupancy.gameId || null;
    const gameName = session.playOccupancy.gameName || null;
    session.playOccupancy = null;
    // 顶掉即停：主控端的手动输出先停（ADR-0004 顶掉旧玩法时复位设备）
    await this._stopOperatorOutputs().catch(() => {});
    this._log(`local ${event.kind} play started: released operator play ${gameId || ''}`.trim());
    // 被控端操作记录：谁顶掉了谁的玩法
    this._emitEvent({
      type: 'operator-output',
      kind: 'session.play.preempted',
      outcome: 'ok',
      detail: { gameId, gameName },
    });
    await this._publishPlayOccupancy(session).catch(() => {});
    // 被控端本地开始了玩法：主控端要停掉它本机运行的页面式游戏
    await this._publishEnvelope(session, 'events', 'session.play.preempted', {
      gameId, gameName, reason: 'host-local-play',
    }).catch(() => {});
    this._emitEvent({ type: 'play-preempted', gameId, gameName, reason: 'host-local-play' });
  }

  /** 主控端起的 HostRuntime 玩法在被控端结束：通知主控端停止本地游戏并清占用。 */
  async _onCarrierExit(session, event, remoteGame) {
    if (remoteGame) {
      session.playOccupancy = null;
      // 被控端本地停止主控端起的玩法：同样按「退出即复位」停主控端手动输出
      await this._stopOperatorOutputs().catch(() => {});
      await this._publishPlayOccupancy(session).catch(() => {});
      await this._publishEnvelope(session, 'events', 'session.play.ended', {
        reason: event.reason || 'ended', gameId: event.gameId || null,
      }).catch(() => {});
      this._emitEvent({ type: 'play-ended', reason: event.reason || 'ended' });
      return;
    }
    // 被控端本机玩法退出：占用只由「本机玩法开始」顶掉，退出不动占用
    // （启动路径会先发 start 事件清占用；这里若也清，会把刚登记的新占用误清）
  }

  /** 主控端页面式玩法载体退出：清本地占用并向被控端释放（幂等，失败只影响被控端记录）。 */
  async _releaseOperatorPlayOnCarrierExit() {
    const session = this.session;
    if (!session || session.role !== 'operator' || !session.playOccupancy) return;
    session.playOccupancy = null;
    this._emitEvent({ type: 'play-occupancy', occupancy: null });
    await this.command({ type: 'play.release', payload: {} }).catch(() => {});
  }

  /** 编排层订阅事件（member / authorization / game / operator-output / ended）。返回取消订阅函数。 */
  onEvent(handler) {
    if (typeof handler !== 'function') return () => {};
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  _emitEvent(event) {
    for (const handler of this.eventHandlers) {
      try { handler({ source: 'game', ...event }); } catch (_) {}
    }
  }

  /** 已接入 HostRuntime 的游戏清单（内置 core + 游戏包分离式 core，单一解析器）。 */
  hostGames() {
    return this.listGames().filter((game) => game?.runtimeMode === 'host');
  }

  /** 房主在线成员（userId + 在线状态），供编排层等操作方进投影房间。 */
  getMembers() {
    const session = this.session;
    if (!session || session.role !== 'owner') return [];
    const rows = [];
    const seen = new Set([session.credential.userId]);
    for (const [userId, entry] of session.operatorsOnline.entries()) {
      if (seen.has(userId)) continue;
      seen.add(userId);
      rows.push({ userId, online: !!entry.online });
    }
    for (const member of session.members || []) {
      if (seen.has(member.userId)) continue;
      seen.add(member.userId);
      rows.push({ userId: member.userId, online: false });
    }
    return rows;
  }

  /** 当前授权给哪个 userId（房主视角）；无会话/非房主返回 null。 */
  getAuthorizedUserId() {
    const session = this.session;
    if (!session || session.role !== 'owner') return null;
    return session.authorizedUserId || null;
  }

  /** 某个 userId 是否已被移出本房间（编排层据此禁止再自动授权投影）。 */
  isKicked(userId) {
    const session = this.session;
    if (!session || session.role !== 'owner') return false;
    const target = String(userId || '').trim();
    return !!target && session.kicked.has(target);
  }

  /** 编排层用：把投影房间码只下发给被授权的那个 userId（events 通道 + 快照字段）。 */
  async inviteOperator({ userId, joinCode, projectionRoomId = null } = {}) {
    const session = this.session;
    if (!session || session.role !== 'owner') throw this._error('NOT_OWNER', '只有主机可以下发投影房间');
    const target = String(userId || '').trim();
    const code = String(joinCode || '').trim();
    if (!target || !code) throw this._error('INVALID_OPERATOR', '缺少投影房间信息');
    session.projectionInvite = { joinCode: code, projectionRoomId, forUserId: target };
    await this._publishEnvelope(session, 'events', 'session.projection-invite', session.projectionInvite);
    await this._publishClientSnapshot(session);
    return { ok: true };
  }

  /** 操作方侧：房主下发的投影房间邀请（只对 forUserId 命中本账号时有效）。 */
  getProjectionInvite() {
    const session = this.session;
    if (!session || session.role !== 'operator') return null;
    const invite = session.projectionInvite;
    if (!invite || invite.forUserId !== session.credential.userId) return null;
    return { ...invite };
  }

  /** 停掉远程操作方触发的锁存输出并结束其启动的玩法（急停用；不结束会话）。 */
  async emergencyStop() {
    const session = this.session;
    if (!session || session.role !== 'owner') {
      throw this._error('NOT_OWNER', '只有主机可以急停');
    }
    await this._stopOperatorOutputs();
    const hostStatus = this._hostStatus();
    const startedByOperator = !!hostStatus?.active && hostStatus?.source === 'remote';
    if (startedByOperator) {
      await this.host.stop({ reason: 'remote-emergency-stop' });
      this._applyGameSession(null);
      this._emitEvent({ type: 'operator-output', kind: 'game.stop', outcome: 'ok' });
    }
    // 急停 = 停主控端触发的输出 + 结束主控端启动的玩法：占用一并释放并告知主控端
    // （页面式游戏跑在主控端，被控端看不到它的载体，只能靠这条事件让它停）
    if (session.playOccupancy) {
      session.playOccupancy = null;
      await this._publishPlayOccupancy(session).catch(() => {});
      await this._publishEnvelope(session, 'events', 'session.play.ended', { reason: 'remote-emergency-stop' }).catch(() => {});
    }
    await this._publishClientSnapshot(session).catch(() => {});
    await this._publishGameSnapshot(session, { force: true }).catch(() => {});
    return this.getStatus();
  }

  // ---------- 玩法占用仲裁（ADR-0004：玩法全局唯一，后启动者顶掉前者） ----------

  /**
   * 被控端本地是否正在跑玩法（bridge 活跃 session 或本机来源的 HostRuntime）。
   * 注意：只看「被控端本机」的载体；主控端起在跑的 HostRuntime（source=remote）不算。
   */
  hasLocalPlay() {
    const status = this._hostStatus();
    if (status?.active && (status.source || 'local') === 'local') return true;
    try {
      return (require('./bridgeService').getActiveSessions?.() || []).length > 0;
    } catch (_) {
      return false;
    }
  }

  /**
   * 主控端开始一次玩法（页面式游戏 / 插件跑在主控端，被控端看不到它的 bridge）。
   * 被控端本地玩法优先：本地在跑就拒绝（ADR-0004）。
   * 已在跑同一个玩法时按幂等成功处理（页面关闭 / 断线重连后的重复登记不该被本地玩法误拒）。
   */
  async occupyPlay({ gameId, gameName } = {}) {
    const session = this.session;
    if (!session || session.role !== 'owner') throw this._error('NOT_OWNER', '只有被控端可以登记玩法占用');
    const id = String(gameId || '').trim();
    if (!id) throw this._error('GAME_ID_REQUIRED', '缺少游戏 ID');
    const current = session.playOccupancy;
    if (current?.gameId === id) {
      return { ok: true, gameId: id, gameName: current.gameName || (gameName ? String(gameName) : null), idempotent: true };
    }
    if (this.hasLocalPlay()) throw this._error('HOST_PLAY_ACTIVE', '被控端正在运行本地玩法');
    session.playOccupancy = { gameId: id, gameName: gameName ? String(gameName) : null, at: this.now() };
    // 主控端重新登记了占用：被控端据此放开投影写入（见 remoteSessionService._isPlayOccupied）
    await this._publishPlayOccupancy(session).catch(() => {});
    return { ok: true, gameId: id, gameName: session.playOccupancy.gameName };
  }

  /** 主控端停止 / 退出玩法：清占用。 */
  async releasePlay() {
    const session = this.session;
    if (!session || session.role !== 'owner') throw this._error('NOT_OWNER', '只有被控端可以释放玩法占用');
    session.playOccupancy = null;
    await this._publishPlayOccupancy(session).catch(() => {});
    return { ok: true };
  }

  async _publishPlayOccupancy(session) {
    if (!session?.client || session.role !== 'owner') return;
    const occupancy = session.playOccupancy ? { ...session.playOccupancy } : null;
    // 编排层（被控端）据此显示「{peer} 正在运行《X》」
    this._emitEvent({ type: 'play-occupancy', occupancy });
    await this._publishEnvelope(session, 'events', 'session.play-occupancy', {
      occupancy,
      localPlayActive: this.hasLocalPlay(),
    });
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
      hostUserId: session.room.hostUserId || null,
      connected: session.connected,
      authorized,
      occupancy: session.role === 'owner' ? (session.playOccupancy || null) : null,
      playOccupancy: session.role === 'operator' ? (session.playOccupancy || null) : null,
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
        // 本机页面（SSE）：状态文档进流，50ms 窗口合并，无变化零流量
        this._updateLocalStream();
        if (!session.connected) return;
        // 主控端：游戏快照文档有变化才发 game.patch
        this.gameStream.update(this._gameDoc(status));
        void this._publishGamePatch(session).catch(() => {});
        if (ended) void this._publishGameSnapshot(session, { force: true }).catch(() => {});
      });
      await this._connect(session);
      session.timers.heartbeat = this.setRepeating(() => {
        void this.api.heartbeat(session.token, session.room.id).catch(() => {});
      }, HEARTBEAT_MS);
      // 旧客户端（移动端）只认全量 game.snapshot：低频补发，保证兼容
      session.timers.snapshot = this.setRepeating(() => {
        void this._publishGameSnapshot(session).catch(() => {});
      }, this.legacySnapshotMs);
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
    const session = this.session;
    if (session?.role === 'owner' && session.playOccupancy) {
      // 撤权即结束主控端的玩法：占用不能留给下一个（或没有）被授权的人
      session.playOccupancy = null;
      await this._publishPlayOccupancy(session).catch(() => {});
      await this._publishEnvelope(session, 'events', 'session.play.ended', { reason: 'revoked' }).catch(() => {});
    }
    // 撤权是「对方已收回控制权」：只发 client.authorization（authorized=false）时，
    // 操作方只能从轮询里看到未授权，永远收不到结束通知，界面既没有提示也不会退回
    // 远程连接页（§4.2「被撤销后自动退回本机模式」）。
    // 注意只通知「当前被授权的那个账号」：同一房间可能还有别人（房间容量 2 时不会，
    // 但不能假设），不能把撤权当成「所有人都被结束」广播出去。
    const target = session?.authorizedUserId || null;
    const result = await this._setAuthorized(false);
    if (session?.role === 'owner' && session.connected && target) {
      await this._publishEnvelope(
        session,
        'events',
        'session.revoked',
        { reason: 'revoked', forUserId: target },
      ).catch(() => {});
    }
    return result;
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
    // 被踢的人要收到「对方已将你移出」：服务端踢线未接线，只能靠这条事件通知。
    // 事件走 events 通道（操作方只订阅它），带 forUserId 标明只给这个账号。
    await this._publishEnvelope(session, 'events', 'session.revoked', { reason: 'kicked', forUserId: target }).catch(() => {});
    session.kicked.add(target);
    session.operatorsOnline.delete(target);
    if (session.authorizedUserId === target) session.authorizedUserId = null;
    session.authorized = false;
    // 服务端还断不掉对方的 MQTT，先停掉它起的手动输出
    await this._stopOperatorOutputs();
    // 踢出即结束其玩法：占用与被控端记录一起清掉，并告知主控端停掉本机游戏
    if (session.playOccupancy) {
      session.playOccupancy = null;
      await this._publishPlayOccupancy(session).catch(() => {});
      await this._publishEnvelope(session, 'events', 'session.play.ended', { reason: 'kicked' }).catch(() => {});
    }
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
    this._emitEvent({
      type: 'authorization',
      authorized: !!session.authorized,
      operatorUserId: session.authorizedUserId || null,
    });
    await this._publishEnvelope(session, 'events', 'client.authorization', {
      authorized: session.authorized,
      operatorUserId: session.authorizedUserId,
    });
    await this._publishClientSnapshot(session);
    // 授权后先给一份全量（同时建立 rev 基准），之后才有增量可对齐
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
    const result = await response;
    // 主控端命令的回执里带回状态（game.start 的 sessionId、快照等）：
    // 本机页面（SSE）据此更新，不必等下一次轮询。
    this._updateLocalStream();
    return result;
  }

  async stop({ skipApi = false, reason = 'room-closed' } = {}) {
    const session = this.session;
    if (!session) return this.getStatus();
    // 主控端退出（断开 / 掉线宽限到期）：先把玩法占用释放给被控端，再拆会话
    if (session.role === 'operator' && session.playOccupancy) {
      session.playOccupancy = null;
      await this.command({ type: 'play.release', payload: {} }).catch(() => {});
    }
    this.session = null;
    if (reason !== 'replaced' && reason !== 'backend-shutdown') {
      this._emitEvent({ type: 'ended', reason });
    }
    // 会话已清空：本机页面的画面流立刻发一份「无会话」全量（界面据此收起）
    this.stream.reset(this.getStatus());
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
      // 主控端侧的增量 rev：与房主 game.patch 的 rev 对齐，断档即补全量
      gameRev: 0,
      // 主控端运行的玩法占用（被控端记录）与被控端下发的占用（主控端记录）
      playOccupancy: null,
      projectionInvite: null,
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
      try {
        this._onOperatorEvent(session, envelope);
        // 事件改变的都是同一份状态文档（授权 / 设备 / 游戏快照 / 占用 / 结束）：
        // 处理完就进本机页面（SSE）的增量流，无变化时 diff 为空、不发消息。
        this._updateLocalStream();
      } catch (error) {
        // 处理单条事件抛错不能让整条 MQTT 消息回调炸掉（画面流也不能因此停更）
        this._log(`handle operator event failed (${envelope?.type || 'unknown'}): ${error?.message || error}`);
      }
    }
  }

  _onPresence(session, userId, payload) {
    const online = payload?.status === 'online';
    if (session.role === 'owner') {
      if (!userId || userId === session.credential.userId) return;
      session.operatorsOnline.set(userId, { online, at: this.now() });
      this._emitEvent({ type: 'member', userId, online });
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
    // 本机页面的画面流：立刻发一份 waitingForHost 全量，页面才能显示「等待房主」
    this._updateLocalStream();
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
    this._updateLocalStream();
    void this._publishEnvelope(session, `commands/${session.credential.userId}`, 'client.snapshot.request', {}).catch(() => {});
  }

  _endOperatorSession(session, reason) {
    if (this.session !== session) return;
    this.session = null;
    this._emitEvent({ type: 'ended', reason });
    this._clearTimers(session);
    this._failPending(session, this._error('SESSION_REVOKED', '远程会话已结束'));
    session.authorized = false;
    session.devices = [];
    session.games = [];
    session.gameSnapshot = null;
    void this._endClient(session, true);
    // 会话已清空：画面流直接发一份「无会话」全量（订阅者据此收起界面）
    this.stream.reset(this.getStatus());
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
      this._emitEvent({
        type: 'command',
        userId: senderUserId,
        kind: type,
        target: envelope.payload?.deviceId || envelope.payload?.gameId || null,
        outcome: 'ok',
        detail: null,
      });
      await this._publishClientSnapshot(session);
      await this._publishGameSnapshot(session);
    } catch (error) {
      this._emitEvent({
        type: 'command',
        userId: senderUserId,
        kind: type,
        target: envelope.payload?.deviceId || envelope.payload?.gameId || null,
        outcome: 'rejected',
        detail: { code: error?.code || 'COMMAND_FAILED', message: error?.message || '命令执行失败' },
      });
      await this._respond(session, envelope.messageId, {
        ok: false,
        code: error?.code || 'COMMAND_FAILED',
        message: error?.message || '命令执行失败',
      });
    }
  }

  async _dispatch(type, payload, context = {}) {
    if (type === 'client.hello' || type === 'client.workspace.set') return this.getStatus();
    if (type === 'client.snapshot.request') {
      await this._resyncOperator(this.session);
      return this.getStatus();
    }
    // 画面补全量：只回一份全量快照，不广播（广播留给低频兼容推送）
    if (type === 'game.snapshot.request') {
      await this._publishGameSnapshot(this.session, { force: true });
      return { ok: true };
    }
    // 操作方补要投影房间邀请（授权事件与邀请可能乱序/丢包）
    if (type === 'session.projection-invite.request') {
      const session = this.session;
      return {
        invite: session?.authorizedUserId && session.projectionInvite?.forUserId === session.authorizedUserId
          ? session.projectionInvite
          : null,
      };
    }
    // 延迟测量：回执里带房主时间戳，操作方据此算一次往返
    if (type === 'client.ping') return { now: this.now(), echo: payload?.echo ?? null };
    // 玩法占用仲裁：主控端开始/停止玩法时登记与释放（被控端本地优先）
    if (type === 'play.occupy') return this.occupyPlay(payload);
    if (type === 'play.release') return this.releasePlay();
    // 主控端远程条上的「急停」：只停主控端触发的输出与玩法，会话继续。
    // 调用方（_onOwnerCommand）已校验发送者就是被授权的那个 userId，这里不再重复判权。
    if (type === 'session.emergency-stop') {
      this._emitEvent({ type: 'operator-output', kind: 'session.emergency-stop', outcome: 'ok' });
      return this.emergencyStop();
    }
    if (type === 'games.list') return { games: this.listGames() };
    if (type === 'game.meta') return { games: this.listGames() };
    if (type === 'game.config.get') return this._hostStatus()?.snapshot?.params || {};
    if (type === 'game.config.set') return this.host.setParams(payload.params || payload);
    if (type === 'game.start') {
      this._validateStart(payload);
      // 被控端本地玩法优先：本地在跑时拒绝主控端启动（ADR-0004，与页面式游戏的占用登记同一判据）
      if (this.hasLocalPlay()) throw this._error('HOST_PLAY_ACTIVE', '被控端正在运行本地玩法');
      if (this.beforeHostStart) await this.beforeHostStart();
      // 竞态兜底：beforeHostStart 的 await 期间被控端可能刚起了本机玩法。
      // 此时绝不能再调 host.start —— 它会顶掉本机玩法（gameHostService.start 会 stop 现有 session）。
      // 再判一次，本机玩法优先。
      if (this.hasLocalPlay()) throw this._error('HOST_PLAY_ACTIVE', '被控端正在运行本地玩法');
      // 远程会话：本局核心发出的设备意图与远程手动输出走同一套限幅 + 锁存看门狗
      try { this.host.setRemoteOutputLogHook?.((entry) => this._onRemoteGameOutput(entry)); } catch (_) {}
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
      const session = this.session;
      const result = await this.host.stop({ reason: 'remote-stop' });
      this._applyGameSession(null);
      // 主控端结束玩法：占用随之释放，并告知主控端停掉本机游戏（页面式游戏不推占用事件）
      if (session) {
        session.playOccupancy = null;
        await this._publishPlayOccupancy(session).catch(() => {});
        await this._publishEnvelope(session, 'events', 'session.play.ended', { reason: 'remote-stop' }).catch(() => {});
      }
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

  /**
   * 被控端运行的核心（分离式游戏）发出的设备意图被钳制/被拒绝：
   * 复用「远程输出」事件通道写进被控端操作记录（与远程手动输出同一类目）。
   */
  _onRemoteGameOutput(entry) {
    if (!entry) return;
    this._emitEvent({
      type: 'operation',
      kind: 'host-output',
      outcome: entry.outcome === 'rejected' ? 'rejected' : 'clamped',
      target: entry.deviceId || null,
      detail: {
        code: entry.code || null,
        message: entry.message || null,
        requested: entry.requested || null,
        applied: entry.applied || null,
        gameId: entry.gameId || null,
      },
    });
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
      // 重连后的快照里带着房主之前下发的投影邀请，操作方据此恢复投影链路
      const invite = envelope.payload?.projectionInvite;
      if (invite && invite.forUserId === session.credential.userId) {
        const isNew = !session.projectionInvite
          || session.projectionInvite.joinCode !== invite.joinCode;
        session.projectionInvite = {
          joinCode: invite.joinCode,
          projectionRoomId: invite.projectionRoomId || null,
          forUserId: invite.forUserId,
        };
        if (isNew) this._emitEvent({ type: 'projection-invite', ...session.projectionInvite });
      }
      return;
    }
    if (envelope.type === 'session.projection-invite') {
      // 只认发给本账号的邀请；别的成员的邀请一律忽略
      if (envelope.payload?.forUserId === session.credential.userId) {
        session.projectionInvite = {
          joinCode: envelope.payload.joinCode,
          projectionRoomId: envelope.payload.projectionRoomId || null,
          forUserId: envelope.payload.forUserId,
        };
        this._emitEvent({ type: 'projection-invite', ...session.projectionInvite });
      }
      return;
    }
    if (envelope.type === 'client.authorization') {
      session.authorized = !!envelope.payload?.authorized;
      // 已授权但邀请还没到（乱序/丢包）：主动补发一次，保证投影链路能起来
      if (session.authorized && !session.projectionInvite) {
        void this._publishEnvelope(
          session, `commands/${session.credential.userId}`, 'session.projection-invite.request', {},
        ).catch(() => {});
      }
      if (!session.authorized) {
        session.devices = [];
        session.games = [];
        session.gameSnapshot = null;
      }
      return;
    }
    if (envelope.type === 'game.snapshot') {
      const payload = envelope.payload || null;
      session.gameSnapshot = payload;
      // 全量帧同时是 rev 基准：后面的 game.patch 都相对它计算
      session.gameRev = Number(payload?.rev) || 0;
      if (payload?.gameSessionId) session.gameSessionId = payload.gameSessionId;
      return;
    }
    // 画面增量：只接受建立在本地 rev 之上的 patch，断档就补全量（不猜、不跳帧）
    if (envelope.type === 'game.patch') {
      const payload = envelope.payload || {};
      const rev = Number(payload.rev);
      if (!Number.isFinite(rev)) return;
      if (payload.gameSessionId && payload.gameSessionId !== session.gameSessionId) {
        this._requestGameSnapshot(session);
        return;
      }
      if (Number(payload.baseRev) !== Number(session.gameRev)) {
        this._log(`game.patch rev gap (local ${session.gameRev}, base ${payload.baseRev}): requesting full snapshot`);
        this._requestGameSnapshot(session);
        return;
      }
      const next = applyPatch(session.gameSnapshot, payload.ops);
      if (next == null) {
        this._requestGameSnapshot(session);
        return;
      }
      session.gameSnapshot = next;
      session.gameRev = rev;
      return;
    }
    if (envelope.type === 'session.play-occupancy') {
      session.playOccupancy = envelope.payload?.occupancy || null;
      // 编排层据此清掉主控端本机占用（被控端停止 / 急停时占用会变 null）
      this._emitEvent({ type: 'play-occupancy', occupancy: session.playOccupancy });
      return;
    }
    if (envelope.type === 'session.play.preempted') {
      // 被控端本地开始了玩法：主控端停掉本机运行的页面式游戏（remoteSessionService 据此停）
      this._emitEvent({
        type: 'play-preempted',
        gameId: envelope.payload?.gameId || null,
        gameName: envelope.payload?.gameName || null,
        reason: envelope.payload?.reason || 'host-local-play',
      });
      return;
    }
    if (envelope.type === 'session.play.ended') {
      this._emitEvent({
        type: 'play-ended',
        gameId: envelope.payload?.gameId || null,
        reason: envelope.payload?.reason || 'ended',
      });
      return;
    }
    if (envelope.type === 'session.revoked') {
      // 定向结束（撤权/踢出）带 forUserId：不是发给本账号就忽略
      const forUserId = envelope.payload?.forUserId;
      if (forUserId && forUserId !== session.credential.userId) return;
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
    // 本机页面（SSE）：状态文档的增量源就在这一处（授权 / 成员 / 玩法占用 / 掉线都走它）
    this._updateLocalStream();
    await this._publishEnvelope(session, 'events', 'client.snapshot', {
      authorized: !!session.authorized,
      operatorUserId: session.authorizedUserId || null,
      games: this.listGames(),
      devices: this._deviceList(),
      snapshot: hostStatus?.snapshot || null,
      gameSessionId: hostStatus?.sessionId || null,
      operatorOnline: [...session.operatorsOnline.values()].some((item) => item.online),
      projectionInvite: session.projectionInvite || null,
    });
  }

  async _publishGameSnapshot(session, { force = false } = {}) {
    if (!session?.client || session.role !== 'owner') return;
    const hostStatus = this._hostStatus();
    const snapshot = hostStatus?.snapshot;
    if (!snapshot) return;
    // 结束快照绝不能被低频兼容推送吞掉
    if (!force && session.lastSnapshotKey === this._snapshotKey(snapshot)) return;
    session.lastSnapshotKey = this._snapshotKey(snapshot);
    // 全量帧同时是 rev 基准：之后发出的 game.patch 都相对它计算
    this._resetGameStream(session);
    await this._publishEnvelope(session, 'events', 'game.snapshot', {
      ...snapshot,
      gameSessionId: hostStatus?.sessionId || null,
      // 全量帧带上 rev：主控端据此把后续 game.patch 的 baseRev 对齐
      rev: this.gameStream.getRev(),
    });
    const logs = Array.isArray(snapshot.logs) ? snapshot.logs.slice(0, 5) : [];
    if (logs.length) await this._publishEnvelope(session, 'events', 'game.log', { logs });
  }

  // 被控端本机页面订阅的画面流（SSE 用）：与远程增量共用同一套 rev / ops 语义
  subscribeState(listener) {
    return this.stream.subscribe(listener);
  }

  /**
   * 当前状态文档的 rev 与全量（SSE 进流首帧 / 补全量用）。
   * 先 flush 待发布的变化：首帧必须与 diff 基准一致，否则随后的 patch
   * 会把同一批变化再叠一次（本机页面的状态文档同样带数组）。
   */
  getStateEvent() {
    this.stream.flush();
    return { rev: this.stream.getRev(), state: this.getStatus() };
  }

  // 本机页面（SSE）：状态文档进增量流（合并窗口、无变化不发）。
  // 文档必须是 getStatus()（/api/remote-game/status 的形状）——宿主状态是另一种形状，
  // 绝不能进这条流，否则 diff 会在两种文档之间来回，回放出来的东西四不像。
  _updateLocalStream() {
    this.stream.update(this.getStatus());
  }

  // 主控端侧的完整游戏快照文档：两端用同一份形状做 diff 基准
  _gameDoc(status) {
    const hostStatus = status || this._hostStatus() || {};
    const snapshot = hostStatus.snapshot || null;
    if (!snapshot) return null;
    return { ...snapshot, gameSessionId: hostStatus.sessionId || null };
  }

  // 全量推送前把 rev 归零：低频兼容快照与增量 patch 共用一条 rev 序列，
  // 旧客户端只认 game.snapshot，新客户端拿到全量后 rev 也对得上。
  _resetGameStream(session) {
    const event = this.gameStream.reset(this._gameDoc());
    session.gameRev = event.rev;
    return event;
  }

  // 取当前待发布的增量；没有变化时返回 null（不发消息）
  _nextGamePatch(session) {
    const event = this.gameStream.flush();
    if (!event) return null;
    session.gameRev = event.rev;
    return event;
  }

  // 增量只在被授权操作方在线时才发：与 client.snapshot / 授权下发同一判据，
  // 没人收时不刷通道（新客户端进房/重连一律先收全量，rev 基准由全量建立）。
  _hasAuthorizedOperator(session) {
    if (!session?.authorized || !session.authorizedUserId) return false;
    const entry = session.operatorsOnline.get(session.authorizedUserId);
    return !!entry?.online;
  }

  async _publishGamePatch(session) {
    if (!session?.client || session.role !== 'owner') return;
    if (!this._hasAuthorizedOperator(session)) return;
    const event = this._nextGamePatch(session);
    if (!event) return;
    // 还没有基准快照时 flush 出的是全量事件：按全量发，rev 与之后增量同源
    if (event.type !== 'patch') {
      const doc = event.snapshot;
      if (!doc) return;
      await this._publishEnvelope(session, 'events', 'game.snapshot', { ...doc, rev: event.rev });
      return;
    }
    await this._publishEnvelope(session, 'events', 'game.patch', {
      rev: event.rev,
      baseRev: event.baseRev || 0,
      ops: event.ops || [],
      gameSessionId: this._hostStatus()?.sessionId || null,
      sentAtMs: this.now(),
    });
  }

  // 补全量：进房 / 重连 / 丢包 / 显式请求 → 全量 game.snapshot 并把 rev 归零
  async _resyncOperator(session) {
    if (!session?.client || session.role !== 'owner') return;
    // 没有已授权的操作方时不必广播全量（授权时 _setAuthorized 会主动补一份）
    if (!session.authorizedUserId) return;
    await this._publishGameSnapshot(session, { force: true });
  }

  // 操作方：rev 断档或坏帧时向房主补一次全量
  _requestGameSnapshot(session) {
    if (!session || session.role !== 'operator' || !session.connected) return;
    void this._publishEnvelope(session, `commands/${session.credential.userId}`, 'game.snapshot.request', {})
      .catch(() => {});
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
    session.connected = false;
    // 连接断了：本机页面的画面流立刻发一份「已断开」的全量，
    // 不能等 50ms 合并窗口（也不会再有新的状态变化来触发它）。
    this.stream.reset(this.getStatus());
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
