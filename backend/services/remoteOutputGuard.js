'use strict';

/**
 * 远程输出安全层（审查报告 docs/remote-control-audit-2026-09-30.md §2.1/§2.2/§3.3/§5.2）。
 *
 * 两条远控链路（设备投影 projection.write、远程游戏 devices.invoke）都从这里过：
 *   1. 按设备类型 + 能力逐字段钳制，覆盖品牌协议字段（DGLAB intensity/ticks、
 *      YCY value/intensity、DIANJI/SOSEXY voltage、TD01 等 power）；
 *   2. 不认识的设备类型 / 能力 / 动作 / 字段一律拒绝，绝不透传；
 *   3. 标记锁存输出（电击类 10s、电机/泵类 60s），交给 watchdog 兜底停机；
 *   4. 停止指令永远放行（未知多余字段在停止路径上被丢弃而不是拒绝）。
 *
 * 设计约束：只做「校验 + 钳制 + 渲染」，不碰设备连接；调用方负责真正下发。
 */

const REMOTE_OUTPUT_REJECTED = 'REMOTE_OUTPUT_REJECTED';

// 持有方设置的上限默认值。intensity 是品牌协议 0–100 刻度（郊狼强度、SOSEXY 微电流等）。
const DEFAULT_REMOTE_LIMITS = Object.freeze({ voltage: 20, power: 128, intensity: 50 });

// 硬上限：持有方把 limits 调多大都不许越过设备/协议本身的物理边界。
const HARD_LIMITS = Object.freeze({ voltage: 100, power: 255, intensity: 100 });

// 锁存输出最长时长：电刺激 10s，电机/震动/泵等持续输出 60s。
const ELECTRIC_LATCH_MS = 10000;
const MOTOR_LATCH_MS = 60000;

const MAX_DGLAB_TICKS = 100;   // 郊狼 ticks 单位 0.1s → 10s
const MAX_PUMP_SECONDS = 60;   // 灌肠泵单次时长（秒）
const MAX_MOTOR_LEVEL = 20;    // YCY 电机协议 0–20
const MAX_CUP_STROKE = 40;     // YCY 杯行程 0–40
const MAX_REPORT_DELAY_MS = 99999;
const MAX_TEXT_LEN = 32;

const STOP_ACTIONS = new Set(['stop', 'stopall', 'off', 'halt']);

// 停机/归零时要清零的「输出类」字段（锁、上报频率、显示参数不在内）。
const STOP_ZERO_FIELDS = Object.freeze([
  'voltage', 'shock', 'power', 'intensity', 'vibration', 'suction', 'stroke', 'pump',
]);

function reject(message) {
  return { ok: false, code: REMOTE_OUTPUT_REJECTED, message };
}

// 报文/参数是操作方给的 JSON：键名可能是 '__proto__'/'constructor'/'toString' 这类
// 原型链上的名字（Object.entries 会枚举出来），必须只看自有属性，否则会取到原型上的
// 函数并当成字段规格调用（TypeError）。取不到规格一律拒绝。
function ownField(spec, key) {
  if (!spec || !Object.prototype.hasOwnProperty.call(spec, key)) return undefined;
  return spec[key];
}

function clampNumber(raw, max, min = 0, fallback = 0) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 归一化持有方上限；缺省补 DEFAULT_REMOTE_LIMITS，并夹到硬上限内。 */
function normalizeLimits(input = {}) {
  const pick = (key) => {
    const raw = Number(input?.[key]);
    if (!Number.isFinite(raw)) return DEFAULT_REMOTE_LIMITS[key];
    return Math.min(HARD_LIMITS[key], Math.max(0, Math.round(raw)));
  };
  return { voltage: pick('voltage'), power: pick('power'), intensity: pick('intensity') };
}

/**
 * 电刺激的 0–100 刻度上限：取 voltage 与 intensity 中更小的那个。
 * voltage 是持有方设的「电压上限」，intensity 是品牌刻度上限，两者都要遵守。
 */
function electricCap(limits) {
  return Math.min(limits.voltage, limits.intensity);
}

