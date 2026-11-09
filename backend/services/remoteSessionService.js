const remoteGameService = require('./remoteGameService');
const remoteProjectionService = require('./remoteProjectionService');
const { randomUUID } = require('crypto');
const logService = require('./logService');
const eventBus = require('./eventBus');

// 远程会话编排层：同时拉起「远程游戏（主房间）」与「设备投影」两条链路并统一授权。
// 主房间的房间码是唯一对外给用户的码；投影房间码只经主房间下发给被授权的那个 userId。

// 投影控制 TTL 取上限，并在到期前自动续期（会话可能开很久）。
const CONTROL_TTL_SEC = 24 * 60 * 60;
const RENEW_BEFORE_MS = 30 * 60 * 1000;
const RENEW_CHECK_MS = 5 * 60 * 1000;
// 房主等操作方进入投影房间后自动授权：轮询间隔与次数上限。
const AUTHORIZE_RETRY_MS = 3000;
const AUTHORIZE_MAX_ATTEMPTS = 10;
const PING_INTERVAL_MS = 5000;
// 投影房间 join 失败后的重试间隔（房间服务偶发超时不该让会话永久停在「重连中」）。
const PROJECTION_JOIN_RETRY_MS = 5000;
const LOG_LIMIT = 50;
// 结束后的一小段时间内 phase 仍报 ended，让界面能弹出「远程已结束」。
const ENDED_TTL_MS = 60 * 1000;

const KIND_SUMMARY = {
  'projection.write': '控制设备',
  'devices.rename': '重命名设备',
  'devices.controlConnection.set': '切换设备控制连接',
  'devices.invoke': '操作设备',
  'devices.stop': '停止设备',
  'devices.disconnect': '断开设备',
  'host-output': '远程玩法输出',
  'operator-output': '停止主控端输出',
  'play.occupy': '开始玩法',
  'play.release': '结束玩法',
  'session.play.preempted': '被控端本地玩法顶替',
  'session.play.ended': '玩法已结束',
  'game.start': '启动玩法',
  'game.stop': '停止玩法',
  'game.pause': '暂停玩法',
  'game.resume': '继续玩法',
  'game.setParams': '调整玩法参数',
  'game.action': '玩法操作',
  'game.config.set': '保存玩法配置',
  'devices.connect': '连接设备',
  'session.emergency-stop': '主控端急停',
  'session.create': '开启远程',
  'session.authorize': '允许控制',
  'session.revoke': '收回控制权',
  'session.kick': '移出主控端',
  'session.emergencyStop': '急停',
  'session.stop': '结束远程',
  'session.ended': '远程已结束',
  'session.projection-authorize': '设备授权',
};

// 心跳 / 只读请求：被控端用户不关心，不进操作记录（否则 client.ping 每 5s 刷一条）。
const QUIET_KINDS = new Set([
  'client.hello',
  'client.ping',
  'client.snapshot.request',
  'client.workspace.set',
  'game.snapshot.request',
  'session.projection-invite.request',
  'games.list',
  'game.meta',
  'game.config.get',
  'devices.list',
  'devices.scan.start',
  'devices.scan.stop',
]);

// 设备字段 → 操作记录里的人话（没收录的照原样显示）
const FIELD_LABELS = {
  voltage: '电压',
  power: '强度',
  intensity: '强度',
  strength: '强度',
  shock: '电击',
  value: '数值',
  stroke: '行程',
  speed: '速度',
  frequency: '频率',
  pulse: '脉冲',
  lock: '锁',
};
const SUMMARY_FIELDS = ['voltage', 'power', 'intensity', 'strength', 'shock', 'value', 'stroke', 'speed', 'frequency'];

/** 操作记录里的设备名：昵称 > 名称 > id（查不到就用 id） */
function defaultDeviceLabel(id) {
  if (!id) return '';
  try {
    const device = require('./deviceService').getDeviceForApi?.(id);
    const label = String(device?.nickname || device?.name || '').trim();
    return label || id;
  } catch (_) {
    return id;
  }
}

function fieldLabel(field) {
  return FIELD_LABELS[field] || field;
}

class RemoteSessionService {
  constructor({
    game = remoteGameService,
    projection = remoteProjectionService,
    log = logService,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    setRepeating = setInterval,
    clearRepeating = clearInterval,
    controlTtlSec = CONTROL_TTL_SEC,
    renewBeforeMs = RENEW_BEFORE_MS,
    renewCheckMs = RENEW_CHECK_MS,
    authorizeRetryMs = AUTHORIZE_RETRY_MS,
    authorizeMaxAttempts = AUTHORIZE_MAX_ATTEMPTS,
    pingIntervalMs = PING_INTERVAL_MS,
    logLimit = LOG_LIMIT,
    deviceLabel = defaultDeviceLabel,
  } = {}) {
    this.game = game;
    this.projection = projection;
    // 玩法占用仲裁跨两条链路：把「本机玩法优先」的判定注入投影链路，
    // 由它在被控端本地玩法运行 / 顶替后主控端未重新登记期间只放行停止/归零写入。
    try { this.projection.setPlayOccupiedSource?.(() => this._isPlayOccupied()); } catch (_) {}
    this.log = log;
    this.now = now;
    // 玩法 id → 显示名（主控端登记占用时学到），会话级，操作记录据此写游戏名
    this._gameNames = new Map();
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.setRepeating = setRepeating;
    this.clearRepeating = clearRepeating;
    this.controlTtlSec = controlTtlSec;
    this.renewBeforeMs = renewBeforeMs;
    this.renewCheckMs = renewCheckMs;
    this.authorizeRetryMs = authorizeRetryMs;
    this.authorizeMaxAttempts = authorizeMaxAttempts;
    this.pingIntervalMs = pingIntervalMs;
    this.logLimit = logLimit;
    this.deviceLabel = deviceLabel;
    this.state = null;
    this.logEntries = [];
    this.lastEnded = null;
    this._unsubscribes = [];
    this._stopping = false;
    this._latencyMs = null;
    this._lastSessionId = null;
    // 投影撤权 → 主房间级联撤权的重入锁（级联过程会再派发事件，必须挡住自激）
    this._cascadingRevoke = false;
  }

  // ---------- 被控端 ----------

