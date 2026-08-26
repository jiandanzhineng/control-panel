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

module.exports = {
  clampInt,
  scale255,
  parseMotorChannel,
  toFjbStroke,
  toLevel255,
  mergeFjbState,
};