function deviceType(device) {
  const type = device?.type || device?.deviceType;
  return typeof type === 'string' && type ? type : '';
}

// ============ 字段规格 ============
// kind → 归一化函数（raw, limits）→ 数值/字符串
const FIELD_KINDS = {
  voltage: (raw, limits) => clampNumber(raw, electricCap(limits), 0),
  power: (raw, limits) => clampNumber(raw, Math.min(HARD_LIMITS.power, limits.power), 0),
  intensity: (raw, limits) => clampNumber(raw, Math.min(HARD_LIMITS.intensity, limits.intensity), 0),
  switch: (raw) => (raw ? 1 : 0),
  bool01: (raw) => (raw ? 1 : 0),
  reportDelay: (raw) => clampNumber(raw, MAX_REPORT_DELAY_MS, 0),
  band: (raw) => clampNumber(raw, 999999, 0),
  uint16: (raw) => clampNumber(raw, 65535, 0),
  uint8: (raw) => clampNumber(raw, 255, 0),
  mode: (raw) => clampNumber(raw, 4, 0),
  text: (raw) => (typeof raw === 'string' ? raw.slice(0, MAX_TEXT_LEN) : ''),
  motorLevel: (raw) => clampNumber(raw, MAX_MOTOR_LEVEL, 0),
  stroke: (raw) => clampNumber(raw, MAX_CUP_STROKE, 0),
  rate: (raw) => clampNumber(raw, 255, 1),
  seconds: (raw) => clampNumber(raw, MAX_PUMP_SECONDS, 0),
  protocol: (raw) => {
    const value = String(raw || 'v1').toLowerCase();
    return ['v1', 'v2', 'v3'].includes(value) ? value : null;
  },
  scene: (raw) => {
    const value = String(raw || 'stop').toLowerCase();
    return ['stop', 'add', 'cut', 'guan'].includes(value) ? value : null;
  },
  channel: (raw) => {
    const value = String(raw ?? '').trim().toUpperCase();
    if (value === '' ) return 'A';
    return ['A', 'B', 'AB'].includes(value) ? value : null;
  },
  // 郊狼 ticks：0.1s 一个 tick，0 = 播放一遍，-1 = 无限循环。
  // 负值/非有限值（审查报告 §2.1 附录 B-1 的 ticks:-1 复现）一律折算成最长锁存时长。
  ticks: (raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return MAX_DGLAB_TICKS;
    return Math.min(MAX_DGLAB_TICKS, Math.round(value));
  },
};

// 设备属性报文（method 缺省或 'update'）允许写的字段 → 字段种类。
// 传感器/只读字段（battery/pressure/quat/distance/button*）与固件调参（game_*）
// 一律不在表内：远程写入不碰它们。
const DEVICE_FIELD_SPECS = {
  PJ01: { power: 'power' },
  TD01: { power: 'power' },
  OSR6: { power: 'power' },
  DIANJI: { voltage: 'voltage', shock: 'switch', delay: 'uint16', safe: 'bool01' },
  ZIDONGSUO: { open: 'bool01' },
  CUNZHI01: { power: 'power', voltage: 'voltage', shock: 'switch', delay: 'uint16', safe: 'bool01' },
  QIYA: { report_delay_ms: 'reportDelay' },
  QTZ: { low_band: 'band', high_band: 'band', report_delay_ms: 'reportDelay' },
  DZC01: { display_mode: 'uint8', display_on: 'bool01', display_contrast: 'uint8' },
  DGLAB: { voltage: 'voltage', shock: 'switch', intensity: 'intensity', power: 'power' },
  YCY_EMS: { voltage: 'voltage', shock: 'switch', intensity: 'intensity', power: 'power' },
  YCY_TOY: { power: 'power' },
  YCY_CUP: { power: 'power', stroke: 'stroke', vibration: 'intensity' },
  YCY_ENEMA: { pump: 'uint8' },
  SOSEXY_PID0004: {
    power: 'power', voltage: 'voltage', shock: 'switch',
    vibration: 'intensity', suction: 'intensity',
  },
  GXP_XA9935: { power: 'power', vibration: 'intensity' },
  // 心率带是纯上行传感器：心率/电量等字段都不在表内，远程写不碰。
  HRM: {},
};

