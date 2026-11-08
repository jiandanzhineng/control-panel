'use strict';

/**
 * agent 输出限幅（A4）：把 agent 租约里的「能力百分比」换算成逐字段硬上限，
 * 在最终写设备前对 agent 来源的报文做钳制/拒绝。
 *
 * 字段知识复用 remoteOutputGuard（DEVICE_FIELD_SPECS / BRAND_COMMANDS /
 * CAPABILITY_ACTIONS / CHANNEL_SPECS），但换算与拒绝策略独立：
 *   - 输出字段超上限 → 缩放到上限（floor(百分比 × 字段硬上限)）；
 *   - 输出字段不是有限数字 → 拒绝；
 *   - 不认识的设备类型/品牌/命令/字段/通道 → 拒绝；
 *   - 停止/归零指令永远放行。
 */

const remote = require('./remoteOutputGuard');

const AGENT_OUTPUT_REJECTED = 'AGENT_OUTPUT_REJECTED';
const CAPABILITY_KEYS = Object.freeze([
  'strength', 'shock', 'vibration', 'suction', 'estim', 'motors', 'pump',
]);

// 字段硬上限（设备/协议本身的天花板，百分比只会在其内缩放）。
const FIELD_HARD_MAX = Object.freeze({
  voltage: 100,
  power: 255,
  intensity: 100,
  motorLevel: 20,
  stroke: 40,
  rate: 255,
  seconds: 60,
  ticks: 100,
  pump: 255,
});

// 原始报文里拿不到能力语义时，字段种类对应的能力（多个能力取最小百分比，保守）。
const FIELD_CAPABILITIES = Object.freeze({
  voltage: ['shock'],
  power: ['strength'],
  intensity: ['shock', 'vibration', 'suction', 'estim'],
  motorLevel: ['motors'],
  stroke: ['motors'],
  rate: ['pump'],
  seconds: ['pump'],
  ticks: ['shock'],
  pump: ['pump'],
});

const OUTPUT_KINDS = new Set(Object.keys(FIELD_HARD_MAX));
const STOP_METHODS = new Set(['stop', 'stopall', 'motorsstop', 'estimstop', 'pumpstop']);
const NON_OUTPUT_METHODS = new Set(['action', 'ota_update']);

function reject(message) {
  return { ok: false, code: AGENT_OUTPUT_REJECTED, message };
}

