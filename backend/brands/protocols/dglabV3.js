/**
 * DG-LAB Coyote 3.0（郊狼 3.0）蓝牙协议。
 * 广播名 47L121000；GATT 180C/150A 写、150B 通知。B0 20 字节 / 100ms。
 */
const SIG = '0000xxxx-0000-1000-8000-00805f9b34fb';
function sig(short) {
  return SIG.replace('xxxx', String(short).toLowerCase());
}

const V3_UUIDS = Object.freeze({
  service: sig('180c'),
  write: sig('150a'),
  notify: sig('150b'),
  battery: sig('1500'),
});

const DGLAB_V3_NAMES = ['47L'];
const STRENGTH_HW_MAX = 200;
const B0_INTERVAL_MS = 100;
const INTERPRET = Object.freeze({ none: 0, inc: 1, dec: 2, abs: 3 });
const DEFAULT_WAVE = Object.freeze({
  freq: [20, 20, 20, 20],
  intensity: [50, 50, 50, 50],
});
const SILENT_WAVE = Object.freeze({
  freq: [10, 10, 10, 10],
  intensity: [0, 0, 0, 101],
});

function clampInt(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function isV3Name(name) {
  return /47L/i.test(String(name || ''));
}

function shortUuid(u) {
  const s = String(u || '').toLowerCase().replace(/-/g, '');
  if (s.length === 4) return s;
  if (s.startsWith('0000') && s.length >= 8) return s.slice(4, 8);
  if (s.length === 32 && s.endsWith('00001000800000805f9b34fb')) return s.slice(4, 8);
  return s;
}

function isV3WriteUuid(uuid) {
  return shortUuid(uuid) === '150a';
}

function uiToHwStrength(uiValue, uiMax = 100, hwMax = STRENGTH_HW_MAX) {
  const n = Number(uiValue);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(0, Math.min(uiMax, n)) / uiMax * hwMax);
}

function packBf({
  aLimit = STRENGTH_HW_MAX,
  bLimit = STRENGTH_HW_MAX,
  freqBalA = 128,
  freqBalB = 128,
  intenBalA = 128,
  intenBalB = 128,
} = {}) {
  return [
    0xBF,
    clampInt(aLimit, 0, STRENGTH_HW_MAX),
    clampInt(bLimit, 0, STRENGTH_HW_MAX),
    clampInt(freqBalA, 0, 255),
    clampInt(freqBalB, 0, 255),
    clampInt(intenBalA, 0, 255),
    clampInt(intenBalB, 0, 255),
  ];
}

function four(list, fill) {
  const out = [fill, fill, fill, fill];
  if (!Array.isArray(list)) return out;
  for (let i = 0; i < 4; i += 1) {
    if (list[i] != null) out[i] = clampInt(list[i], 0, 255);
  }
  return out;
}

function packB0({
  seq = 0,
  interpretA = INTERPRET.abs,
  interpretB = INTERPRET.abs,
  a = 0,
  b = 0,
  waveA = DEFAULT_WAVE,
  waveB = DEFAULT_WAVE,
} = {}) {
  const interpret = ((interpretA & 3) << 2) | (interpretB & 3);
  const head = ((seq & 0x0f) << 4) | (interpret & 0x0f);
  const sa = clampInt(a, 0, STRENGTH_HW_MAX);
  const sb = clampInt(b, 0, STRENGTH_HW_MAX);
  return [
    0xB0,
    head,
    sa > STRENGTH_HW_MAX ? 0 : sa,
    sb > STRENGTH_HW_MAX ? 0 : sb,
    ...four(waveA?.freq, 20),
    ...four(waveA?.intensity, 0),
    ...four(waveB?.freq, 20),
    ...four(waveB?.intensity, 0),
  ];
}

function wavesFor({ a = 0, b = 0 } = {}) {
  return {
    waveA: a > 0 ? DEFAULT_WAVE : SILENT_WAVE,
    waveB: b > 0 ? DEFAULT_WAVE : SILENT_WAVE,
  };
}

function nextB0(state = {}) {
  const a = clampInt(state.a, 0, STRENGTH_HW_MAX);
  const b = clampInt(state.b, 0, STRENGTH_HW_MAX);
  const { waveA, waveB } = wavesFor({ a, b });
  return packB0({
    seq: 0,
    interpretA: INTERPRET.abs,
    interpretB: INTERPRET.abs,
    a,
    b,
    waveA,
    waveB,
  });
}

function applyCommand(state, brandCommand) {
  const prev = { a: state?.a || 0, b: state?.b || 0 };
  const c = brandCommand || {};
  if (c.cmd === 'stopPattern' || c.cmd === 'v2_stop') return { a: 0, b: 0 };
  if (c.cmd === 'setPattern') {
    const hw = uiToHwStrength(Number(c.intensity) || 0, 100);
    return { a: hw, b: hw };
  }
  if (c.cmd === 'setEstim') {
    const hw = uiToHwStrength(Number(c.intensity) || 0, 255);
    const ch = String(c.channel || 'ab').toLowerCase();
    if (ch === 'a') return { a: hw, b: prev.b };
    if (ch === 'b') return { a: prev.a, b: hw };
    return { a: hw, b: hw };
  }
  return prev;
}

module.exports = {
  V3_UUIDS,
  DGLAB_V3_NAMES,
  STRENGTH_HW_MAX,
  B0_INTERVAL_MS,
  INTERPRET,
  DEFAULT_WAVE,
  SILENT_WAVE,
  isV3Name,
  isV3WriteUuid,
  shortUuid,
  uiToHwStrength,
  packBf,
  packB0,
  wavesFor,
  nextB0,
  applyCommand,
};