// 所有设备类型都允许的通用字段（上报频率，纯采样参数，无输出风险）。
const COMMON_FIELD_SPECS = { report_delay_ms: 'reportDelay' };

// 多路电机通道（motors.set）的通道上限按设备类型区分。
const CHANNEL_SPECS = {
  YCY_TOY: { a: 'motorLevel', b: 'motorLevel', c: 'motorLevel' },
  YCY_CUP: { stroke: 'stroke', vibe: 'motorLevel', axis: 'motorLevel' },
};

// 能力动作规格：fields = 允许的 input 字段 → 字段种类；latch = 锁存时长类别。
const CAPABILITY_ACTIONS = {
  shock: {
    start: { latch: 'electric', fields: { voltage: 'voltage', mode: 'mode' } },
    stop: { stop: true },
  },
  strength: {
    set: { latch: 'motor', fields: { value: 'power' } },
    stop: { stop: true },
  },
  vibration: {
    set: { latch: 'motor', fields: { value: 'intensity', mode: 'mode' } },
    stop: { stop: true },
  },
  suction: {
    set: { latch: 'motor', fields: { value: 'intensity', mode: 'mode' } },
    stop: { stop: true },
  },
  lock: {
    setOpen: { fields: { open: 'bool01' } },
  },
  reporting: {
    setReportDelay: { fields: { ms: 'reportDelay' } },
  },
  distance: {
    configure: { fields: { lowBand: 'band', highBand: 'band', reportDelayMs: 'reportDelay' } },
  },
  motors: {
    set: { latch: 'motor', channels: true },
    stop: { stop: true },
  },
  estim: {
    set: { latch: 'electric', fields: { channel: 'channel', intensity: 'intensity', wave: 'text' } },
    stop: { stop: true },
  },
  pump: {
    start: { latch: 'motor', fields: { protocol: 'protocol', scene: 'scene', rate: 'rate', ss: 'seconds' } },
    stop: { stop: true },
  },
  attitude: {
    startMagCalibration: { fields: {} },
    endMagCalibration: { fields: {} },
  },
};

// 设备类型 → 支持的能力（与 backend/devices/registry.js 保持一致）。
const DEVICE_CAPABILITIES = {
  PJ01: ['strength'],
  TD01: ['strength'],
  OSR6: ['strength'],
  QIYA: ['sphincterPressure', 'reporting'],
  DIANJI: ['shock'],
  ZIDONGSUO: ['lock', 'buttonInput'],
  QTZ: ['distance', 'buttonInput', 'reporting', 'tiptoePressure'],
  DZC01: ['weight', 'reporting'],
  CUNZHI01: ['sphincterPressure', 'tiptoePressure', 'strength', 'shock', 'reporting'],
  DAN01: ['attitude', 'reporting', 'buttonInput'],
  HRM: ['heartRate'],
  DGLAB: ['shock', 'estim'],
  YCY_EMS: ['shock', 'estim'],
  YCY_TOY: ['strength', 'motors'],
  YCY_CUP: ['strength', 'motors'],
  YCY_ENEMA: ['pump'],
  SOSEXY_PID0004: ['strength', 'vibration', 'suction', 'shock'],
  GXP_XA9935: ['strength'],
};

const LATCH_MAX_MS = { electric: ELECTRIC_LATCH_MS, motor: MOTOR_LATCH_MS };