  /** 被控端开启远程：主房间（唯一对外房间码）+ 投影房间（TTL 取上限，自动续期）。 */
  async create({ token } = {}) {
    if (!token) throw this._error('MISSING_TOKEN', '请先登录账号');
    await this.stop({ reason: 'replaced' }).catch(() => {});
    const gameStatus = await this.game.create({ token });
    let projectionStatus = null;
    try {
      projectionStatus = await this.projection.create({
        token,
        controlTtlSec: this.controlTtlSec,
      });
    } catch (error) {
      await this.game.stop({ reason: 'session-create-failed' }).catch(() => {});
      throw error;
    }
    this.state = {
      role: 'owner',
      // 会话身份：结束提示按它对号入座，新会话开始后不再弹上一段的「远程已结束」
      sessionId: randomUUID(),
      phase: 'waiting',
      token,
      joinCode: gameStatus?.joinCode || null,
      projectionRoomId: projectionStatus?.roomId || null,
      projectionJoinCode: projectionStatus?.joinCode || null,
      peerUserId: null,
      authorized: false,
      // 投影侧当前授权给谁：与主房间授权分开记录，二者不一致时（主控端离开投影房间被
      // 投影侧撤权）由编排层级联撤掉主房间授权。
      projectionAuthorizedUserId: null,
      waitingAuthorize: null,
      lastError: null,
      // 本机运行中的玩法（主控端起的）：被控端本地开始时紧急停输出并清占用
      localPlay: null,
      // 被顶替标记：本机玩法顶掉主控端玩法后为 true，主控端重新登记占用（或停止玩法）才复位。
      // 期间投影写入只放行停止/归零，关掉主控端页面式游戏的残余写入窗口。
      playPreempted: false,
      timers: { renew: null, authorize: null, ping: null },
    };
    this.logEntries = [];
    this.lastEnded = null;
    this._latencyMs = null;
    this._lastSessionId = this.state.sessionId;
    this._attach();
    this._scheduleRenewal(this.state);
    this._logEvent('ok', 'session.create', null, { joinCode: this.state.joinCode });
    this._publishModeEvent();
    return this.getStatus();
  }

  /** 主控端加入：只加入主房间；等被控端授权后自动进入投影房间。 */
  async join({ token, joinCode } = {}) {
    if (!token) throw this._error('MISSING_TOKEN', '请先登录账号');
    const code = String(joinCode || '').trim();
    if (!code) throw this._error('JOIN_CODE_REQUIRED', '请输入房间码');
    await this.stop({ reason: 'replaced' }).catch(() => {});
    const gameStatus = await this.game.join({ token, joinCode: code });
    this.state = {
      role: 'operator',
      sessionId: randomUUID(),
      phase: 'pending-authorization',
      token,
      joinCode: null,
      projectionRoomId: null,
      projectionJoinCode: null,
      peerUserId: gameStatus?.hostUserId || null,
      authorized: false,
      // 投影侧授权只对被控端有意义（主控端拿不到投影房间的授权对象），保留同名字段
      // 让两条链路的清理逻辑可以共用。
      projectionAuthorizedUserId: null,
      waitingAuthorize: null,
      lastError: null,
      // 主控端本机运行的玩法占用（被控端记录的那份）
      localPlay: null,
      // 占用是「怎么没的」：host-local-play = 被被控端本地玩法顶替，其余 = 被控端结束/急停。
      // 主控端界面据此选提示文案（顶替与「被控端结束了玩法」不是同一句话）。
      playEndedReason: null,
      timers: { renew: null, authorize: null, ping: null },
    };
    this.logEntries = [];
    this.lastEnded = null;
    this._lastSessionId = this.state.sessionId;
    this._attach();
    this._startPing();
    this._publishModeEvent();
    return this.getStatus();
  }

  // ---------- 授权 / 撤销 / 踢出 / 结束 ----------

  /** 被控端授权当前成员：主房间授权 + 下发投影房间码（只发给该 userId）+ 自动授权投影。 */
  async authorize({ userId } = {}) {
    const state = this._requireState('NOT_OWNER', '只有被控端可以授权');
    if (state.role !== 'owner') throw this._error('NOT_OWNER', '只有被控端可以授权');
    // 显式指定授权对象时先校验：已踢出的成员不能再被授权（主房间的 _setAuthorized 也会排除）
    const requested = String(userId || '').trim();
    if (requested && this.game.isKicked?.(requested)) {
      throw this._error('USER_KICKED', '该成员已被移出房间');
    }
    // 授权结果不靠异步事件回填：面板点「允许控制」时可能还没等到主房间的成员事件，
    // 编排层此时没有 peerUserId，直接从主房间状态里挑当前在线的操作方兜底。
    if (!state.peerUserId) {
      const gameStatus = this._safeStatus(this.game);
      const online = (gameStatus?.operators || []).find((item) => item.online);
      state.peerUserId = online?.userId || (gameStatus?.members || [])
        .find((member) => member.status === 'joined' && member.userId !== gameStatus?.hostUserId)?.userId
        || null;
    }
    await this.game.authorize();
    const target = this.game.getAuthorizedUserId?.() || requested || state.peerUserId;
    if (!target) throw this._error('NO_OPERATOR', '没有可授权的成员');
    state.peerUserId = target;
    state.authorized = true;
    state.phase = 'active';
    state.waitingAuthorize = { userId: target, attempts: 0 };
    this._logEvent('ok', 'session.authorize', target, { projectionRoomId: state.projectionRoomId });
    await this._inviteOperator(state, target);
    this._scheduleAuthorizeRetry(state);
    this._publishModeEvent();
    return this.getStatus();
  }

  /** 撤销授权：两条链路一起撤，回到等待授权。 */
  async revoke() {
    const state = this._requireState('NOT_ACTIVE', '当前没有远程会话');
    if (state.role !== 'owner') throw this._error('NOT_OWNER', '只有被控端可以撤权');
    this._finishAuthorize(state);
    state.authorized = false;
    // 主控端收到撤权通知会结束会话并离开房间，被控端回到「等待加入」；
    // 对方重新加入时 member 上线事件会再把阶段推到「待授权」。
    state.peerUserId = null;
    state.projectionAuthorizedUserId = null;
    state.phase = 'waiting';
    this._logEvent('ok', 'session.revoke', null, null);
    await Promise.allSettled([
      this.game.revoke(),
      this.projection.revoke({ reason: 'session-revoke' }),
    ]);
    // 撤权后操作方设备表必须立刻回到只有本机设备。投影侧的「空清单」是 MQTT 广播，
    // 房主离线/丢包时操作方收不到，这里由编排层轮询兜底一次。
    await this._pruneOperatorProjection();
    this._publishModeEvent();
    this._publishRevoked('revoked');
    return this.getStatus();
  }

