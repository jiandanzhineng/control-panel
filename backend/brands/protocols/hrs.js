/**
 * 标准蓝牙心率服务（HRS）测量帧解析。
 * 纯函数，无副作用：供 noble 连接层与单测复用，语义与移动端同构。
 * 规范：GATT 0x2A37 Heart Rate Measurement。
 *
 * flags 位：
 *   bit0    心率值格式：0 = uint8，1 = uint16
 *   bit1    支持接触检测
 *   bit2    已检测到接触（bit1=0 时无意义）
 *   bit3    帧内带能量消耗（uint16，kJ）
 *   bit4    帧内带 RR 间期（uint16，1/1024 s，可重复多组）
 */

const HRS_SERVICE = '180d';
const HR_MEASUREMENT_CHAR = '2a37';
const HR_CONTROL_POINT_CHAR = '2a39';
const BATTERY_SERVICE = '180f';
const BATTERY_LEVEL_CHAR = '2a19';
const IDENTITY_CHAR = 'ff04';

const NO_CONTACT_STATUS = 'no_contact';
const OK_STATUS = 'ok';
const STALE_STATUS = 'stale';

/** 把 1/1024 s 单位的 RR 间期换算成毫秒。 */
function rrToMs(raw) {
  return Math.round((Number(raw) || 0) * 1000 / 1024);
}

/**
 * 解析一帧心率测量值。
 * 返回 { heartRate, contactSupported, contactDetected, energyKj, rrIntervals, rrInterval }，
 * 缺省字段为 undefined（帧里没有就不写，见方案表）。
 * 帧长不足或 flags 与长度矛盾时抛错，交由上层记日志丢弃该帧。
 */
function parseMeasurement(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buf.length < 2) throw new Error('心率测量帧过短');
  const flags = buf[0];
  const wide = (flags & 0x01) !== 0;
  const need = wide ? 3 : 2;
  if (buf.length < need) throw new Error('心率测量帧缺少心率字段');
  const heartRate = wide ? buf.readUInt16LE(1) : buf[1];

  const out = { heartRate };
  if (flags & 0x02) {
    out.contactSupported = true;
    out.contactDetected = (flags & 0x04) !== 0;
  }

  let offset = need;
  if (flags & 0x08) {
    if (buf.length < offset + 2) throw new Error('心率测量帧缺少能量消耗字段');
    out.energyKj = buf.readUInt16LE(offset);
    offset += 2;
  }
  if (flags & 0x10) {
    const rr = [];
    while (offset + 2 <= buf.length) {
      rr.push(rrToMs(buf.readUInt16LE(offset)));
      offset += 2;
    }
    if (!rr.length) throw new Error('心率测量帧缺少 RR 间期字段');
    out.rrIntervals = rr;
    out.rrInterval = rr[rr.length - 1];
  }
  return out;
}

/** 由一帧解析结果推导 hr_status。 */
function statusFromMeasurement(parsed) {
  if (!parsed || !parsed.heartRate) return NO_CONTACT_STATUS;
  if (parsed.contactSupported && !parsed.contactDetected) return NO_CONTACT_STATUS;
  return OK_STATUS;
}

const DEVICE_ID_RE = /^[0-9a-f]{12}$/;
const FIRMWARE_VERSION_RE = /^v[^\s]{1,30}$/;

/**
 * 解析 0xFF04 身份特征（与 electron/ble/protocol.js decodeIdentity、串口握手同规则）。
 * 特征缺失（bytes 为空）返回 null（第三方心率带回退 BLE 地址）；
 * 特征存在但内容非法抛错，由上层拒绝连接（ADR 0011）。
 */
function parseIdentity(bytes) {
  if (bytes === undefined || bytes === null || (Buffer.isBuffer(bytes) && bytes.length === 0)) return null;
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8').trim() : String(bytes).trim();
  if (!text) return null;
  let identity;
  try {
    identity = JSON.parse(text);
  } catch (_) {
    throw new Error('身份特征不是合法 JSON');
  }
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error('身份特征必须是 JSON 对象');
  }
  if (typeof identity.device_id !== 'string' || !DEVICE_ID_RE.test(identity.device_id)) {
    throw new Error('身份特征 device_id 非法');
  }
  if (typeof identity.firmware_version !== 'string' || !FIRMWARE_VERSION_RE.test(identity.firmware_version)) {
    throw new Error('身份特征 firmware_version 非法');
  }
  return { deviceId: identity.device_id, firmwareVersion: identity.firmware_version };
}

/**
 * 解析结果 → 设备 data 属性（方案表约定的字段名）。
 * 心率 0 一律视为无有效读数，不带接触位。
 */
function toProps(parsed) {
  const props = {
    heart_rate: Number(parsed?.heartRate) || 0,
    hr_status: statusFromMeasurement(parsed),
  };
  if (parsed?.contactSupported) props.hr_contact = parsed.contactDetected ? 1 : 0;
  if (parsed?.rrInterval !== undefined) props.rr_interval = parsed.rrInterval;
  if (parsed?.energyKj !== undefined) props.energy = parsed.energyKj;
  return props;
}

module.exports = {
  HRS_SERVICE,
  HR_MEASUREMENT_CHAR,
  HR_CONTROL_POINT_CHAR,
  BATTERY_SERVICE,
  BATTERY_LEVEL_CHAR,
  IDENTITY_CHAR,
  NO_CONTACT_STATUS,
  OK_STATUS,
  STALE_STATUS,
  rrToMs,
  parseMeasurement,
  statusFromMeasurement,
  parseIdentity,
  toProps,
};