function clampInt(raw, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function percentValue(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** 归一化租约 limits：{ default, capabilities }，缺省一律按 0（fail-closed）。 */
function normalizeLimits(input = {}) {
  const defaultPercent = percentValue(input?.default, 0);
  const rawCaps = input?.capabilities && typeof input.capabilities === 'object'
    ? input.capabilities
    : {};
  const capabilities = {};
  for (const key of CAPABILITY_KEYS) {
    capabilities[key] = rawCaps[key] === undefined
      ? defaultPercent
      : percentValue(rawCaps[key], defaultPercent);
  }
  return { default: defaultPercent, capabilities };
}

function effectivePercent(limits, capability) {
  if (!capability) return limits?.default ?? 0;
  const value = limits?.capabilities?.[capability];
  return Number.isFinite(value) ? value : (limits?.default ?? 0);
}

/** 字段种类 + 能力 → 该字段的数值上限（floor）。 */
function fieldCap(kind, limits, capability = null) {
  const hard = FIELD_HARD_MAX[kind];
  if (hard === undefined) return null;
  const names = capability ? [capability] : (FIELD_CAPABILITIES[kind] || []);
  const percent = names.length
    ? Math.min(...names.map((name) => effectivePercent(limits, name)))
    : effectivePercent(limits, null);
  return Math.max(0, Math.floor((percent / 100) * hard));
}

/** 状态/文档用换算表：各能力百分比 + 保守字段上限。 */
function describeLimits(input = {}) {
  const limits = normalizeLimits(input);
  const capabilities = {};
  for (const key of CAPABILITY_KEYS) capabilities[key] = effectivePercent(limits, key);
  const fieldCaps = {};
  for (const kind of Object.keys(FIELD_HARD_MAX)) fieldCaps[kind] = fieldCap(kind, limits);
  return { default: limits.default, capabilities, fieldCaps, normalized: limits };
}

/**
 * 报文里某个字段对应的能力提示；拿不到时返回 null（字段种类默认保守取最小）。
 * intensity 字段无法从报文区分电击/震动/吸吮/多路电击，走保守规则。
 */
function messageFieldCapability(fieldName, kind) {
  if (fieldName === 'voltage') return 'shock';
  if (fieldName === 'power') return 'strength';
  if (fieldName === 'vibration') return 'vibration';
  if (fieldName === 'stroke') return 'motors';
  if (fieldName === 'pump') return 'pump';
  if (kind === 'intensity') return null;
  return null;
}

/** 能力动作参数里某个字段对应的能力提示。 */
function invokeFieldCapability(capability, fieldName, kind) {
  if (kind === 'voltage') return 'shock';
  if (kind === 'power') return 'strength';
  if (kind === 'intensity') {
    return ['shock', 'vibration', 'suction', 'estim'].includes(capability) ? capability : null;
  }
  if (kind === 'motorLevel' || kind === 'stroke') return 'motors';
  if (kind === 'rate' || kind === 'seconds') return 'pump';
  return null;
}

function normalizeNonOutput(kind, raw) {
  switch (kind) {
    case 'switch':
    case 'bool01':
      return raw ? 1 : 0;
    case 'reportDelay':
      return clampInt(raw, 0, remote.MAX_REPORT_DELAY_MS);
    case 'band':
      return clampInt(raw, 0, 999999);
    case 'uint16':
      return clampInt(raw, 0, 65535);
    case 'uint8':
      return clampInt(raw, 0, 255);
    case 'mode':
      return clampInt(raw, 0, 4);
    case 'text':
      return typeof raw === 'string' ? raw.slice(0, 32) : '';
    case 'protocol': {
      const value = String(raw || 'v1').toLowerCase();
      return ['v1', 'v2', 'v3'].includes(value) ? value : null;
    }
    case 'scene': {
      const value = String(raw || 'stop').toLowerCase();
      return ['stop', 'add', 'cut', 'guan'].includes(value) ? value : null;
    }
    case 'channel': {
      const value = String(raw ?? '').trim().toUpperCase();
      if (value === '') return 'A';
      return ['A', 'B', 'AB'].includes(value) ? value : null;
    }
    default:
      return null;
  }
}

/**
 * 归一化一个字段：输出类字段必须是非负有限数字并缩放到上限；
 * 非输出字段按协议范围归一化。返回 { ok, value } 或拒绝对象。
 */
function normalizeField(kind, raw, limits, capability = null, fieldName = '') {
  // YCY_ENEMA 的属性报文把泵值直接写成 pump 字段（协议 0–255）。
  const effectiveKind = fieldName === 'pump' && kind === 'uint8' ? 'pump' : kind;
  if (!OUTPUT_KINDS.has(effectiveKind)) {
    const value = normalizeNonOutput(kind, raw);
    if (value === null) return reject(`agent 输出字段取值非法: ${fieldName || kind}`);
    return { ok: true, value };
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return reject(`agent 输出字段必须是有限数字: ${fieldName || effectiveKind}`);
  }
  const cap = fieldCap(effectiveKind, limits, capability);
  // 郊狼 ticks：-1 表示无限循环，负值统一折算到租约允许的最长时长；非有限值已在上面拒绝。
  if (effectiveKind === 'ticks' && raw < 0) return { ok: true, value: cap };
  return { ok: true, value: Math.min(cap, Math.max(0, Math.round(raw))) };
}

function sanitizeChannels(channels, spec, limits, capability) {
  if (channels === undefined) return { ok: true, value: {} };
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
    return reject('agent 输出通道格式非法: channels');
  }
  const out = {};
  for (const [name, raw] of Object.entries(channels)) {
    const kind = remote.ownField(spec, name);
    if (!kind) return reject(`agent 输出不允许的通道: ${name}`);
    const source = raw && typeof raw === 'object' ? raw : { value: raw };
    const value = normalizeField(kind, source.value, limits, capability || 'motors', name);
    if (!value.ok) return value;
    out[name] = { value: value.value };
    if (source.direction !== undefined) {
      out[name].direction = clampInt(source.direction, -1, 1);
    }
  }
  return { ok: true, value: out };
}

function sanitizeDeviceUpdate(type, message, limits) {
  const spec = {
    ...remote.COMMON_FIELD_SPECS,
    ...(remote.ownField(remote.DEVICE_FIELD_SPECS, type) || {}),
  };
  const out = { method: 'update' };
  for (const [key, raw] of Object.entries(message)) {
    if (key === 'method') continue;
    // 改名不是输出，agent 仍可用；长度与用户路径保持一致。
    if (key === 'name' || key === 'nickname') {
      out[key] = String(raw ?? '').slice(0, 64);
      continue;
    }
    const kind = remote.ownField(spec, key);
    if (!kind) return reject(`agent 输出不允许的字段: ${key}`);
    const capability = messageFieldCapability(key, kind);
    const value = normalizeField(kind, raw, limits, capability, key);
    if (!value.ok) return value;
    out[key] = value.value;
  }
  return { ok: true, message: out };
}

function sanitizeBrandMessage(type, message, limits) {
  const brand = String(message.brand || '');
  const specs = remote.ownField(remote.BRAND_COMMANDS, brand);
  if (!specs) return reject(`agent 输出不允许的品牌协议: ${brand || '(空)'}`);
  const cmd = String(message.cmd || '');
  const spec = remote.ownField(specs, cmd);
  if (!spec) return reject(`agent 输出不允许的品牌命令: ${brand}.${cmd || '(空)'}`);
  const out = { brand, cmd };
  // 停止永远放行：即使设备能力表与命令的能力映射不完全一致（如 YCY_EMS 的 stopAll）。
  if (spec.stop) return { ok: true, message: out };
  if (spec.sceneStop && String(message.scene || '').toLowerCase() === 'stop') {
    return {
      ok: true,
      message: { ...out, protocol: normalizeNonOutput('protocol', message.protocol) || 'v1', scene: 'stop' },
    };
  }
  const capability = remote.ownField(remote.ownField(remote.BRAND_COMMAND_CAPABILITY, brand), cmd);
  if (capability && !remote.ownField(remote.DEVICE_CAPABILITIES, type)?.includes(capability)) {
    return reject(`设备 ${type} 不支持品牌命令: ${brand}.${cmd}`);
  }
  if (spec.channels) {
    const channels = sanitizeChannels(
      message.channels,
      remote.ownField(remote.CHANNEL_SPECS, type) || {},
      limits,
      capability || 'motors',
    );
    if (!channels.ok) return channels;
    return { ok: true, message: { ...out, channels: channels.value } };
  }
  const fields = {};
  for (const [key, raw] of Object.entries(message)) {
    // method 只是报文外壳（虚拟设备 writeProps 会补 method:'update'），不是协议字段。
    if (key === 'brand' || key === 'cmd' || key === 'method') continue;
    const kind = remote.ownField(spec.fields || {}, key);
    if (!kind) return reject(`agent 输出不允许的品牌字段: ${key}`);
    const value = normalizeField(kind, raw, limits, capability, key);
    if (!value.ok) return value;
    fields[key] = value.value;
  }
  if (cmd === 'pump') {
    // 省略 ss 时固件默认 60s：先按租约把默认值压到允许时长，避免绕过。
    if (fields.ss === undefined) fields.ss = Math.min(60, fieldCap('seconds', limits, 'pump'));
    if (fields.scene === undefined) fields.scene = 'guan';
  }
  return { ok: true, message: { ...out, ...fields } };
}

function sanitizeGenericMethod(type, message, limits) {
  const method = String(message.method || '').toLowerCase();
  if (STOP_METHODS.has(method)) return { ok: true, message: { method } };
  if (method === 'motors') {
    const channels = sanitizeChannels(
      message.channels,
      remote.ownField(remote.CHANNEL_SPECS, type) || {},
      limits,
      'motors',
    );
    if (!channels.ok) return channels;
    return { ok: true, message: { method: 'motors', channels: channels.value } };
  }
  if (method === 'estim') {
    const out = { method: 'estim' };
    const allowed = { channel: 'channel', intensity: 'intensity', wave: 'text' };
    for (const [key, raw] of Object.entries(message)) {
      if (key === 'method') continue;
      const kind = remote.ownField(allowed, key);
      if (!kind) return reject(`agent 输出不允许的字段: ${key}`);
      const value = normalizeField(kind, raw, limits, 'estim', key);
      if (!value.ok) return value;
      out[key] = value.value;
    }
    return { ok: true, message: out };
  }
  if (method === 'pump') {
    if (String(message.scene || '').toLowerCase() === 'stop') {
      return { ok: true, message: { method: 'pump', protocol: 'v1', scene: 'stop' } };
    }
    const out = { method: 'pump', protocol: 'v1', scene: 'guan' };
    const allowed = { protocol: 'protocol', scene: 'scene', rate: 'rate', ss: 'seconds' };
    for (const [key, raw] of Object.entries(message)) {
      if (key === 'method') continue;
      const kind = remote.ownField(allowed, key);
      if (!kind) return reject(`agent 输出不允许的字段: ${key}`);
      const value = normalizeField(kind, raw, limits, kind === 'rate' || kind === 'seconds' ? 'pump' : null, key);
      if (!value.ok) return value;
      out[key] = value.value;
    }
    if (out.ss === undefined) out.ss = Math.min(60, fieldCap('seconds', limits, 'pump'));
    return { ok: true, message: out };
  }
  if (method === 'action') {
    return { ok: true, message: { method: 'action', action: String(message.action || '') } };
  }
  if (method === 'ota_update') {
    return { ok: true, message: { method: 'ota_update', url: String(message.url || '') } };
  }
  return reject(`agent 输出不允许的设备报文 method: ${method || '(空)'}`);
}

/** 校验 + 钳制一条最终设备报文（能力动作、预置操作、message、bridge 写入都汇聚到这里）。 */
function sanitizeDeviceMessage({ device, message, limits } = {}) {
  const type = remote.deviceType(device);
  if (!remote.ownField(remote.DEVICE_CAPABILITIES, type)) {
    return reject(`未知设备类型: ${type || '(空)'}`);
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return reject('agent 设备报文格式无效');
  }
  const normalized = normalizeLimits(limits);
  if (typeof message.brand === 'string' && message.brand) {
    return sanitizeBrandMessage(type, message, normalized);
  }
  const method = message.method === undefined ? 'update' : String(message.method);
  if (method === 'update') return sanitizeDeviceUpdate(type, message, normalized);
  return sanitizeGenericMethod(type, message, normalized);
}

/** 校验 + 钳制一次能力动作参数（虚拟设备的 invoke 走这里，真实设备会再走报文层）。 */
function sanitizeCapabilityInvoke({ device, capability, action, input, limits } = {}) {
  const type = remote.deviceType(device);
  const capabilities = remote.ownField(remote.DEVICE_CAPABILITIES, type);
  if (!capabilities) return reject(`未知设备类型: ${type || '(空)'}`);
  const capabilityKey = String(capability || '');
  if (!capabilities.includes(capabilityKey)) {
    return reject(`设备 ${type} 不支持能力: ${capabilityKey}`);
  }
  const actionKey = String(action || '');
  const spec = remote.ownField(remote.CAPABILITY_ACTIONS[capabilityKey], actionKey);
  if (!spec) return reject(`设备 ${type} 不支持动作: ${capabilityKey}.${actionKey}`);
  if (spec.stop || remote.STOP_ACTIONS.has(actionKey.toLowerCase())) {
    return { ok: true, input: {} };
  }
  const normalized = normalizeLimits(limits);
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (spec.channels) {
    const channels = sanitizeChannels(
      raw.channels,
      remote.ownField(remote.CHANNEL_SPECS, type) || {},
      normalized,
      'motors',
    );
    if (!channels.ok) return channels;
    return { ok: true, input: { channels: channels.value } };
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const kind = remote.ownField(spec.fields || {}, key);
    if (!kind) return reject(`agent 输出不允许的字段: ${key}`);
    const hint = invokeFieldCapability(capabilityKey, key, kind);
    const normalizedValue = normalizeField(kind, value, normalized, hint, key);
    if (!normalizedValue.ok) return normalizedValue;
    out[key] = normalizedValue.value;
  }
  return { ok: true, input: out };
}

/** 是否停止指令（停止永远放行，即使租约已过期）。 */
function isStopMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  if (typeof message.brand === 'string' && message.brand) {
    const spec = remote.ownField(
      remote.ownField(remote.BRAND_COMMANDS, message.brand),
      String(message.cmd || ''),
    );
    if (!spec) return false;
    if (spec.stop) return true;
    return !!spec.sceneStop && String(message.scene || '').toLowerCase() === 'stop';
  }
  const method = String(message.method || '').toLowerCase();
  if (STOP_METHODS.has(method)) return true;
  return method === 'pump' && String(message.scene || '').toLowerCase() === 'stop';
}

/** 只把输出字段归零的写入也视为停止类（租约过期后仍允许收尾）。 */
function isZeroOutputMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  if (typeof message.brand === 'string' && message.brand) return false;
  const method = String(message.method || 'update').toLowerCase();
  if (method !== 'update') return false;
  let hasOutput = false;
  for (const [key, value] of Object.entries(message)) {
    if (key === 'method' || key === 'name' || key === 'nickname') continue;
    if (!['voltage', 'power', 'intensity', 'vibration', 'suction', 'stroke', 'pump'].includes(key)) continue;
    hasOutput = true;
    if (Number(value) !== 0) return false;
  }
  return hasOutput;
}

module.exports = {
  AGENT_OUTPUT_REJECTED,
  CAPABILITY_KEYS,
  FIELD_HARD_MAX,
  FIELD_CAPABILITIES,
  normalizeLimits,
  describeLimits,
  fieldCap,
  effectivePercent,
  sanitizeDeviceMessage,
  sanitizeCapabilityInvoke,
  isStopMessage,
  isZeroOutputMessage,
};