  /**
   * 主控端本地兜底：把本机设备表里属于本会话投影房间的 remote 设备摘掉。
   * 撤销授权、房主结束会话时投影层的收尾消息可能收不到（房主已离线或只关了自己的房间），
   * 编排层用「本机已注册的 remote 连接」核对一次，保证设备列表立刻回本机。
   */
  async _pruneOperatorProjection() {
    const projection = this.projection;
    if (typeof projection.pruneRemoteDevices !== 'function') return;
    try { await projection.pruneRemoteDevices('session-revoke'); } catch (_) {}
  }

  /** 踢出成员：急停其输出 + 两条链路都移出 + 关闭授权。 */
  async kick({ userId } = {}) {
    const state = this._requireState('NOT_ACTIVE', '当前没有远程会话');
    if (state.role !== 'owner') throw this._error('NOT_OWNER', '只有被控端可以踢出成员');
    const target = String(userId || state.peerUserId || '').trim();
    if (!target) throw this._error('USER_ID_REQUIRED', '缺少用户 ID');
    this._finishAuthorize(state);
    this._logEvent('ok', 'session.kick', target, null);
    // 先关授权（急停需要授权态才能下发），再停输出、踢人
    await this.projection.revoke({ reason: 'kicked' }).catch(() => {});
    // 关授权时的定向结束通知要带 kicked：主控端据此显示「对方已将你移出」而不是「收回控制权」
    await this.game.revoke({ reason: 'kicked' }).catch(() => {});
    await this.game.emergencyStop().catch(() => {});
    await this.projection.emergencyStop().catch(() => {});
    await Promise.allSettled([
      this.game.kick({ userId: target }),
      this.projection.kick(target),
    ]);
    state.authorized = false;
    state.peerUserId = null;
    state.projectionAuthorizedUserId = null;
    state.phase = 'waiting';
    this._publishModeEvent();
    this._publishRevoked('kicked', target);
    return this.getStatus();
  }

  /** 急停：停主控端触发的输出与玩法，会话继续。被控端直接停，主控端发命令请被控端停。 */
  async emergencyStop() {
    const state = this._requireState('NOT_ACTIVE', '当前没有远程会话');
    if (state.role === 'owner') {
      this._logEvent('ok', 'session.emergencyStop', null, null);
      // 急停即释放玩法占用：主控端本机游戏据此停下并清占用（两条链路一起停）
      state.remotePlay = null;
      state.playPreempted = false;
      const results = await Promise.allSettled([
        this.game.emergencyStop(),
        this.projection.emergencyStop(),
      ]);
      const failed = results.find((item) => item.status === 'rejected');
      if (failed) state.lastError = failed.reason?.message || String(failed.reason);
      return this.getStatus();
    }
    this._logEvent('ok', 'session.emergencyStop', null, { remote: true });
    const result = await this.command({ type: 'session.emergency-stop', payload: {} });
    if (result?.ok === false) {
      state.lastError = result.message || result.code || 'REMOTE_EMERGENCY_STOP_FAILED';
    }
    return this.getStatus();
  }

  /** 结束会话：两条链路级联关闭（被控端关房间，主控端退房间）。 */
  async stop({ reason = 'session-stop' } = {}) {
    const state = this.state;
    if (!state || this._stopping) return this.getStatus();
    this._stopping = true;
    const role = state.role;
    this._teardown();
    try {
      if (role === 'owner') {
        await this.game.stop({ reason: 'session-stop-by-host' }).catch(() => {});
        await this.projection.stop().catch(() => {});
      } else {
        await this.projection.stop().catch(() => {});
        await this.game.stop({ reason }).catch(() => {});
      }
    } finally {
      this._stopping = false;
    }
    // 主房间的 session.revoked 是「对方结束远程」的唯一通知：投影链路不会自己给
    // 操作方发投影层 ended（房主只关掉自己那侧房间）。主控端要自己把投影链路
    // 与设备表收干净，否则被控端的设备会一直留在本机设备列表里。
    if (role === 'operator') {
      await this._teardownOperatorLinks();
      // 投影链路自己那侧「会话已不在」时不会删设备记录，编排层再兜一次
      // （撤权/踢出后投影服务可能已先收尾，_teardownOperatorLinks 里那次就白跑了）。
      await this._pruneOperatorProjection();
    }
    this._markEnded(reason, state.sessionId);
    this._gameNames.clear();
    this._logEvent('ok', 'session.stop', null, { reason });
    this._publishModeEvent();
    this._publishRevoked(reason);
    return this.getStatus();
  }

  shutdown() {
    return this.stop({ reason: 'backend-shutdown' });
  }

  /** 主控端远程模式：设备接口按本会话投影房间过滤。 */
  isOperatorRemoteMode() {
    const state = this.state;
    return !!state && state.role === 'operator'
      && this._isAuthorized(state, this._safeStatus(this.game))
      && !!state.projectionRoomId;
  }

  projectionRoomId() {
    const state = this.state;
    return this.isOperatorRemoteMode() ? state.projectionRoomId : null;
  }

  /** 客户端/事件流用的三态模式：local | remote-operator | remote-controlled。 */
  getMode() {
    const state = this.state;
    if (!state) return 'local';
    if (this.isOperatorRemoteMode()) return 'remote-operator';
    if (state.role === 'owner') return 'remote-controlled';
    return 'local';
  }

  _publishModeEvent() {
    eventBus.publish('session.mode', {
      mode: this.getMode(),
      sessionId: this.state?.sessionId || null,
      role: this.state?.role || null,
    });
  }

  _publishRevoked(reason, userId = null) {
    eventBus.publish('session.revoked', {
      reason: reason || null,
      userId: userId || null,
      role: this.state?.role || null,
    });
  }

  /** 主控端把设备相关写操作转成主房间语义命令（被控端执行后返回结果）。 */
  command({ type, payload } = {}) {
    return this.game.command({ type, payload });
  }

  // ---------- 玩法占用（页面式游戏跑在主控端，被控端登记为一次远程占用） ----------

