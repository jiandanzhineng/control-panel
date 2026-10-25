const BLE_UUIDS = Object.freeze({
  service: '000000ff-0000-1000-8000-00805f9b34fb',
  message: '0000ff01-0000-1000-8000-00805f9b34fb',
  mode: '0000ff02-0000-1000-8000-00805f9b34fb',
  command: '0000ff03-0000-1000-8000-00805f9b34fb',
  identity: '0000ff04-0000-1000-8000-00805f9b34fb',
  userDescription: '00002901-0000-1000-8000-00805f9b34fb',
});

const FLOAT_PROPERTIES = new Set([
  'pressure',
  'pressure1',
  'temperature',
  'distance',
  'height',
  'game_p1_thresh',
  'game_p2_thresh',
]);

const STRING_PROPERTIES = new Set([
  'device_type',
  'line1_text',
  'line2_text',
  'accel',
  'gyro',
  'mag',
  'quat',
]);

function asFourBytes(bytes) {
  const result = new Uint8Array(4);
  result.set(new Uint8Array(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 4)));
  return result;
}

function propertyType(name) {
  if (STRING_PROPERTIES.has(name)) return 'string';
  if (FLOAT_PROPERTIES.has(name)) return 'float';
  return 'int';
}

function decodePropertyValue(name, bytes) {
  const type = propertyType(name);
  if (type === 'string') return new TextDecoder().decode(bytes).trim();

  const data = asFourBytes(bytes);
  const view = new DataView(data.buffer);
  if (type === 'float') return view.getFloat32(0, true);
  return view.getInt32(0, true);
}

function encodeInt32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, Math.trunc(Number(value)), true);
  return bytes;
}

function encodeFirmwareFloat(value) {
  let mantissa = Number(value);
  if (!Number.isFinite(mantissa)) throw new TypeError('BLE float must be finite');
  if (mantissa === 0) return Uint8Array.from([0, 0, 0, 0]);

  let exponent = 0;
  while (!Number.isInteger(mantissa) && exponent > -4) {
    mantissa *= 10;
    exponent -= 1;
  }
  while (Math.abs(mantissa) > 0x7fffff && exponent < 4) {
    mantissa /= 10;
    exponent += 1;
  }

  const rounded = Math.round(mantissa);
  if (rounded < -0x800000 || rounded > 0x7fffff) {
    throw new RangeError('BLE float mantissa exceeds signed 24-bit range');
  }

  return Uint8Array.from([
    rounded & 0xff,
    (rounded >> 8) & 0xff,
    (rounded >> 16) & 0xff,
    exponent & 0xff,
  ]);
}

function encodePropertyValue(name, value) {
  const type = propertyType(name);
  if (type === 'string') return new TextEncoder().encode(String(value));
  if (type === 'float') return encodeFirmwareFloat(value);
  return encodeInt32(value);
}

function encodeMessage(message) {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  if (bytes.byteLength >= 256) {
    throw new RangeError('BLE message must be smaller than 256 bytes');
  }
  return bytes;
}

function decodeMessage(bytes) {
  const text = new TextDecoder().decode(bytes).trim();
  if (!text) return null;
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('BLE message must be a JSON object');
  }
  return value;
}

function decodeIdentity(bytes) {
  const identity = decodeMessage(bytes);
  const deviceId = identity?.device_id;
  const firmwareVersion = identity?.firmware_version;
  if (typeof deviceId !== 'string' || !/^[0-9a-f]{12}$/.test(deviceId)) {
    throw new TypeError('BLE identity device_id must be 12 lowercase hexadecimal characters');
  }
  if (typeof firmwareVersion !== 'string' || !/^v[^\s]{1,30}$/.test(firmwareVersion)) {
    throw new TypeError('BLE identity firmware_version must be a non-empty version starting with v');
  }
  return { deviceId, firmwareVersion };
}

module.exports = {
  BLE_UUIDS,
  FLOAT_PROPERTIES,
  STRING_PROPERTIES,
  propertyType,
  decodePropertyValue,
  encodePropertyValue,
  decodeMessage,
  encodeMessage,
  decodeIdentity,
};