// 投影链路允许的品牌命令（brand 字段 → cmd → 规格）。
// 规格：fields = 允许字段 → 字段种类；stop = 停止指令（多余字段直接丢弃）。
const BRAND_COMMANDS = {
  dglab: {
    setPattern: { latch: 'electric', fields: { pattern: 'text', intensity: 'intensity', ticks: 'ticks' } },
    setEstim: { latch: 'electric', fields: { channel: 'channel', intensity: 'intensity', wave: 'text' } },
    setBackground: { latch: 'electric', fields: { intensity: 'intensity', ticks: 'ticks' } },
    stopPattern: { stop: true },
    stop: { stop: true },
  },
  ycy: {
    setStrength: { latch: 'electric', fields: { channel: 'channel', value: 'intensity', wave: 'text' } },
    setEstim: { latch: 'electric', fields: { channel: 'channel', intensity: 'intensity', wave: 'text' } },
    setMode: { latch: 'electric', fields: { channel: 'channel', value: 'intensity', mode: 'text' } },
    setMotors: { latch: 'motor', channels: true },
    setFjb: { latch: 'motor', fields: { stroke: 'stroke', vibe: 'motorLevel', axis: 'motorLevel' } },
    setToySpeeds: { latch: 'motor', channels: true },
    setSpeed: { latch: 'motor', fields: { speed: 'motorLevel' } },
    pump: {
      latch: 'motor',
      fields: { protocol: 'protocol', scene: 'scene', rate: 'rate', ss: 'seconds' },
      sceneStop: true,
    },
    stopAll: { stop: true },
    stop: { stop: true },
    stopToy: { stop: true },
    stopFjb: { stop: true },
  },
  sosexy: {
    setStrength: { latch: 'motor', fields: { value: 'power' } },
    setVibration: { latch: 'motor', fields: { value: 'intensity', mode: 'mode' } },
    setSuction: { latch: 'motor', fields: { value: 'intensity', mode: 'mode' } },
    setShock: { latch: 'electric', fields: { voltage: 'voltage', mode: 'mode' } },
    setLight: { fields: { enabled: 'bool01' } },
    setMicrocurrentProtection: { fields: { enabled: 'bool01' } },
    queryStatus: { fields: {} },
    stopAll: { stop: true },
    stop: { stop: true },
  },
  gxp: {
    setStrength: { latch: 'motor', fields: { value: 'power' } },
    setMotorAndMode: { latch: 'motor', fields: { value: 'power', percent: 'intensity', mode: 'uint8' } },
    stopVibration: { stop: true },
    stopAll: { stop: true },
    stop: { stop: true },
  },
};

// 品牌命令 → 该设备类型必须具备的能力（防止把电击命令发给电机设备）。
const BRAND_COMMAND_CAPABILITY = {
  dglab: {
    setPattern: 'shock', setEstim: 'estim', setBackground: 'shock',
    stopPattern: 'shock', stop: 'shock',
  },
  ycy: {
    setStrength: 'shock', setEstim: 'estim', setMode: 'shock',
    setMotors: 'motors', setFjb: 'motors', setToySpeeds: 'motors', setSpeed: 'motors',
    pump: 'pump', stopAll: 'motors', stop: 'motors', stopToy: 'motors', stopFjb: 'motors',
  },
  sosexy: {
    setStrength: 'strength', setVibration: 'vibration', setSuction: 'suction', setShock: 'shock',
    setLight: null, setMicrocurrentProtection: null, queryStatus: null,
    stopAll: null, stop: null,
  },
  gxp: {
    setStrength: 'strength', setMotorAndMode: 'strength',
    stopVibration: 'strength', stopAll: 'strength', stop: 'strength',
  },
};

/** 按规格归一化 input 字段；未在规格中的字段直接丢弃（不拒绝，见 stop 路径）。 */
function applyFieldSpec(input, spec, limits, { allowUnknown = false } = {}) {
  const out = {};
  for (const [key, raw] of Object.entries(input)) {
    const kind = ownField(spec, key);
    if (!kind) {
      if (allowUnknown) continue;
      return reject(`远程控制不允许设置字段: ${key}`);
    }
    const value = FIELD_KINDS[kind](raw, limits);
    if (value === null) return reject(`远程控制字段取值非法: ${key}`);
    out[key] = value;
  }
  return { ok: true, input: out };
}

function applyChannelSpec(channels, spec, limits) {
  if (channels === undefined) return { ok: true, input: {} };
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
    return reject('远程控制字段取值非法: channels');
  }
  const out = {};
  for (const [name, raw] of Object.entries(channels)) {
    const kind = ownField(spec, name);
    if (!kind) return reject(`远程控制不允许设置通道: ${name}`);
    const source = raw && typeof raw === 'object' ? raw : { value: raw };
    const value = FIELD_KINDS[kind](source.value, limits);
    if (value === null) return reject(`远程控制通道取值非法: ${name}`);
    out[name] = { value };
    if (source.direction !== undefined) out[name].direction = clampNumber(source.direction, 1, -1);
  }
  return { ok: true, input: out };
}

