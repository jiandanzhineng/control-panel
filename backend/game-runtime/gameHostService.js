const { randomUUID } = require('crypto');
// 已接入 HostRuntime 的游戏与它们的 core 都来自统一解析器：
// 游戏包里的 game-core.js 优先，内置 cores/ 兜底（见 docs/architecture/split-game-contract.md）
const coreResolver = require('./gameCoreResolver');
const { GameCoreRuntime } = require('./gameCoreRuntime');
const { GameStateStream } = require('./gameStateStream');
const remoteOutputGuard = require('../services/remoteOutputGuard');
const agentControl = require('../services/agentControlService');
// 玩法载体事件：HostRuntime 起停也通知远程占用仲裁（与 bridgeService 共用一条总线）
const playCarrierBus = require('../services/playCarrierBus');

const TICK_MS = 80;
// 画面同步：50ms 窗口合并，无变化不发（见 docs/architecture/split-game-contract.md）
const STREAM_WINDOW_MS = 50;
// 事件模式：未声明 = legacy（内置核心，只收 sensor 事件）；'v2' = 通用设备事件（见契约第 3 节）
const EVENTS_MODE_V2 = 'v2';
const STOP_CAPABILITIES = ['shock', 'strength', 'motors', 'estim', 'pump', 'lock', 'reporting'];
// 远程会话下核心设备意图的持有方上限：与设备投影/远程手动输出同一份默认值（远程会话模式方案 §5）
const DEFAULT_REMOTE_LIMITS = remoteOutputGuard.DEFAULT_REMOTE_LIMITS;

function isHostGame(gameId) {
  return coreResolver.isHostGame(String(gameId || ''));
}

function createCore(gameId, params, random) {
  return coreResolver.createCore(String(gameId || ''), { params, random });
}

// 核心是否要求通用设备事件：manifest.events === 'v2'。
// 缺省（含两个内置核心与所有既有包）走 legacy 通道，行为与接线前逐字一致。
// 已解析过的包按 id 记住结果：设备数据是热路径，不能每次变化都重扫游戏列表。
function eventsModeForCore(gameId, cache) {
  const id = String(gameId || '');
  if (cache?.has(id)) return cache.get(id);
  let mode = 'legacy';
  try {
    const pkg = coreResolver.resolveGamePackage?.(id);
    if (String(pkg?.manifest?.events || '') === EVENTS_MODE_V2) mode = EVENTS_MODE_V2;
  } catch (_) {
    mode = 'legacy';
  }
  cache?.set(id, mode);
  return mode;
}

function normalizeDeviceMap(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [role, value] of Object.entries(input)) {
    const ids = Array.isArray(value) ? value : (value ? [value] : []);
    out[role] = ids.map((id) => String(id || '').trim()).filter(Boolean);
  }
  return out;
}

// deviceId → role：设备事件按设备反查角色，未映射的设备一律不转发（契约第 3 节）
function roleIndex(deviceMap) {
  const index = new Map();
  for (const [role, ids] of Object.entries(deviceMap || {})) {
    for (const id of ids || []) {
      if (!index.has(id)) index.set(id, role);
    }
  }
  return index;
}