  /**
   * 主控端开始一次玩法：登记占用。被控端本地有玩法在跑时被拒（HOST_PLAY_ACTIVE），
   * 调用方（games 路由）据此让启动失败可见。已在运行同一游戏时按幂等成功处理。
   */
  async occupyPlay({ gameId, gameName } = {}) {
    const state = this._requireState('NOT_ACTIVE', '当前没有远程会话');
    if (state.role !== 'operator') throw this._error('NOT_OPERATOR', '只有主控端可以登记玩法占用');
    const id = String(gameId || '').trim();
    if (!id) throw this._error('GAME_ID_REQUIRED', '缺少游戏 ID');
    const current = state.localPlay;
    if (current?.gameId === id) return { ok: true, gameId: id, gameName: current.gameName || gameName || null };
    const result = await this.game.command({ type: 'play.occupy', payload: { gameId: id, gameName } });
    if (result?.ok === false) {
      const error = this._error(result.code || 'PLAY_OCCUPY_FAILED', result.message || '玩法占用登记失败');
      state.lastError = error.message;
      throw error;
    }
    const occupancy = result?.result || { gameId: id, gameName: gameName || null };
    if (occupancy.gameName) this._gameNames.set(String(occupancy.gameId || id), String(occupancy.gameName));
    state.localPlay = { gameId: occupancy.gameId || id, gameName: occupancy.gameName || gameName || null };
    state.playEndedReason = null;
    // 被控端记录的那份（界面显示「{peer} 正在运行《X》」用）。
    // 幂等重复登记时被控端不会重发占用事件，这里保留原有记录，避免界面闪一下空档。
    if (result?.result?.idempotent !== true || !state.remotePlay) {
      state.remotePlay = { ...occupancy, gameId: state.localPlay.gameId };
    }
    this._logEvent('ok', 'play.occupy', null, { gameId: id }, gameName);
    return { ok: true, ...state.localPlay };
  }

  /** 主控端玩法结束（停止 / 页面关闭）：释放占用；没有占用时静默成功。 */
  async releasePlay({ gameId } = {}) {
    const state = this._requireState('NOT_ACTIVE', '当前没有远程会话');
    if (state.role !== 'operator') throw this._error('NOT_OPERATOR', '只有主控端可以释放玩法占用');
    const id = String(gameId || '').trim();
    if (state.localPlay && (!id || state.localPlay.gameId === id)) {
      const released = state.localPlay;
      state.localPlay = null;
      state.remotePlay = null;
      state.playPreempted = false;
      this._logEvent('ok', 'play.release', null, { gameId: id || null }, released.gameName);
    }
    const result = await this.game.command({ type: 'play.release', payload: { gameId: id || null } });
    if (result?.ok === false) {
      throw this._error(result.code || 'PLAY_RELEASE_FAILED', result.message || '玩法占用释放失败');
    }
    return { ok: true };
  }

  /** 主控端本机是否在跑被控端记录的玩法（前端据此恢复占用状态）。 */
  localPlay() {
    return this.state?.localPlay ? { ...this.state.localPlay } : null;
  }

  /** 被控端本机开始玩法：紧急停主控端输出 + 清占用（被控端优先，ADR-0004）。 */
  async preemptOperatorPlay(event = {}) {
    const state = this.state;
    if (!state || state.role !== 'owner') return null;
    if (event.source !== 'remote') {
      state.playPreempted = true;
      // 被控端本地玩法优先：急停主控端的两条链路输出并结束其玩法（ADR-0004 顶掉即复位）。
      // 投影链路的锁存输出必须在这里停掉：只靠「挡住后续写入」的话，已经在跑的输出
      // 要等看门狗到期（最长 60s）才停。
      await Promise.allSettled([
        this.game.emergencyStop(),
        this.projection.emergencyStop(),
      ]);
      this._logEvent('ok', 'session.play.preempted', null, { reason: event.reason || 'host-local-play' });
    }
    return this.getStatus();
  }

  /**
   * 被控端视角：是否处于「本机玩法优先」状态 —— 本机玩法在跑，或顶替后主控端尚未重新登记占用。
   * 为 true 时投影链路只放行停止/归零写入（关掉顶替窗口期主控端页面式游戏的残余写入）。
   */
  _isPlayOccupied() {
    const state = this.state;
    if (!state || state.role !== 'owner') return false;
    try {
      // 被控端本机玩法在跑（bridge 活跃 / 本机来源的 HostRuntime）：
      // 主控端只能下发停止/归零（页面式游戏的残余写入被挡下）。
      if (this.game.hasLocalPlay?.()) return true;
    } catch (_) { /* 判定失败按未占用，与旧行为一致 */ }
    // 顶替后主控端尚未重新登记占用：同样只放行停止/归零
    return state.playPreempted === true;
  }

  // ---------- 事件接线 ----------

  _attach() {
    this._detach();
    this._unsubscribes.push(this.game.onEvent((event) => {
      try { this._onGameEvent(event); } catch (_) {}
    }));
    this._unsubscribes.push(this.projection.onEvent((event) => {
      try { this._onProjectionEvent(event); } catch (_) {}
    }));
  }

  _detach() {
    for (const unsubscribe of this._unsubscribes) {
      try { unsubscribe(); } catch (_) {}
    }
    this._unsubscribes = [];
  }