function isStopAction(action) {
  return STOP_ACTIONS.has(String(action || '').toLowerCase());
}

/**
 * 校验 + 钳制一次能力调用（远程游戏的 devices.invoke 走这里）。
 * 返回 { ok:true, input }（input 为归一化后的参数）或 { ok:false, code, message }。
 */
function sanitizeCapabilityInvoke({ device, capability, action, input, limits } = {}) {
  const type = deviceType(device);
  const capabilities = ownField(DEVICE_CAPABILITIES, type);
  if (!capabilities) {
    return reject(`未知设备类型: ${type || '(空)'}`);
  }
  const capabilityKey = String(capability || '');
  if (!capabilities.includes(capabilityKey)) {
    return reject(`设备 ${type} 不支持能力: ${capabilityKey}`);
  }
  const actionKey = String(action || '');
  const spec = ownField(CAPABILITY_ACTIONS[capabilityKey], actionKey);
  if (!spec) {
    return reject(`设备 ${type} 不支持动作: ${capabilityKey}.${actionKey}`);
  }
  const normalizedLimits = normalizeLimits(limits);
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (spec.stop || isStopAction(actionKey)) {
    // 停止指令永远放行：多余字段丢弃，避免停止本身被拒。
    return { ok: true, input: {} };
  }
  if (spec.channels) {
    const channels = applyChannelSpec(raw.channels, ownField(CHANNEL_SPECS, type) || {}, normalizedLimits);
    if (!channels.ok) return reject(channels.message);
    return { ok: true, input: { channels: channels.input } };
  }
  const fields = applyFieldSpec(raw, spec.fields || {}, normalizedLimits, { allowUnknown: false });
  if (!fields.ok) return reject(fields.message);
  return { ok: true, input: fields.input };
}

// 宿主核心（分离式游戏 game-core.js）的设备意图 → 能力调用规格。
// 核心意图的字段名与能力动作的字段名不同（如 set-strength 的 value → strength.set 的 value），
// 这里只做形状转换，限幅/拒绝/锁存全部复用下面 sanitizeCapabilityInvoke 的同一套规则。
const HOST_INTENT_ACTIONS = {
  'device.set-strength': { capability: 'strength', action: 'set', fields: { value: 'value' } },
  'device.stop-strength': { capability: 'strength', action: 'stop', fields: {} },
  // durationMs 是宿主的定时停机参数（不进设备报文），声明为容忍字段
  'device.shock': { capability: 'shock', action: 'start', fields: { voltage: 'voltage' }, extra: ['durationMs'] },
  'device.shock-stop': { capability: 'shock', action: 'stop', fields: {} },
  'device.lock': { capability: 'lock', action: 'setOpen', fields: { open: 'open' } },
  'device.set-report-delay': { capability: 'reporting', action: 'setReportDelay', fields: { ms: 'ms' } },
  // 结束/复位意图：没有能力调用形状，永远放行（宿主只按映射设备做停机复位）
  'device.stop-all': { capability: null, action: '', fields: {}, stopAll: true },
};

/** 该核心意图类型是否有对应的远程规格（未知类型一律拒绝，绝不透传）。 */
function isKnownHostIntent(type) {
  return !!ownField(HOST_INTENT_ACTIONS, String(type || ''));
}

/**
 * 校验 + 钳制核心发出的一条设备意图（远程会话下的宿主玩法走这里）。
 * 返回 { ok:true, input, stopAll }（input 为归一化后的能力参数）或 { ok:false, code, message }。
 */
