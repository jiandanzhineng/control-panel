/** 品牌能力参数换算：对外 0–255 / shock 电压 0–100，对内设备量程。 */

function clampInt(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function scale255(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((clampInt(n, 0, 255) / 255) * max);
}

function parseMotorChannel(spec) {
  if (spec == null) return null;
  if (typeof spec === 'number') return { value: spec, direction: 1 };
  const dir = spec.direction === -1 || spec.direction === '-' ? -1 : 1;
  return { value: Number(spec.value) || 0, direction: dir };
}

/** 杯旋转：0–255 + 方向 → 设备 0 / 1–20 正 / 21–40 反。 */
function toFjbStroke(spec) {
  const ch = parseMotorChannel(spec);
  if (!ch) return null;
  const speed = scale255(ch.value, 20);
  if (speed <= 0) return 0;
  return ch.direction < 0 ? speed + 20 : speed;
}

function toLevel255(spec, max) {
  const ch = parseMotorChannel(spec);
  if (!ch) return null;
  return scale255(ch.value, max);
}

function mergeFjbState(prev, channels = {}) {
  const next = { stroke: prev?.stroke || 0, vibe: prev?.vibe || 0, axis: prev?.axis || 0 };
  if (channels.stroke != null) next.stroke = toFjbStroke(channels.stroke);
  if (channels.vibe != null) next.vibe = toLevel255(channels.vibe, 20);
  if (channels.axis != null) next.axis = toLevel255(channels.axis, 20);
  return next;
}

function createYcyNormState() {
  return { fjb: { stroke: 0, vibe: 0, axis: 0 }, ems: { A: 0, B: 0 } };
}

function normalizeYcyCommand(state, brandCommand, mode) {
  const c = brandCommand || {};
  if (c.cmd === 'setMotors') {
    const ch = c.channels || {};
    if (ch.a != null && ch.stroke == null) {
      return { ...c, cmd: 'setSpeed', speed: toLevel255(ch.a, 20) || 0 };
    }
    state.fjb = mergeFjbState(state.fjb, ch);
    return { brand: 'ycy', cmd: 'setFjb', ...state.fjb };
  }
  if (c.cmd === 'setFjb') {
    state.fjb = {
      stroke: c.stroke != null ? c.stroke : state.fjb.stroke,
      vibe: c.vibe != null ? c.vibe : state.fjb.vibe,
      axis: c.axis != null ? c.axis : state.fjb.axis,
    };
    return { ...c, cmd: 'setFjb', ...state.fjb };
  }
  if (c.cmd === 'stopFjb' || c.cmd === 'stopToy' || c.cmd === 'stopAll') {
    state.fjb = { stroke: 0, vibe: 0, axis: 0 };
    if (c.cmd === 'stopAll') state.ems = { A: 0, B: 0 };
    if (mode === 'bridge' && c.cmd !== 'stopAll') return { brand: 'ycy', cmd: 'stopAll' };
  }
  if (c.cmd === 'setStrength') {
    const channel = String(c.channel || 'A').toUpperCase();
    const value = Number(c.value) || 0;
    if (channel === 'AB') state.ems = { A: value, B: value };
    else if (channel === 'A' || channel === 'B') state.ems[channel] = value;
    return c;
  }
  if (c.cmd === 'setEstim') {
    const channel = String(c.channel || 'A').toUpperCase();
    const value = Math.round((clampInt(c.intensity, 0, 255) / 255) * 100);
    if (channel === 'AB') state.ems = { A: value, B: value };
    else if (channel === 'A' || channel === 'B') state.ems[channel] = value;
    return { brand: 'ycy', cmd: 'setStrength', channel: c.channel || 'A', value, wave: c.wave };
  }
  if (c.cmd === 'setMode') {
    const channel = String(c.channel || 'A').toUpperCase();
    return {
      ...c, cmd: 'setStrength', channel,
      value: channel === 'AB' ? state.ems.A : (state.ems[channel] ?? 0),
      wave: c.mode,
    };
  }
  if (mode === 'bridge' && c.cmd === 'pump' && c.scene === 'stop') {
    return { brand: 'ycy', cmd: 'stopAll' };
  }
  return c;
}

module.exports = {
  clampInt,
  scale255,
  parseMotorChannel,
  toFjbStroke,
  toLevel255,
  mergeFjbState,
  createYcyNormState,
  normalizeYcyCommand,
};
