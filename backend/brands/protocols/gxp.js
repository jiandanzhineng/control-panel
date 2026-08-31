/**
 * GXP 艾萝机娘二代 BLE 协议（对照 GXP Windows v0.5.1）。
 * 控制只写 FF03；震动强度字段未确认，不得下发。
 */
const crypto = require('crypto');

const WRITE_UUID = '0000ff03-0000-1000-8000-00805f9b34fb';
const NOTIFY_UUID = '0000ff02-0000-1000-8000-00805f9b34fb';
const DATA_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';
const NAME_KEYS = ['XA9935', 'GXP'];

function crc16Ccitt(data) {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function wrap(command, payload, counter) {
  const len = payload.length;
  const cmd = command & 0xff;
  const lenHi = (len >> 8) & 0xff;
  const lenLo = len & 0xff;
  const header = Buffer.from([
    0x02, 0xa5, 0x5a, 0x55, 0xaa, 0xf0, counter & 0xff, 0xb1, cmd, lenHi, lenLo,
  ]);
  const crc = crc16Ccitt(Buffer.concat([Buffer.from([0xb1, cmd, lenHi, lenLo]), payload]));
  return Buffer.concat([header, payload, Buffer.from([0x03, (crc >> 8) & 0xff, crc & 0xff])]);
}

function strengthToPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((Math.max(0, Math.min(255, n)) / 255) * 100);
}

function clampPercent(percent) {
  const n = Math.round(Number(percent));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new RangeError('GXP 电机百分比越界');
  return n;
}

function clampMode(mode) {
  const n = Math.round(Number(mode) || 0);
  if (n < 0 || n > 12) throw new RangeError('GXP 震动模式越界');
  return n;
}

function buildMotorAndMode(percent, mode, counter) {
  const payload = Buffer.alloc(24);
  payload[0] = 0x01;
  payload[7] = clampMode(mode) === 0 ? 0 : 100 + clampMode(mode);
  payload[8] = 0x11;
  payload.writeUInt16BE(5, 9);
  payload.writeUInt16BE(5, 11);
  payload[15] = clampPercent(percent);
  crypto.createHash('md5').update(payload.subarray(0, 16)).digest().copy(payload, 16, 0, 8);
  return wrap(0x03, payload, counter);
}

function buildStopVibration(counter) {
  const payload = Buffer.alloc(24);
  payload[0] = 0x01;
  payload[2] = 0x07;
  crypto.createHash('md5').update(Buffer.alloc(7)).digest().copy(payload, 8);
  return wrap(0x03, payload, counter);
}

function toBleFrame(command = {}, counter = 1) {
  switch (command.cmd) {
    case 'setStrength':
      return buildMotorAndMode(strengthToPercent(command.value), command.mode ?? 0, counter);
    case 'setMotorAndMode': {
      const percent = command.percent != null ? command.percent : strengthToPercent(command.value);
      return buildMotorAndMode(percent, command.mode ?? 0, counter);
    }
    case 'stopVibration':
      return buildStopVibration(counter);
    case 'stop':
    case 'stopAll':
      return buildMotorAndMode(0, 0, counter);
    default:
      throw new Error(`未知的 GXP BLE 指令: ${command.cmd}`);
  }
}

function matchesName(name) {
  const n = String(name || '').toUpperCase();
  return NAME_KEYS.some((k) => n.includes(k));
}

module.exports = {
  WRITE_UUID,
  NOTIFY_UUID,
  DATA_UUID,
  NAME_KEYS,
  crc16Ccitt,
  wrap,
  strengthToPercent,
  buildMotorAndMode,
  buildStopVibration,
  toBleFrame,
  matchesName,
};