function sanitizeHostIntent({ device, effect, limits } = {}) {
  if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
    return reject('远程玩法设备意图格式无效');
  }
  const type = String(effect.type || '');
  const spec = ownField(HOST_INTENT_ACTIONS, type);
  if (!spec) return reject(`远程玩法不允许的设备意图: ${type || '(空)'}`);
  if (spec.stopAll) return { ok: true, input: {}, stopAll: true };
  // 只取规格里声明的字段：其它字段不进入能力参数，绝不透传；
  // role 是宿主的路由字段，extra 是宿主自己消费的参数（如电击时长 durationMs），
  // 两者都容忍但不转发给设备。停止意图照旧只放行、不校验字段（与 sanitizeCapabilityInvoke 一致）。
  const isStop = !spec.capability || spec.action === 'stop';
  const fieldKeys = new Set([...Object.keys(spec.fields), ...(spec.extra || []), 'role']);
  if (!isStop) {
    for (const key of Object.keys(effect)) {
      if (key !== 'type' && !fieldKeys.has(key)) return reject(`远程玩法不允许的意图字段: ${key}`);
    }
  }
  const input = {};
  for (const [key, field] of Object.entries(spec.fields)) input[key] = effect[field];
  const sanitized = sanitizeCapabilityInvoke({
    device,
    capability: spec.capability,
    action: spec.action,
    input,
    limits,
  });
  if (!sanitized.ok) return sanitized;
  return { ok: true, input: sanitized.input || {}, stopAll: false };
}

/** 从设备属性报文里抽出可远程写的字段；非 update 报文与未知字段一律拒绝。 */
function sanitizeDeviceMessage(type, message, limits) {
  const method = message.method === undefined ? 'update' : String(message.method);
  if (method !== 'update') {
    // report 是设备上行方向；远程写入只允许 update。
    return reject(`远程投影不允许设备报文 method: ${method}`);
  }
  const spec = { ...COMMON_FIELD_SPECS, ...(ownField(DEVICE_FIELD_SPECS, type) || {}) };
  const out = { method: 'update' };
  for (const [key, raw] of Object.entries(message)) {
    if (key === 'method') continue;
    const kind = ownField(spec, key);
    if (!kind) return reject(`远程投影不允许设备字段: ${key}`);
    const value = FIELD_KINDS[kind](raw, limits);
    if (value === null) return reject(`远程投影字段取值非法: ${key}`);
    out[key] = value;
  }
  return { ok: true, message: out };
}

/** 品牌协议报文（DGLAB/YCY/SOSEXY/GXP 直发命令）。 */
function sanitizeBrandMessage(type, message, limits) {
  const brand = String(message.brand || '');
  const specs = ownField(BRAND_COMMANDS, brand);
  if (!specs) return reject(`远程投影不允许品牌协议: ${brand || '(空)'}`);
  const cmd = String(message.cmd || '');
  const spec = ownField(specs, cmd);
  if (!spec) return reject(`远程投影不允许品牌命令: ${brand}.${cmd || '(空)'}`);
  const requiredCapability = ownField(ownField(BRAND_COMMAND_CAPABILITY, brand), cmd);
  if (requiredCapability && !ownField(DEVICE_CAPABILITIES, type)?.includes(requiredCapability)) {
    return reject(`设备 ${type} 不支持品牌命令: ${brand}.${cmd}`);
  }
  const out = { brand, cmd };
  if (spec.stop) return { ok: true, message: out };
  if (spec.sceneStop && String(message.scene || '') === 'stop') {
    // 泵停止路径：只保留协议，其余字段丢弃。
    return { ok: true, message: { ...out, protocol: FIELD_KINDS.protocol(message.protocol) || 'v1', scene: 'stop' } };
  }
  if (spec.channels) {
    const channels = applyChannelSpec(message.channels, ownField(CHANNEL_SPECS, type) || {}, limits);
    if (!channels.ok) return reject(channels.message);
    return { ok: true, message: { ...out, channels: channels.input } };
  }
  const fields = applyFieldSpec(message, spec.fields || {}, limits, { allowUnknown: true });
  if (!fields.ok) return reject(fields.message);
  delete fields.input.brand;
  delete fields.input.cmd;
  return { ok: true, message: { ...out, ...fields.input } };
}

/**
 * 校验 + 钳制一条投影写入报文（操作方经 projection.write 发来的原始设备报文）。
 * 返回 { ok:true, message } 或 { ok:false, code, message }。
 */