  _onGameEvent(event) {
    const state = this.state;
    if (!state) return;
    // 主控端（操作方）在本机点「急停」：主房间的 session.emergency-stop 只停设备输出
    // （投影链路的锁存输出由被控端操作方输出看门狗兜底），投影链路本身没有被停，
    // 这里由编排层补一条：投影链路也急停一次。掉线/未授权时不打扰。
    if (event.type === 'operator-output' && event.kind === 'session.emergency-stop'
        && state.role === 'operator' && this._isAuthorized(state, this._safeStatus(this.game))) {
      void Promise.resolve(this.projection.emergencyStopOperatorOutputs?.('session-emergency-stop')).catch(() => {});
    }
    if (event.type === 'member' && state.role === 'owner') {
      // 被授权者：peerUserId 与主房间当前授权对象是同一份事实（主房间不存在第二个被授权者）。
      // 主房间可能还没回填 peerUserId（面板先点了授权），以主房间授权为准兜底。
      const authorizedUserId = state.peerUserId || this.game.getAuthorizedUserId?.() || null;
      // 投影侧当前授权对象：以投影服务的实时状态为准（它才是事实），服务报不出来时用本层缓存兜底
      const projectionStatus = this._safeStatus(this.projection);
      const projectionAuthorizedUserId = projectionStatus && 'authorizedUserId' in projectionStatus
        ? (projectionStatus.authorizedUserId || null)
        : (state.projectionAuthorizedUserId || null);
      if (event.online && event.userId && !state.peerUserId) state.peerUserId = event.userId;
      // 有成员上线且尚未授权 → 进入「待授权」：被控端面板据此显示「允许控制 / 拒绝」，
      // 远程条也据此出现授权按钮（没有这一步，房主看不到任何可点的授权入口）。
      if (event.online && event.userId && !state.authorized && state.phase === 'waiting') {
        state.phase = 'pending-authorization';
      }
      // 已授权的主控端重新上线（异常掉线后回来，没有 leave 所以主房间授权还在）：
      // 投影侧可能已经掉了（App 被杀后重进时投影链路要重建），补一次邀请并重排自动授权轮询，
      // 否则主房间 authorized=true、投影侧授权为空，主控端设备页永远为空。
      if (event.online && state.authorized && event.userId === authorizedUserId
          && projectionAuthorizedUserId !== event.userId) {
        void this._reauthorizeProjection(state, event.userId);
      }
      return;
    }
    if (event.type === 'authorization' && state.role === 'owner') {
      if (!event.authorized) {
        state.authorized = false;
        state.peerUserId = null;
        state.projectionAuthorizedUserId = null;
        // 授权关闭后没有可授权对象：待授权也一并回到等待，避免远程条出现点不动的「允许控制」
        if (state.phase === 'active' || state.phase === 'pending-authorization') state.phase = 'waiting';
      }
      return;
    }
    if (event.type === 'projection-invite' && state.role === 'operator') {
      // 房主下发的投影房间码：主控端自动加入投影房间
      void this._joinProjectionRoom(state);
      return;
    }
    if (event.type === 'command' || event.type === 'operation' || event.type === 'operator-output') {
      this._recordEvent(event);
      return;
    }
    if (event.type === 'play-occupancy' && state.role === 'owner') {
      // 被控端记录的主控端玩法占用：界面据此显示「{peer} 正在运行《X》」
      state.remotePlay = event.occupancy || null;
      if (state.remotePlay) state.playPreempted = false;
      // 占用消失 = 主控端玩法已结束（被控端停止 / 急停）：localPlay 变 null 即界面停本机游戏的信号
      return;
    }
    if (event.type === 'play-occupancy' && state.role === 'operator') {
      // 被控端回执的占用状态：主控端据此恢复/清掉本机玩法占用（重连补全量也走这里）
      const next = event.occupancy || null;
      if (state.localPlay && !next) state.playEndedReason = 'host-stopped';
      if (next) state.playEndedReason = null;
      state.localPlay = next;
      return;
    }
    if (event.type === 'play-preempted') {
      if (state.role === 'owner') {
        // 被控端本地开始了玩法：停掉本机页面式游戏并复位设备（被控端优先）
        void this.preemptOperatorPlay({ source: event.source, reason: event.reason });
      } else {
        state.localPlay = null;
        state.playEndedReason = event.reason || 'host-local-play';
        this._logEvent('rejected', 'session.play.preempted', null, { reason: event.reason || null });
        // 通知界面停掉本机游戏并弹出「被控端开始了本地玩法，已停止你的游戏」
      }
      return;
    }
    if (event.type === 'ended' && state.role === 'operator') {
      this._markEnded(event.reason || 'ended');
      this._teardown();
      this._logEvent('ok', 'session.ended', null, { reason: event.reason || null });
      this._publishModeEvent();
      this._publishRevoked(event.reason || 'ended');
      // 被控端只关掉自己那侧房间（stop/踢出/离线）：主控端的投影链路与设备表要自己收掉
      void this._teardownOperatorLinks();
    }
  }

  _onProjectionEvent(event) {
    const state = this.state;
    // 会话已经结束（被控端 stop/revoke/kick 或投影链路自行结束）：投影侧的收尾事件
    // 不能再被忽略。被控端 stop() 已把 state 置空，而操作方只剩这条通知来拆掉
    // 本机还挂着的投影链路（否则远端设备会一直留在本机设备表里）。
    if (!state) {
      if (this._stopping) return;
      if (event.type === 'ended') {
        this._markEnded(event.reason || 'ended');
        this._logEvent('ok', 'session.ended', null, { reason: event.reason || null });
        this._publishModeEvent();
        this._publishRevoked(event.reason || 'ended');
        // 投影链路自己结束了（房主关掉他那侧房间）：主控端把链路与设备表收干净
        void this._teardownOperatorLinks();
      }
      return;
    }
    if (event.type === 'peer' && state.role === 'operator' && event.roomId) {
      // 操作方自己 join 投影房间时也会收到一次 peer：房间码由主房间邀请决定
      void this._joinProjectionRoom(state);
      return;
    }
    if (event.type === 'revoked' && state.role === 'owner'
        && (!event.userId || event.userId === (state.peerUserId || this.game.getAuthorizedUserId?.()))) {
      // 投影侧撤权了：本层记录的「投影授权对象」必须跟着清掉，否则主控端重新上线时
      // 会误判投影仍授权、不再补邀请与自动授权。
      state.projectionAuthorizedUserId = null;
      if (state.authorized && event.reason === 'operator-left-room') {
        // 主控端主动离开投影房间（＝断开，不是异常掉线）：投影侧已自行撤权，
        // 这里把主房间的授权一起撤掉，避免半状态（重新加入必须重新「允许控制」）。
        void this._cascadeRevokeFromProjection(state, event);
      }
      return;
    }
    if (event.type === 'write-result' && state.role === 'operator') {
      // 投影写入的最终结果：主控端据此把「已发送」更新为已执行/失败。
      if (event.ok === false) {
        state.lastError = event.code || 'DEVICE_WRITE_FAILED';
        this._logEvent('rejected', 'devices.invoke', null, { code: event.code || null });
      }
      return;
    }
    if (event.type === 'operation' || event.type === 'command') {
      this._recordEvent(event);
      return;
    }
    if (event.type === 'play-ended' && state.role === 'operator') {
      if (state.localPlay) state.playEndedReason = event.reason || 'ended';
      state.localPlay = null;
      return;
    }
    if (event.type === 'ended' && state.role === 'operator') {
      this._markEnded(event.reason || 'ended');
      this._teardown();
      this._logEvent('ok', 'session.ended', null, { reason: event.reason || null });
      this._publishModeEvent();
      this._publishRevoked(event.reason || 'ended');
      // 被控端只关掉自己那侧房间：主控端的投影链路与设备表要自己收掉
      void this._teardownOperatorLinks();
    }
  }

