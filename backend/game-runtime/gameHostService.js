const { randomUUID } = require('crypto');
const { SurgeEdgingCore, GAME_ID } = require('./cores/surge-edging-core');
const { GameCoreRuntime } = require('./gameCoreRuntime');

const HOST_GAMES = new Set([GAME_ID]);
const TICK_MS = 80;
const STOP_CAPABILITIES = ['shock', 'strength', 'motors', 'estim', 'pump', 'lock', 'reporting'];

function isHostGame(gameId) {
  return HOST_GAMES.has(String(gameId || ''));
}

function createCore(gameId, params, random) {
  if (gameId === GAME_ID) return new SurgeEdgingCore({ params, random });
  const error = new Error('该游戏尚未接入 HostRuntime');
  error.code = 'GAME_NOT_HOSTED';
  throw error;
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
    logger = null,
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
    this.session = null;
    this.endedSnapshot = null;
    this.listeners = new Set();
    this.devices.onDeviceDataChange?.((event) => this._onDeviceData(event));
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

  start({ gameId, deviceMap, params, source = 'local' } = {}) {
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
    const session = {
      sessionId: randomUUID(),
      gameId: String(gameId),
      deviceMap: normalizeDeviceMap(deviceMap),
      source: source || 'local',
      runtime,
      errors: [],
      shockTimers: new Map(),
      tickTimer: null,
    };
    this.session = session;
    const started = core.start(nowMs);
    this._applyResult(session, started, nowMs);
    session.tickTimer = this.setRepeating(() => {
      if (this.session === session) this.tick(this.now());
    }, this.tickMs);
    this._notify();
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

  resume() {
    return this._withSession((session, nowMs) => session.runtime.core.resume(nowMs));
  }

  stop({ reason = 'stop' } = {}) {
    const session = this.session;
    if (!session) return { active: false, running: false, runtimeMode: null, snapshot: null };
    const nowMs = this.now();
    const result = session.runtime.core.stop(nowMs, reason);
    this._clearShockTimers(session);
    this._resetMappedDevices(session, reason);
    this._applyResult(session, result, nowMs);
    this._clearTick(session);
    this.endedSnapshot = result.snapshot || session.runtime.snapshot();
    this.session = null;
    this._notify();
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
    this._applyResult(session, result, nowMs);
    if (result.snapshot?.ended) {
      this._clearShockTimers(session);
      this._resetMappedDevices(session, result.snapshot.endReason || 'ended');
      this._clearTick(session);
      this.endedSnapshot = result.snapshot;
      this.session = null;
    }
    this._notify();
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
    return this.getStatus();
  }

  _applyResult(session, result, nowMs) {
    if (!result) return;
    this._executeEffects(session, result.effects || [], nowMs);
  }

  _executeEffects(session, effects, nowMs) {
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

  _clearTick(session) {
    if (session.tickTimer) this.clearRepeating(session.tickTimer);
    session.tickTimer = null;
  }

  _recordError(session, message) {
    session.errors.push({ message: String(message), atMs: this.now() });
    if (session.errors.length > 20) session.errors.shift();
    this.logger?.warn?.('GameHost', message);
  }

  _onDeviceData(event) {
    const session = this.session;
    if (!session || !event) return;
    const sensorIds = new Set(session.deviceMap.sensor || []);
    if (!sensorIds.has(event.deviceId)) return;
    const pressure = event.changes?.pressure?.new
      ?? event.changes?.sphincterPressure?.new
      ?? event.nextData?.pressure;
    if (pressure == null || !Number.isFinite(Number(pressure))) return;
    this.pushSensor({ role: 'sensor', name: 'sphincterPressure', value: Number(pressure) });
  }

  _notify() {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      try { listener(status); } catch (_) {}
    }
  }
}

const gameHostService = new GameHostService();

module.exports = gameHostService;
module.exports.GameHostService = GameHostService;
module.exports.isHostGame = isHostGame;