function sanitizeProjectionMessage({ device, message, limits } = {}) {
  const type = deviceType(device);
  if (!ownField(DEVICE_CAPABILITIES, type)) {
    return reject(`未知设备类型: ${type || '(空)'}`);
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return reject('远程投影指令格式无效');
  }
  const normalizedLimits = normalizeLimits(limits);
  const result = typeof message.brand === 'string' && message.brand
    ? sanitizeBrandMessage(type, message, normalizedLimits)
    : sanitizeDeviceMessage(type, message, normalizedLimits);
  if (!result.ok) return result;
  const payloadKeys = Object.keys(result.message).filter((key) => key !== 'method');
  if (payloadKeys.length === 0) {
    return reject('远程投影指令为空');
  }
  return result;
}

function stopResult() {
  return { latched: false, maxMs: 0 };
}

/**
 * 一条投影写入报文是否为「停止/归零」指令（按设备类型套规格判定）。
 * 被控端本地玩法运行期间（或被顶替后主控端尚未重新登记占用时），
 * 主控端只能经投影下发停止/归零：其余写入一律拒绝（关掉顶替窗口期的残余写入）。
 */
function isStopProjectionMessage({ device, message } = {}) {
  const type = deviceType(device);
  if (!type || !ownField(DEVICE_CAPABILITIES, type)) return false;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  if (typeof message.brand === 'string' && message.brand) {
    const specs = ownField(BRAND_COMMANDS, message.brand);
    const spec = specs ? ownField(specs, String(message.cmd || '')) : null;
    if (!spec) return false;
    if (spec.stop) return true;
    // 泵的 scene:'stop' 也是停止路径
    return !!spec.sceneStop && String(message.scene || '') === 'stop';
  }
  // 设备属性报文只认 update；report 是上行方向，不算停止
  const method = message.method === undefined ? 'update' : String(message.method);
  if (method !== 'update') return false;
  return deviceMessageLatch(type, message).latched !== true;
}

/** 设备属性报文是否代表一次锁存输出。 */
function deviceMessageLatch(type, message) {
  const method = message.method === undefined ? 'update' : String(message.method);
  if (method === 'report') return stopResult();
  if (method !== 'update') return { latched: true, maxMs: MOTOR_LATCH_MS };
  if (Number(message.voltage) > 0 || Number(message.shock) > 0) {
    return { latched: true, maxMs: ELECTRIC_LATCH_MS };
  }
  if (Number(message.power) > 0 || Number(message.intensity) > 0) {
    return { latched: true, maxMs: MOTOR_LATCH_MS };
  }
  if (type === 'YCY_CUP' && (Number(message.stroke) > 0 || Number(message.vibration) > 0)) {
    return { latched: true, maxMs: MOTOR_LATCH_MS };
  }
  if (type === 'YCY_ENEMA' && Number(message.pump) > 0) {
    return { latched: true, maxMs: MOTOR_LATCH_MS };
  }
  return stopResult();
}

/** 品牌协议报文是否代表一次锁存输出。 */
function brandMessageLatch(type, message) {
  const brand = String(message.brand || '');
  const cmd = String(message.cmd || '');
  if (cmd === 'pump') {
    return String(message.scene || 'stop') === 'stop'
      ? stopResult()
      : { latched: true, maxMs: MOTOR_LATCH_MS };
  }
  const spec = ownField(ownField(BRAND_COMMANDS, brand), cmd);
  if (!spec || spec.stop) return stopResult();
  if (spec.sceneStop) return { latched: true, maxMs: MOTOR_LATCH_MS };
  return { latched: true, maxMs: ownField(LATCH_MAX_MS, spec.latch) || MOTOR_LATCH_MS };
}

/** 能力动作是否代表一次锁存输出。 */
function capabilityActionLatch(capability, action, input) {
  const spec = ownField(CAPABILITY_ACTIONS[String(capability || '')], String(action || ''));
  if (!spec || spec.stop) return stopResult();
  if (capability === 'lock' && spec.fields?.open) {
    // 加锁是有意为之的持续状态，不设自动解锁定时器。
    return stopResult();
  }
  return { latched: true, maxMs: ownField(LATCH_MAX_MS, spec.latch) || MOTOR_LATCH_MS };
}