  /** 主控端收尾：投影链路 + 本机设备表里的投影设备。
   * 会话已结束时（state 为空）投影服务自身可能仍连着，必须显式停掉。
   * 关闭过程会重新派发投影层事件，用 _stopping 挡住重入。
   */
  async _teardownOperatorLinks() {
    if (this._stopping) return;
    this._stopping = true;
    try {
      const projection = this._safeStatus(this.projection);
      if (projection?.active || projection?.connected) {
        await this.projection.stop().catch(() => {});
      }
      await this._pruneOperatorProjection();
    } finally {
      this._stopping = false;
    }
  }

  // ---------- 邀请 / 自动授权 ----------

  /** 主控端收到投影房间邀请后自动加入；房间码只认主房间下发给本账号的那个。 */
  async _joinProjectionRoom(state) {
    // join 过程中投影服务会先派发一次 peer 事件：用 in-flight 标记避免递归重入
    if (this.state !== state || state.joiningProjection) return;
    const invite = this.game.getProjectionInvite?.();
    const joinCode = invite?.joinCode || null;
    // 房间码只来自主房间下发给本账号的邀请；join 后拿到真实 roomId 才能过设备过滤
    if (!joinCode) return;
    // 已经在这个房间了：只是补发/重放的邀请，不重复 join
    if (state.projectionJoinCode === joinCode && state.projectionRoomId) return;
    // 上一轮 join 失败（房间服务超时等）时不能只靠「邀请还在」就永久停在
    // 「重连中」：已经排了重试定时器就等它，否则再试一次。
    if (state.projectionJoinRetry) return;
    state.joiningProjection = true;
    state.projectionJoinCode = joinCode;
    try {
      const status = await this.projection.join({ token: state.token, joinCode });
      state.projectionRoomId = status?.roomId || invite?.projectionRoomId || null;
      state.projectionJoinRetry = false;
      this._logEvent('ok', 'session.projection-join', null, { roomId: state.projectionRoomId });
      // 主控端拿到投影房间后 isOperatorRemoteMode 可能已经成立，模式切换要通知客户端
      this._publishModeEvent();
    } catch (error) {
      state.projectionRoomId = null;
      state.lastError = error?.message || String(error);
      this._logEvent('rejected', 'session.projection-join', null, { message: state.lastError });
      // 5 秒后再试：房间服务偶发超时不该让整场会话停在「重连中」
      state.projectionJoinRetry = true;
      state.timers.authorize = this.setTimer(() => {
        if (this.state !== state) return;
        state.projectionJoinRetry = false;
        void this._joinProjectionRoom(state);
      }, PROJECTION_JOIN_RETRY_MS);
    } finally {
      state.joiningProjection = false;
    }
  }

  /** 把投影房间码下发给被授权的那个 userId（主房间 events 通道）。 */
  async _inviteOperator(state, userId) {
    if (!state.projectionJoinCode || !userId) return;
    try {
      await this.game.inviteOperator({
        userId,
        joinCode: state.projectionJoinCode,
        projectionRoomId: state.projectionRoomId,
      });
    } catch (error) {
      state.lastError = error?.message || String(error);
      this._logEvent('rejected', 'session.projection-invite', userId, {
        message: state.lastError,
      });
    }
  }

  /**
   * 已授权的主控端重新上线时补投影链路：重发邀请 + 重排自动授权轮询
   * （_tryAuthorizeProjection 会轮询到它进投影房间后再 projection.authorize）。
   * 主房间授权保留（异常掉线不等于断开），所以这里不碰 authorized。
   */
  async _reauthorizeProjection(state, userId) {
    await this._inviteOperator(state, userId);
    // 主房间当前授权对象：owner state 里维护的是 peerUserId（授权时写入、撤权/踢出/级联时清空）
    if (this.state !== state || !state.authorized
        || (state.peerUserId || this.game.getAuthorizedUserId?.()) !== userId) return;
    state.waitingAuthorize = { userId, attempts: 0 };
    this._scheduleAuthorizeRetry(state);
  }

  /** 操作方进入投影房间后由被控端自动授权；顺序不定，轮询到出现或超次数为止。 */
  _scheduleAuthorizeRetry(state) {
    this._clearAuthorizeTimer(state);
    if (!state.waitingAuthorize) return;
    const tick = async () => {
      const current = this.state;
      if (current !== state || !state.waitingAuthorize) return;
      if (await this._tryAuthorizeProjection(state)) return;
      // 轮询在飞行中被 stop()/revoke() 结束：不能再排下一次，否则会留下没人清的定时器
      if (this.state !== state || !state.waitingAuthorize) return;
      state.waitingAuthorize.attempts += 1;
      if (state.waitingAuthorize.attempts >= this.authorizeMaxAttempts) {
        const userId = state.waitingAuthorize.userId;
        this._finishAuthorize(state);
        this._logEvent('rejected', 'session.projection-authorize', userId, {
          message: '主控端未进入投影房间',
        });
        return;
      }
      state.timers.authorize = this.setTimer(() => { void tick(); }, this.authorizeRetryMs);
    };
    // 先立刻试一次（操作方可能已经在房间里），没赶上再按间隔重试
    void tick();
  }

  async _tryAuthorizeProjection(state) {
    const userId = state.waitingAuthorize?.userId;
    if (!userId) return true;
    // 已踢出的成员：绝不能再自动授权（否则「踢出」只是把主房间的授权关掉，投影房间还会被补授权）
    if (this.game.isKicked?.(userId)) {
      this._logEvent('rejected', 'session.projection-authorize', userId, {
        message: '成员已被移出房间',
      });
      this._finishAuthorize(state);
      return true;
    }
    if (this.projection.hasMember?.(userId)) {
      try {
        await this.projection.authorize(userId);
      } catch (error) {
        state.lastError = error?.message || String(error);
        return false;
      }
      // 记录投影侧授权对象：主控端离开投影房间被投影侧撤权时，编排层据此级联撤掉主房间授权
      state.projectionAuthorizedUserId = userId;
      // 轮询期间被踢出：授权刚落地也要立刻撤掉，避免「踢出后仍被授权」
      if (this.game.isKicked?.(userId)) {
        state.projectionAuthorizedUserId = null;
        await this.projection.revoke({ reason: 'kicked-during-authorize' }).catch(() => {});
        this._logEvent('rejected', 'session.projection-authorize', userId, {
          message: '成员已被移出房间',
        });
        this._finishAuthorize(state);
        return true;
      }
      this._finishAuthorize(state);
      // 设备投影授权成功只是「允许控制」的内部一步，被控端用户不关心；失败才记
      return true;
    }
    return false;
  }

