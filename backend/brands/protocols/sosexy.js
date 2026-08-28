/**
 * SOSEXY PID 0004 BLE 协议。
 *
 * 逻辑报文是属性列表：count + [property:u16 BE, descriptor:u8, value]。
 * EE03 的 ATT value 再按 18 字节分片，并在每片前加 message id/sequence。
 */

const SERVICE_UUID = '0000ee01-0000-1000-8000-00805f9b34fb';
const NOTIFY_UUID = '0000ee02-0000-1000-8000-00805f9b34fb';
const WRITE_UUID = '0000ee03-0000-1000-8000-00805f9b34fb';
const MAX_INTENSITY = 100;

function clamp(value, min = 0, max = MAX_INTENSITY, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function strengthToDevice(value) {
  return clamp((clamp(value, 0, 255) / 255) * MAX_INTENSITY);
}

function levelToDevice(value) {
  return clamp(value, 0, MAX_INTENSITY);
}

function property(id, descriptor, value) {
  const bytes = Array.isArray(value) ? value : [value];
  if (bytes.length > 15) throw new RangeError(`SOSEXY 属性 ${id.toString(16)} 值过长`);
  return { id, descriptor: descriptor ?? ((bytes.length === 2) ? 0x12 : 0x11), value: bytes };
}

function encodeProperties(properties) {
  const list = Array.isArray(properties) ? properties : [];
  if (list.length > 0xff) throw new RangeError('SOSEXY 属性数量超过 255');
  const out = [list.length];
  for (const item of list) {
    const id = Number(item.id);
    if (!Number.isInteger(id) || id < 0 || id > 0xffff) throw new RangeError('SOSEXY 属性 ID 非法');
    const value = Array.from(item.value || [], (v) => Number(v) & 0xff);
    const descriptor = Number(item.descriptor);
    const descriptorLength = descriptor === 0xaf ? 15 : (descriptor & 0x0f);
    if (value.length > 15 || ![0x11, 0x12, 0xaf].includes(descriptor)
      || descriptorLength !== value.length) {
      throw new RangeError(`SOSEXY 属性 ${id.toString(16)} descriptor/value 非法`);
    }
    out.push((id >> 8) & 0xff, id & 0xff, descriptor, ...value);
  }
  return Buffer.from(out);
}

function channelProperties(id, modeId, value, mode = 1) {
  return [property(id, 0x11, strengthToDevice(value)), property(modeId, 0x11, clamp(mode, 0, 4))];
}

function buildStrength({ value = 0, vibrationMode = 1, suctionMode = 1 } = {}) {
  return encodeProperties([
    ...channelProperties(0x0001, 0x0002, value, vibrationMode),
    ...channelProperties(0x0007, 0x0008, value, suctionMode),
  ]);
}

function buildVibration({ value = 0, mode = 1 } = {}) {
  return encodeProperties(channelProperties(0x0001, 0x0002, value, mode));
}

function buildSuction({ value = 0, mode = 1 } = {}) {
  return encodeProperties(channelProperties(0x0007, 0x0008, value, mode));
}

function buildShock({ voltage = 0, mode = 1 } = {}) {
  return encodeProperties([
    property(0x0003, 0x11, levelToDevice(voltage)),
    property(0x0004, 0x11, clamp(mode, 0, 4)),
  ]);
}

function buildStopAll() {
  return encodeProperties([
    property(0x0001, 0x11, 0),
    property(0x0003, 0x11, 0),
    property(0x0007, 0x11, 0),
  ]);
}

function buildStatusQuery() {
  return encodeProperties([property(0x00c8, 0x11, 1)]);
}

function buildLight(enabled) {
  return encodeProperties([property(0x000d, 0x11, enabled ? 1 : 0)]);
}

function buildMicrocurrentProtection(enabled) {
  return encodeProperties([property(0x000e, 0x11, enabled ? 1 : 0)]);
}

function toLogicalMessage(command = {}) {
  switch (command.cmd) {
    case 'setStrength': return buildStrength(command);
    case 'setVibration': return buildVibration(command);
    case 'setSuction': return buildSuction(command);
    case 'setShock': return buildShock(command);
    case 'stopAll':
    case 'stop': return buildStopAll();
    case 'queryStatus': return buildStatusQuery();
    case 'setLight': return buildLight(command.enabled);
    case 'setMicrocurrentProtection': return buildMicrocurrentProtection(command.enabled);
    default: throw new Error(`未知的 SOSEXY BLE 指令: ${command.cmd}`);
  }
}

function packetize(logical, messageId = 1) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(logical || [])]);
  const id = clamp(messageId, 0, 0xfe);
  const frames = [];
  let sequence = 1;
  for (let offset = 0; offset < payload.length; offset += 18) {
    frames.push(Buffer.from([id, sequence++ & 0xff, ...payload.slice(offset, offset + 18)]));
  }
  if (payload.length % 18 === 0) frames.push(Buffer.from([id, sequence & 0xff]));
  return frames;
}

function toBleFrames(command, messageId) {
  return packetize(toLogicalMessage(command), messageId);
}

module.exports = {
  SERVICE_UUID,
  NOTIFY_UUID,
  WRITE_UUID,
  MAX_INTENSITY,
  clamp,
  strengthToDevice,
  levelToDevice,
  encodeProperties,
  buildStrength,
  buildVibration,
  buildSuction,
  buildShock,
  buildStopAll,
  buildStatusQuery,
  buildLight,
  buildMicrocurrentProtection,
  toLogicalMessage,
  packetize,
  toBleFrames,
};