/**
 * 判断一条远程写入是否为锁存输出，以及最长锁存时长。
 * 电刺激（shock/voltage/estim）10000ms；电机/震动/吸吮/泵 60000ms；
 * 锁与停止/归零指令不锁存。
 */
function isLatchedOutput({ device, capability, action, input } = {}) {
  const type = deviceType(device);
  if (!type || !input || typeof input !== 'object' || Array.isArray(input)) {
    return stopResult();
  }
  const sanitized = sanitizeCapabilityInvoke({ device, capability, action, input });
  if (!sanitized.ok) return { latched: false, maxMs: 0 };
  return capabilityActionLatch(capability, action, sanitized.input);
}

/**
 * 判断一条投影写入报文是否为锁存输出。
 * 供 remoteProjectionService 在放行写入后登记 watchdog 使用。
 */
function isLatchedProjectionMessage({ device, message } = {}) {
  const type = deviceType(device);
  if (!type || !message || typeof message !== 'object' || Array.isArray(message)) {
    return stopResult();
  }
  const sanitized = sanitizeProjectionMessage({ device, message });
  if (!sanitized.ok) return stopResult();
  return typeof message.brand === 'string' && message.brand
    ? brandMessageLatch(type, sanitized.message)
    : deviceMessageLatch(type, sanitized.message);
}

/**
 * 锁存输出看门狗：登记设备 → 到点回调 stopDevice(deviceId) 兜底停机。
 * arm() 会覆盖同一设备的旧定时器（每次写入重新计时）。
 */
function createOutputWatchdog({ stopDevice, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const timers = new Map();

  function clear(deviceId) {
    const timer = timers.get(deviceId);
    if (timer) {
      clearTimer(timer);
      timers.delete(deviceId);
    }
  }

  function arm(deviceId, maxMs) {
    if (!deviceId) return;
    const ms = Number(maxMs);
    if (!Number.isFinite(ms) || ms <= 0) {
      clear(deviceId);
      return;
    }
    clear(deviceId);
    const timer = setTimer(() => {
      timers.delete(deviceId);
      void Promise.resolve()
        .then(() => stopDevice?.(deviceId))
        .catch(() => {});
    }, ms);
    timers.set(deviceId, timer);
  }

  function touched() {
    return new Set(timers.keys());
  }

  async function stopAll() {
    const deviceIds = [...timers.keys()];
    for (const deviceId of deviceIds) clear(deviceId);
    const results = await Promise.allSettled(deviceIds.map((deviceId) => (
      Promise.resolve().then(() => stopDevice?.(deviceId))
    )));
    return { stopped: deviceIds, failed: results.filter((r) => r.status === 'rejected').length };
  }

  return { arm, clear, touched, stopAll };
}

module.exports = {
  REMOTE_OUTPUT_REJECTED,
  DEFAULT_REMOTE_LIMITS,
  HARD_LIMITS,
  ELECTRIC_LATCH_MS,
  MOTOR_LATCH_MS,
  MAX_DGLAB_TICKS,
  MAX_PUMP_SECONDS,
  MAX_MOTOR_LEVEL,
  MAX_CUP_STROKE,
  MAX_REPORT_DELAY_MS,
  DEVICE_CAPABILITIES,
  CAPABILITY_ACTIONS,
  BRAND_COMMANDS,
  normalizeLimits,
  clampNumber,
  electricCap,
  deviceType,
  ownField,
  STOP_ACTIONS,
  STOP_ZERO_FIELDS,
  DEVICE_FIELD_SPECS,
  COMMON_FIELD_SPECS,
  CHANNEL_SPECS,
  BRAND_COMMAND_CAPABILITY,
  HOST_INTENT_ACTIONS,
  isKnownHostIntent,
  sanitizeHostIntent,
  sanitizeCapabilityInvoke,
  sanitizeProjectionMessage,
  isLatchedOutput,
  isLatchedProjectionMessage,
  isStopProjectionMessage,
  createOutputWatchdog,
};