  _clearAuthorizeTimer(state) {
    if (state?.timers?.authorize) {
      this.clearTimer(state.timers.authorize);
      state.timers.authorize = null;
    }
  }

  /** 投影自动授权结束（成功或放弃）：停掉重试并清掉待授权对象。 */
  _finishAuthorize(state) {
    this._clearAuthorizeTimer(state);
    if (state) state.waitingAuthorize = null;
  }

  // ---------- 投影侧撤权 → 主房间级联撤权 ----------

  /**
   * 投影侧撤权（如「主控端离开投影房间」）后把主房间授权一起撤掉，
   * 避免「主房间已授权、投影已撤」的半状态：主控端同码重新加入时主房间会误判
   * 「已授权、直接恢复」，却拿不到投影邀请、设备页永远为空。
   *
   * 语义：主控端主动断开（离开房间）＝会话对该主控端结束，重新加入必须重新经过「允许控制」；
   * 异常掉线（MQTT 断开、App 被杀，没有 leave）保留授权，重新上线时由 _onGameEvent 补投影授权。
   * 用 _cascadingRevoke 挡住重入：级联过程会再派发事件，不能自激。
   */
  async _cascadeRevokeFromProjection(state, event) {
    if (this._cascadingRevoke) return;
    this._cascadingRevoke = true;
    try {
      if (this.state !== state) return;
      this._finishAuthorize(state);
      state.authorized = false;
      state.peerUserId = null;
      state.projectionAuthorizedUserId = null;
      state.phase = 'waiting';
      this._logEvent('ok', 'session.revoke', event?.userId || null, { reason: event?.reason || null });
      // 投影侧已经撤过权了，这里只撤主房间（再调一次 projection.revoke 只会重复发事件）
      await this.game.revoke().catch(() => {});
      // 操作方设备表回到只有本机设备：投影侧的空清单是 MQTT 广播，房主离线/丢包时收不到
      await this._pruneOperatorProjection();
      this._publishModeEvent();
      this._publishRevoked(event?.reason || 'revoked', event?.userId || null);
    } finally {
      this._cascadingRevoke = false;
    }
  }

  // ---------- 投影 TTL 续期 / 延迟 ----------

  _scheduleRenewal(state) {
    if (state.role !== 'owner') return;
    const tick = async () => {
      if (this.state !== state) return;
      if (this._needsRenew()) {
        try {
          await this.projection.extendControl({ controlTtlSec: this.controlTtlSec });
          this._logEvent('ok', 'session.projection-renew', null, null);
        } catch (error) {
          state.lastError = error?.message || String(error);
          this._logEvent('rejected', 'session.projection-renew', null, { message: state.lastError });
        }
      }
      if (this.state === state) {
        state.timers.renew = this.setTimer(() => { void tick(); }, this.renewCheckMs);
      }
    };
    state.timers.renew = this.setTimer(() => { void tick(); }, this.renewCheckMs);
  }

  /** 投影控制是否接近到期（到期前 renewBeforeMs 内续期）。 */
  _needsRenew() {
    const status = this._safeStatus(this.projection);
    if (!status?.active || !status.controlExpiresAt) return false;
    const expiresAt = Date.parse(status.controlExpiresAt);
    if (!Number.isFinite(expiresAt)) return false;
    return expiresAt - this.now() <= this.renewBeforeMs;
  }

  _startPing() {
    const state = this.state;
    if (!state || state.role !== 'operator') return;
    const tick = async () => {
      if (this.state !== state) return;
      // 未授权时房主会拒绝命令：不白打流量，等授权后再测延迟
      if (this._isAuthorized(state, this._safeStatus(this.game))) {
        const sentAt = this.now();
        try {
          const response = await this.game.command({ type: 'client.ping', payload: { echo: sentAt } });
          if (this.state === state && response?.ok !== false) this._latencyMs = this.now() - sentAt;
        } catch (_) { /* 延迟测量失败不影响会话 */ }
      }
      if (this.state === state) {
        state.timers.ping = this.setTimer(() => { void tick(); }, this.pingIntervalMs);
      }
    };
    state.timers.ping = this.setTimer(() => { void tick(); }, this.pingIntervalMs);
  }

  // ---------- 操作记录 ----------

  _recordEvent(event) {
    const outcome = event.outcome === 'clamped' || event.outcome === 'rejected' ? event.outcome : 'ok';
    const detail = event.detail || null;
    // operator-output 是「主控端输出被停」的汇总事件，按它自己的名字记一条
    const kind = event.type === 'operator-output' ? 'operator-output' : (event.kind || 'unknown');
    // 心跳 / 只读请求不进操作记录
    if (QUIET_KINDS.has(kind)) return;
    const summary = this._summarize(kind, outcome, event.target, detail, event.gameName);
    this._pushLog({
      ts: this.now(),
      userId: event.userId || null,
      kind,
      target: event.target || null,
      summary,
      outcome,
      detail: this._summarizeDetail(kind, outcome, detail),
    });
  }

  _logEvent(outcome, kind, target, detail, gameName) {
    this._pushLog({
      ts: this.now(),
      userId: null,
      kind,
      target: target || null,
      summary: this._summarize(kind, outcome, target, detail, gameName),
      outcome,
      detail: detail || null,
    });
  }

  _label(id) {
    if (!id) return '';
    try { return String(this.deviceLabel(id) || id); } catch (_) { return String(id); }
  }

  /** 摘要只写「做了什么」；限制/拒绝由结果标签表达，细节放 detail.hint（悬停显示）。 */
  _summarize(kind, outcome, target, detail, gameName) {
    const base = KIND_SUMMARY[kind] || kind;
    const name = this._label(target);
    const applied = detail?.applied;
    if (applied && typeof applied === 'object') {
      const field = SUMMARY_FIELDS.find((key) => applied[key] !== undefined);
      if (field) return `${base}「${name}」${fieldLabel(field)} ${applied[field]}`;
      if (applied.brand && applied.cmd) return `${base}「${name}」${applied.brand}.${applied.cmd}`;
    }
    if (kind === 'devices.rename') return `重命名「${name}」`;
    if (kind === 'devices.controlConnection.set') return `切换「${name}」的控制连接`;
    // 玩法类：写游戏名（主控端登记占用时带 gameName），没有才退回游戏 id；target 是游戏 id 不是设备
    if (kind.startsWith('game.') || kind.startsWith('play.')) {
      const game = this._gameName(target, detail?.gameId, gameName);
      return game ? `${base}《${game}》` : base;
    }
    return name ? `${base}「${name}」` : base;
  }