// 只有真正变化的值才转发（防抖：设备周期性重报同一值不产生事件）
function isSameValue(a, b) {
  return Object.is(a, b);
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

class GameHostService {
  constructor({
    devices,
    registry,
    virtualDevices,
    now = () => Date.now(),
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    setRepeating = setInterval,
    clearRepeating = clearInterval,
    tickMs = TICK_MS,
    streamWindowMs = STREAM_WINDOW_MS,
    logger = null,
    outputGuard = null,
    outputLimits = DEFAULT_REMOTE_LIMITS,
    outputLogHook = null,
  } = {}) {
    this.devices = devices || require('../services/deviceService');
    this.registry = registry || require('../devices/registry');
    this.virtualDevices = virtualDevices;
    this.now = now;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.setRepeating = setRepeating;
    this.clearRepeating = clearRepeating;
    this.tickMs = tickMs;
    this.logger = logger;
    // 远程输出安全层：source='remote' 的会话里，核心发出的设备意图与其它远程输出走同一套限幅。
    // 刻意没有「加载失败就放行」的降级分支：这是电击类硬件的最后一道限幅，必须 fail-closed。
    this.outputGuard = outputGuard || remoteOutputGuard;
    this.outputLimits = outputLimits || DEFAULT_REMOTE_LIMITS;
    // 被钳制/被拒绝的意图写进远程会话操作记录（remoteSessionService 注入，可选）
    this.outputLogHook = outputLogHook;
    this.outputWatchdog = this.outputGuard.createOutputWatchdog({
      stopDevice: (deviceId) => this._stopDeviceOutputs(deviceId),
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
    });
    this.session = null;
    this.endedSnapshot = null;
    this.listeners = new Set();
    // 事件模式（manifest.events）按游戏 id 缓存，避免热路径重复解析游戏包
    this.eventsModeCache = new Map();
    // 画面同步流：整份状态文档（/status 的形状）按 rev 增量推送，SSE 与远程 MQTT 共用
    this.stateStream = new GameStateStream({
      windowMs: streamWindowMs,
      now,
      setTimer,
      clearTimer,
    });
    this.devices.onDeviceDataChange?.((event) => this._onDeviceData(event));
    // 设备原始消息（key_clicked 等）→ 核心的 device-event（契约第 3 节）
    this.devices.onDeviceRawMessage?.((event) => this._onDeviceRawMessage(event));
  }

  isHostGame(gameId) {
    return isHostGame(gameId);
  }

  getStatus() {
    const session = this.session;
    if (!session) {
      if (this.endedSnapshot) {
        return {
          active: false,
          running: false,
          ended: true,
          runtimeMode: 'host',
          snapshot: this.endedSnapshot,
        };
      }
      return { active: false, running: false, runtimeMode: null, snapshot: null };
    }
    const snapshot = session.runtime.snapshot();
    return {
      active: !!snapshot.running,
      running: !!snapshot.running,
      runtimeMode: 'host',
      sessionId: session.sessionId,
      gameId: session.gameId,
      deviceMap: session.deviceMap,
      source: session.source,
      snapshot,
      errors: session.errors.slice(),
    };
  }

  start({ gameId, deviceMap, params, source = 'local', agentClientId = null } = {}) {
    if (!isHostGame(gameId)) {
      const error = new Error('该游戏尚未接入 HostRuntime');
      error.code = 'GAME_NOT_HOSTED';
      throw error;
    }
    if (this.session) this.stop({ reason: 'replaced' });
    this.endedSnapshot = null;
    const nowMs = this.now();
    const core = createCore(String(gameId), params, this.random);
    const runtime = new GameCoreRuntime(core);
    const normalized = normalizeDeviceMap(deviceMap);
    const session = {
      sessionId: randomUUID(),
      gameId: String(gameId),
      deviceMap: normalized,
      roles: roleIndex(normalized),
      eventsMode: eventsModeForCore(gameId, this.eventsModeCache),
      source: source || 'local',
      runtime,
      errors: [],
      shockTimers: new Map(),
      // 已转发过的属性值（deviceId\0name → value）：去重用，避免设备周期重报产生重复事件
      propValues: new Map(),
      tickTimer: null,
      // 远程会话：本局是主控端起在跑，核心设备意图必须过远程限幅与锁存看门狗
      remoteOutput: (source || 'local') === 'remote',
      // agent 发起的玩法：本局所有设备意图都按该 agent 租约限幅；租约过期即停局
      agentClientId: typeof agentClientId === 'string' && agentClientId ? agentClientId : null,
    };
    this.session = session;
    const started = core.start(nowMs);
    this._applyResult(session, started, nowMs);
    session.tickTimer = this.setRepeating(() => {
      if (this.session === session) this.tick(this.now());
    }, this.tickMs);
    this._seedSensor(session);
    this._notify();
    this._publishState();
    playCarrierBus.emitPlayCarrierStart({ kind: 'host', gameId: session.gameId, source: session.source });
    return {
      sessionId: session.sessionId,
      gameId: session.gameId,
      deviceMap: session.deviceMap,
      snapshot: runtime.snapshot(),
      runtimeMode: 'host',
    };
  }

  pause() {
    return this._withSession((session, nowMs) => session.runtime.core.pause(nowMs));
  }

  /** agent 用带 X-Agent-Client 的请求操作了用户局：把本局标记为 agent 控制（后续输出都限幅）。 */
  markAgentControl(clientId) {
    const id = typeof clientId === 'string' ? clientId : '';
    if (!id || !this.session || this.session.agentClientId) return false;
    this.session.agentClientId = id;
    return true;
  }

  /** 租约释放/过期：停掉该 agent 发起的 HostRuntime 玩法。 */
  stopAgentPlay(clientId) {
    const session = this.session;
    if (!session || !clientId || session.agentClientId !== clientId) return false;
    this.stop({ reason: 'agent-lease-ended' });
    return true;
  }

  resume() {
    return this._withSession((session, nowMs) => session.runtime.core.resume(nowMs));
  }

  stop({ reason = 'stop' } = {}) {
    const session = this.session;
    if (!session) return { active: false, running: false, runtimeMode: null, snapshot: null };
    const nowMs = this.now();
    const result = session.runtime.core.stop(nowMs, reason);
    this._clearShockTimers(session);
    const hasStopAll = this._applyResult(session, result, nowMs);
    if (!hasStopAll) this._resetMappedDevices(session, reason);
    this._clearRemoteWatchdog(session);
    this._clearTick(session);
    this.endedSnapshot = result.snapshot || session.runtime.snapshot();
    this.session = null;
    this._notify();
    // 结束快照不能等窗口合并：直接发一次全量，订阅者立刻看到 ended
    this.stateStream.reset(this.getStatus());
    playCarrierBus.emitPlayCarrierExit({ kind: 'host', reason, source: session.source });
    return this.getStatus();
  }

  setParams(params) {
    return this._withSession((session) => session.runtime.core.setParams(params));
  }

  action(action, payload) {
    return this._withSession((session, nowMs) => session.runtime.core.action(action, payload || {}, nowMs));
  }

  pushSensor({ role = 'sensor', name = 'sphincterPressure', value, nowMs } = {}) {
    if (!this.session) return this.getStatus();
    this.session.runtime.enqueue({ type: 'sensor', role, name, value });
    return this.tick(Number.isFinite(nowMs) ? nowMs : this.now());
  }

  tick(nowMs = this.now()) {
    const session = this.session;
    if (!session) return this.getStatus();
    const result = session.runtime.tick(nowMs);
    const hasStopAll = this._applyResult(session, result, nowMs);
    if (result.snapshot?.ended) {
      this._clearShockTimers(session);
      if (!hasStopAll) this._resetMappedDevices(session, result.snapshot.endReason || 'ended');
      this._clearRemoteWatchdog(session);
      this._clearTick(session);
      this.endedSnapshot = result.snapshot;
      this.session = null;
      playCarrierBus.emitPlayCarrierExit({ kind: 'host', reason: 'ended', source: session.source });
    }
    this._notify();
    if (!this.session) this.stateStream.reset(this.getStatus());
    else this._publishState();
    return this.getStatus();
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    try { listener(this.getStatus()); } catch (_) {}
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 画面同步：订阅状态文档增量流（SSE 用）。新订阅者先同步收到一份全量。 */
  subscribeState(listener) {
    return this.stateStream.subscribe(listener);
  }

  /**
   * 当前状态文档的 rev 与全量（补全量 / 重连 / SSE 进流首帧用）。
   * 必须先把待发布的变化 flush 掉再取快照：进流首帧是「实时状态 + 已发布 rev」，
   * 若窗口里还压着未发布的变化，首帧就会比 diff 基准新，随后的 patch 会把
   * 变化再叠一遍（日志数组 prepend 会重复、追加类数组会错位）。
   */
  getStateEvent() {
    this.flushState();
    return { rev: this.stateStream.getRev(), state: this.getStatus() };
  }

  /** 立即发布待处理的增量（测试与「有变化就立刻发」的场景用）。 */
  flushState() {
    return this.stateStream.flush();
  }

  shutdown() {
    return this.stop({ reason: 'backend-shutdown' });
  }

  _withSession(fn) {
    if (!this.session) {
      const error = new Error('没有正在运行的游戏');
      error.code = 'NO_SESSION';
      throw error;
    }
    const nowMs = this.now();
    const result = fn(this.session, nowMs);
    this._applyResult(this.session, result, nowMs);
    this._notify();
    this._publishState();
    return this.getStatus();
  }

  _applyResult(session, result, nowMs) {
    if (!result) return false;
    const hasStopAll = (result.effects || []).some((effect) => effect?.type === 'device.stop-all');
    this._executeEffects(session, result.effects || [], nowMs);
    return hasStopAll;
  }

  _executeEffects(session, effects, nowMs) {
    // 玩法标记优先于请求上下文：tick 定时器/设备事件回调里没有 ALS，但执行意图时
    // 用该玩法的 agentClientId 重新包一层，保证写设备调用带上正确来源。
    if (session.agentClientId) {
      agentControl.runWithClient(session.agentClientId, () => {
        this._executeEffectsInner(session, effects, nowMs);
      });
      return;
    }
    this._executeEffectsInner(session, effects, nowMs);
  }

  _executeEffectsInner(session, effects, nowMs) {
    for (const effect of effects) {
      try {
        this._executeEffect(session, effect, nowMs);
      } catch (error) {
        this._recordError(session, error?.message || String(error));
      }
    }
  }

  _executeEffect(session, effect, nowMs) {
    if (!effect || typeof effect.type !== 'string') return;
    // 远程会话：核心设备意图走远程限幅 + 锁存看门狗（与远程手动输出同一套规则）
    if (session.remoteOutput) {
      this._executeRemoteEffect(session, effect, nowMs);
      return;
    }
    if (effect.type === 'device.stop-all') {
      this._resetMappedDevices(session, 'effect-stop-all');
      return;
    }
    const ids = this._roleIds(session, effect.role);
    if (effect.type === 'device.set-strength') {
      this._invokeMapped(session, ids, 'strength', 'set', { value: Math.round(clamp(effect.value, 0, 255)) });
      return;
    }
    if (effect.type === 'device.stop-strength') {
      this._invokeMapped(session, ids, 'strength', 'stop', {});
      return;
    }
    if (effect.type === 'device.shock') {
      const voltage = Math.round(clamp(effect.voltage, 0, 100));
      const durationMs = Math.round(clamp(effect.durationMs, 50, 10000));
      this._invokeMapped(session, ids, 'shock', 'start', { voltage });
      this._scheduleShockStop(session, ids, durationMs, nowMs);
      return;
    }
    if (effect.type === 'device.shock-stop') {
      this._clearShockTimers(session);
      this._invokeMapped(session, ids, 'shock', 'stop', {});
      return;
    }
    if (effect.type === 'device.lock') {
      this._invokeMapped(session, ids, 'lock', 'setOpen', { open: !!effect.open });
      return;
    }
    if (effect.type === 'device.set-report-delay') {
      const ms = Math.round(clamp(effect.ms, 0, 60000));
      this._invokeMapped(session, ids, 'reporting', 'setReportDelay', { ms });
      return;
    }
    this._recordError(session, `忽略未知效果 ${effect.type}`);
  }

  /** 远程会话（source='remote'）的核心意图：先过安全层，再按锁存时长登记看门狗。 */
  _executeRemoteEffect(session, effect, nowMs) {
    if (!this.outputGuard.isKnownHostIntent(effect.type)) {
      this._recordError(session, `忽略未知效果 ${effect.type}`);
      this._reportRemoteOutput(session, 'rejected', {
        deviceId: null,
        effectType: String(effect.type),
        code: 'REMOTE_OUTPUT_REJECTED',
        message: `远程玩法不允许的设备意图: ${effect.type}`,
      });
      return;
    }
    if (effect.type === 'device.stop-all') {
      this._resetMappedDevices(session, 'effect-stop-all');
      return;
    }
    const ids = this._roleIds(session, effect.role);
    this._invokeRemoteMapped(session, ids, effect);
    // 电击的定时停止照旧由会话内的 shockTimer 负责（时长本身未变，只是电压被钳制）
    if (effect.type === 'device.shock') {
      const durationMs = Math.round(clamp(effect.durationMs, 50, 10000));
      this._scheduleShockStop(session, ids, durationMs, nowMs);
    }
    if (effect.type === 'device.shock-stop') this._clearShockTimers(session);
  }

  _scheduleShockStop(session, ids, durationMs) {
    for (const id of ids) {
      const previous = session.shockTimers.get(id);
      if (previous) this.clearTimer(previous);
      const timer = this.setTimer(() => {
        session.shockTimers.delete(id);
        if (!this._deviceUsable(id, 'shock')) return;
        try { this._invoke(id, 'shock', 'stop', {}); } catch (error) {
          this._recordError(session, error?.message || String(error));
        }
      }, durationMs);
      session.shockTimers.set(id, timer);
    }
  }

  _invokeMapped(session, ids, capability, action, input) {
    if (!ids.length) return;
    for (const id of ids) {
      if (!this._deviceUsable(id, capability)) {
        this._recordError(session, `设备 ${id} 无法执行 ${capability}.${action}`);
        continue;
      }
      this._invoke(id, capability, action, input);
    }
  }

  /**
   * 远程会话下的设备意图：与远程手动输出同一套规则（remoteOutputGuard）。
   * 按设备类型/能力逐字段钳制（maid-punishment 的 30V 上限 → 20V）、
   * 未知类型/动作/字段一律拒绝、停止永远放行；锁存输出登记看门狗兜底停机。
   */
  _invokeRemoteMapped(session, ids, effect) {
    if (!ids.length) return;
    for (const id of ids) {
      const device = this.devices.getDeviceById?.(id);
      const sanitized = this.outputGuard.sanitizeHostIntent({
        device,
        effect,
        limits: this.outputLimits,
      });
      if (!sanitized || sanitized.ok === false) {
        const message = sanitized?.message || '设备意图被安全层拒绝';
        this._recordError(session, `远程玩法输出被拒绝（${effect.type} · ${id}）：${message}`);
        this._reportRemoteOutput(session, 'rejected', {
          deviceId: id,
          effectType: effect.type,
          code: sanitized?.code || 'REMOTE_OUTPUT_REJECTED',
          message,
        });
        continue;
      }
      const capability = this.outputGuard.HOST_INTENT_ACTIONS[effect.type].capability;
      const action = this.outputGuard.HOST_INTENT_ACTIONS[effect.type].action;
      if (!this._deviceUsable(id, capability)) {
        this._recordError(session, `设备 ${id} 无法执行 ${capability}.${action}`);
        continue;
      }
      const input = sanitized.input || {};
      const latched = this.outputGuard.isLatchedOutput({ device, capability, action, input });
      const stop = action === 'stop' || !latched?.latched;
      try {
        this._invoke(id, capability, action, input);
      } catch (error) {
        this._recordError(session, error?.message || String(error));
        continue;
      }
      if (stop) this.outputWatchdog.clear(id);
      else this.outputWatchdog.arm(id, latched.maxMs);
      // 只有真的被限幅才写操作记录：正常意图（TD01 每 5 秒递增）不刷屏；
      // 布尔→0/1 的归一化不算限幅，所以按数值比较。
      const requested = {};
      let clamped = false;
      for (const field of Object.keys(this.outputGuard.HOST_INTENT_ACTIONS[effect.type].fields)) {
        requested[field] = effect[field];
        if (Number(requested[field]) !== Number(input[field])) clamped = true;
      }
      if (clamped) {
        this._reportRemoteOutput(session, 'clamped', {
          deviceId: id,
          effectType: effect.type,
          requested,
          applied: input,
        });
      }
    }
  }

  // 被钳制/被拒绝的远程玩法输出：经注入的钩子写进远程会话操作记录（没有钩子就只记本地错误）
  _reportRemoteOutput(session, outcome, detail) {
    if (typeof this.outputLogHook !== 'function') return;
    try {
      this.outputLogHook({ outcome, gameId: session.gameId, ...detail });
    } catch (_) { /* 操作记录失败不影响玩法 */ }
  }

  _deviceUsable(id, capability) {
    const device = this.devices.getDeviceById?.(id);
    if (!device) return false;
    if (this.registry?.hasCapability && !this.registry.hasCapability(device.type, capability)) return false;
    return true;
  }

  _invoke(id, capability, action, input) {
    const virtual = this._virtual();
    if (virtual?.isVirtualDevice?.(id)) {
      virtual.interceptCommand(id, { action: 'invoke', capability, actionName: action, params: input || {} });
      return;
    }
    this.devices.invokeDeviceCapability(id, capability, action, input || {});
  }

  /** 看门狗到点 / 会话结束时的兜底停机（远程锁存输出）。 */
  _stopDeviceOutputs(deviceId) {
    try {
      this.devices.stopExecutionDeviceAndWait?.(deviceId)?.catch?.(() => {});
    } catch (_) { /* 设备可能已离线，忽略 */ }
  }

  _virtual() {
    if (this.virtualDevices) return this.virtualDevices;
    try { return require('../services/virtualDeviceService'); } catch (_) { return null; }
  }

  _roleIds(session, role) {
    if (!role) return [];
    return session.deviceMap[role] || [];
  }

  _resetMappedDevices(session) {
    const ids = new Set();
    for (const list of Object.values(session.deviceMap || {})) {
      for (const id of list || []) ids.add(id);
    }
    for (const id of ids) this._resetDevice(session, id);
  }

  _resetDevice(session, id) {
    const device = this.devices.getDeviceById?.(id);
    if (!device) {
      this._recordError(session, `复位时设备不存在 ${id}`);
      return;
    }
    const type = device.type;
    const has = (capability) => !this.registry?.hasCapability || this.registry.hasCapability(type, capability);
    const duplicate = (capability) => (
      (capability === 'estim' && (type === 'DGLAB' || type === 'YCY_EMS') && has('shock'))
      || (capability === 'motors' && (type === 'YCY_TOY' || type === 'YCY_CUP') && has('strength'))
    );
    for (const capability of STOP_CAPABILITIES) {
      if (!has(capability) || duplicate(capability)) continue;
      try {
        if (capability === 'lock') this._invoke(id, 'lock', 'setOpen', { open: true });
        else if (capability === 'reporting') this._invoke(id, 'reporting', 'setReportDelay', { ms: 5000 });
        else this._invoke(id, capability, 'stop', {});
      } catch (error) {
        this._recordError(session, error?.message || String(error));
      }
    }
  }

  _clearShockTimers(session) {
    for (const timer of session.shockTimers.values()) this.clearTimer(timer);
    session.shockTimers.clear();
  }

  /**
   * 玩法结束：清掉本局登记过的锁存看门狗。
   * 不复用 watchdog.stopAll()——它会对所有登记过的设备补一次停机，
   * 而本局的复位已由核心的 device.stop-all / _resetMappedDevices 按既有边界（只复位本局映射设备）完成。
   */
  _clearRemoteWatchdog(session) {
    if (!session.remoteOutput) return;
    try {
      for (const deviceId of this.outputWatchdog.touched()) this.outputWatchdog.clear(deviceId);
    } catch (_) { /* 看门狗清理失败不影响停局 */ }
  }

  _clearTick(session) {
    if (session.tickTimer) this.clearRepeating(session.tickTimer);
    session.tickTimer = null;
  }

  _recordError(session, message) {
    session.errors.push({ message: String(message), atMs: this.now() });
    if (session.errors.length > 20) session.errors.shift();
    this.logger?.warn?.('GameHost', message);
  }

  _seedSensor(session) {
    if (session.eventsMode === 'v2') {
      // 通用事件：把每个已映射设备的当前属性当作一次初始变化喂给核心，
      // 对齐页面版启动时的 readValue（否则开局前已按住/已有压力会漏判）。
      // 补发的事件带 seed:true：按钮类属性的「已按住」只作为基线，
      // 核心必须等真实变化（oldValue 非 null）才判违规，否则开局就电击（契约第 3 节）。
      const rows = [];
      for (const [deviceId, role] of session.roles) {
        const data = this.devices.getDeviceById?.(deviceId)?.data || {};
        for (const [name, value] of Object.entries(data)) rows.push({ role, deviceId, name, value });
      }
      this._pushDeviceProperties(session, rows, { seed: true });
      return;
    }
    // 内置核心：保持原样，只补发 deviceMap.sensor 的首个气压读数
    for (const id of session.deviceMap.sensor || []) {
      const data = this.devices.getDeviceById?.(id)?.data || {};
      const pressure = data.pressure ?? data.sphincterPressure;
      if (pressure == null || !Number.isFinite(Number(pressure))) continue;
      this.pushSensor({ role: 'sensor', name: 'sphincterPressure', value: Number(pressure) });
      return;
    }
  }

  // 设备属性变化：v2 只转发已映射设备，且只在值真的变化时转发（设备会周期性重报同一份数据）
  _onDeviceData(event) {
    const session = this.session;
    if (!session || !event) return;
    const deviceId = String(event.deviceId || '');
    const changes = event.changes || {};
    if (session.eventsMode === 'v2') {
      const role = session.roles.get(deviceId);
      if (!role) return; // 未映射设备：不转发任何事件
      const rows = [];
      for (const [name, change] of Object.entries(changes)) {
        rows.push({ role, deviceId, name, value: change ? change.new : undefined });
      }
      this._pushDeviceProperties(session, rows);
      return;
    }
    // 内置核心：与改动前完全一致——只看 deviceMap.sensor 里有没有这台设备。
    // 同一台设备同时映射到 sensor 与其他角色时旧行为照样转发，所以这里不能用
    // role 索引（它只保留先声明的那个角色）判断。
    if (!(session.deviceMap.sensor || []).includes(deviceId)) return;
    const pressure = changes.pressure?.new ?? changes.sphincterPressure?.new;
    if (pressure == null || !Number.isFinite(Number(pressure))) return;
    this.pushSensor({ role: 'sensor', name: 'sphincterPressure', value: Number(pressure) });
  }

  // 设备原始消息（锁按键 key_clicked 等）：未映射设备一律不转发
  _onDeviceRawMessage(event) {
    const session = this.session;
    if (!session || !event) return;
    const deviceId = String(event.deviceId || '');
    const role = session.roles.get(deviceId);
    if (!role) return;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') return;
    const name = String(payload.action || payload.method || '');
    if (!name) return;
    if (session.eventsMode !== 'v2') return; // 内置核心只收传感器事件，行为与改动前一致
    if (payload.method === 'action' && name === 'key_clicked') {
      // 契约里的锁按键事件名：核心按 {type:'action', name:'lock-key'} 处理
      session.runtime.enqueue({ type: 'action', name: 'lock-key', role, deviceId });
    } else {
      session.runtime.enqueue({ type: 'device-event', role, deviceId, name, payload: { ...payload } });
    }
    this.tick(this.now());
  }

  // 属性事件只在值变化时入队；整批一次 tick（事件到达即同步 step，不等 80ms 定时器）
  _pushDeviceProperties(session, rows, { seed = false } = {}) {
    let queued = 0;
    for (const row of rows || []) {
      if (!row || row.value === undefined) continue;
      const key = `${row.deviceId}\u0000${row.name}`;
      const had = session.propValues.has(key);
      const previous = session.propValues.get(key);
      if (had && isSameValue(previous, row.value)) continue;
      session.propValues.set(key, row.value);
      session.runtime.enqueue({
        type: 'device-property',
        role: row.role,
        deviceId: String(row.deviceId),
        name: String(row.name),
        value: row.value,
        oldValue: had ? previous : null,
        ...(seed ? { seed: true } : {}),
      });
      queued += 1;
    }
    if (queued) this.tick(this.now());
  }

  _notify() {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      try { listener(status); } catch (_) {}
    }
  }

  // 状态文档进增量流：窗口内合并，无变化时 GameStateStream 不发任何消息
  _publishState() {
    this.stateStream.update(this.getStatus());
  }
}

const gameHostService = new GameHostService();

// 远程游戏服务（被控端）注入：核心设备意图被限幅/被拒绝时写进被控端操作记录
gameHostService.setRemoteOutputLogHook = (hook) => { gameHostService.outputLogHook = hook; };

module.exports = gameHostService;
module.exports.GameHostService = GameHostService;
module.exports.isHostGame = isHostGame;
module.exports.coreResolver = coreResolver;