  /** 玩法显示名：命令带的 gameName → 本会话登记过的名字 → 游戏 id。 */
  _gameName(target, detailGameId, gameName) {
    const id = String(target || detailGameId || '').trim();
    const known = id ? this._gameNames?.get(id) : null;
    return String(gameName || '').trim() || known || id;
  }

  /** 悬停详情：限制 → 「请求 999 → 实际 20」；拒绝 → 原因 */
  _hint(outcome, detail) {
    if (outcome === 'clamped') {
      const applied = detail?.applied || {};
      const requested = detail?.requested || {};
      const parts = Object.keys(applied)
        .filter((key) => requested[key] !== undefined && String(requested[key]) !== String(applied[key]))
        .map((key) => `${fieldLabel(key)}：请求 ${requested[key]} → 实际 ${applied[key]}`);
      if (parts.length === 1) return parts[0].replace(/^[^：]+：/, '');
      if (parts.length) return parts.join('；');
    }
    return String(detail?.message || detail?.code || '');
  }

  _summarizeDetail(kind, outcome, detail) {
    if (!detail) return null;
    const out = { kind };
    if (detail.code) out.code = detail.code;
    if (detail.message) out.message = detail.message;
    if (detail.requested) out.requested = detail.requested;
    if (detail.applied) out.applied = detail.applied;
    const hint = outcome === 'ok' ? '' : this._hint(outcome, detail);
    if (hint) out.hint = hint;
    return out;
  }

  _pushLog(entry) {
    // 玩法命令的显示名只在本会话内学到（payload 里带 gameName 时），会话结束后不残留
    if (entry?.kind && (entry.kind.startsWith('game.') || entry.kind.startsWith('play.'))) {
      const id = String(entry.target || entry.detail?.gameId || '').trim();
      const name = this._gameName(id, entry.detail?.gameId, entry.gameName);
      if (id && name && name !== id) this._gameNames.set(id, name);
    }
    this.logEntries.push(entry);
    if (this.logEntries.length > this.logLimit) {
      this.logEntries.splice(0, this.logEntries.length - this.logLimit);
    }
  }

  // ---------- 状态 ----------

  getStatus() {
    const state = this.state;
    const ended = this._endedState();
    if (!state) {
      return {
        active: false,
        role: null,
        phase: ended ? 'ended' : 'idle',
        sessionId: ended?.sessionId || null,
        joinCode: null,
        peer: null,
        authorized: false,
        links: { game: { connected: false }, projection: { connected: false, roomId: null } },
        occupancy: null,
        localPlay: null,
        playEndedReason: null,
        latencyMs: null,
        lastError: ended?.reason || null,
        log: [...this.logEntries],
      };
    }
    const gameStatus = this._safeStatus(this.game);
    const projectionStatus = this._safeStatus(this.projection);
    return {
      active: true,
      role: state.role,
      phase: this._phase(state, gameStatus, projectionStatus),
      sessionId: state.sessionId || null,
      joinCode: state.role === 'owner' ? state.joinCode : null,
      peer: state.peerUserId
        ? { userId: state.peerUserId, nickname: null }
        : null,
      authorized: this._isAuthorized(state, gameStatus),
      links: {
        game: { connected: !!gameStatus?.connected },
        projection: {
          connected: !!projectionStatus?.connected,
          roomId: state.projectionRoomId || projectionStatus?.roomId || null,
        },
      },
      occupancy: state.role === 'owner' ? (state.remotePlay || null) : null,
      localPlay: state.role === 'operator' ? (state.localPlay || null) : null,
      playEndedReason: state.role === 'operator' ? (state.playEndedReason || null) : null,
      latencyMs: state.role === 'operator' ? this._latencyMs : null,
      lastError: state.lastError || null,
      log: [...this.logEntries],
    };
  }

  /**
   * 是否已授权。主控端以「主房间已授权」为准（投影房间是随后才起来的，
   * 不能拿它当授权的判据，否则自动进投影的窗口期会显示成未授权）。
   */
  _isAuthorized(state, gameStatus) {
    if (state.role === 'owner') return !!state.authorized;
    return !!gameStatus?.authorized;
  }

  /** 记一次结束：带上刚结束的会话身份（state 已清空时用最近一次会话的 id） */
  _markEnded(reason, sessionId) {
    const id = sessionId || this.state?.sessionId || this._lastSessionId || null;
    this.lastEnded = { at: this.now(), reason, sessionId: id };
  }

  _endedState() {    const ended = this.lastEnded;
    if (!ended) return null;
    if (this.now() - ended.at > ENDED_TTL_MS) {
      this.lastEnded = null;
      return null;
    }
    return ended;
  }

  _phase(state, gameStatus, projectionStatus) {
    if (state.role === 'owner') {
      if (state.authorized && state.phase === 'active') return 'active';
      if (state.phase === 'pending-authorization') return 'pending-authorization';
      return 'waiting';
    }
    if (!this._isAuthorized(state, gameStatus)) return 'pending-authorization';
    // 已授权但任一条链路断开（MQTT 重连/房主宽限期）→ 重连中
    const connected = !!gameStatus?.connected && !!projectionStatus?.connected;
    return connected ? 'active' : 'reconnecting';
  }

  _teardown() {
    const state = this.state;
    this.state = null;
    this._detach();
    if (!state) return;
    if (state.timers.renew) this.clearTimer(state.timers.renew);
    if (state.timers.authorize) this.clearTimer(state.timers.authorize);
    if (state.timers.ping) this.clearTimer(state.timers.ping);
    state.timers = { renew: null, authorize: null, ping: null };
  }

  _requireState(code, message) {
    if (!this.state) throw this._error(code, message);
    return this.state;
  }

  _safeStatus(service) {
    try { return service?.getStatus?.() || null; } catch (_) { return null; }
  }

  _error(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
}

const remoteSessionService = new RemoteSessionService();

module.exports = remoteSessionService;
module.exports.RemoteSessionService = RemoteSessionService;
module.exports.CONTROL_TTL_SEC = CONTROL_TTL_SEC;
