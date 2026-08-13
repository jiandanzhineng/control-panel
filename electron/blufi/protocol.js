const BLUFI_UUIDS = Object.freeze({
  service: '0000ffff-0000-1000-8000-00805f9b34fb',
  write: '0000ff01-0000-1000-8000-00805f9b34fb',
  notify: '0000ff02-0000-1000-8000-00805f9b34fb',
});

const FRAME_TYPE_CONTROL = 0x00;
const FRAME_TYPE_DATA = 0x01;
const CTRL_FRAG = 0x10;

const CONTROL_SET_SEC_MODE = 0x01;
const CONTROL_SET_OP_MODE = 0x02;
const CONTROL_CONNECT_WIFI = 0x03;
const CONTROL_GET_WIFI_STATUS = 0x05;

const DATA_STA_SSID = 0x02;
const DATA_STA_PASSWORD = 0x03;
const DATA_WIFI_STATUS = 0x0f;
const DATA_ERROR = 0x12;

const WIFI_SUCCESS = 0x00;
const WIFI_FAIL = 0x01;
const WIFI_CONNECTING = 0x02;
const WIFI_REASON = 0x15;
const WIFI_IP = 0x18;
const MAX_CHUNK = 12;

function textToBytes(text) {
  return new TextEncoder().encode(String(text ?? ''));
}

function parseIp(bytes) {
  if (!bytes || bytes.length !== 4) return null;
  return Array.from(bytes).join('.');
}

function parseWifiStatus(payload) {
  if (!payload || payload.length < 3) {
    return { opMode: null, staState: null, staStateName: 'unknown', extras: {} };
  }

  const extras = {};
  let offset = 3;
  while (offset + 1 < payload.length) {
    const itemType = payload[offset];
    const itemLength = payload[offset + 1];
    offset += 2;
    if (offset + itemLength > payload.length) break;
    const value = payload.slice(offset, offset + itemLength);
    offset += itemLength;

    if (itemType === WIFI_REASON && itemLength >= 1) {
      extras.reason = value[0];
    } else if (itemType === WIFI_IP) {
      extras.stationIp = parseIp(value);
    }
  }

  const names = {
    [WIFI_SUCCESS]: 'connected',
    [WIFI_FAIL]: 'failed',
    [WIFI_CONNECTING]: 'connecting',
    0x03: 'connected_no_ip',
  };
  return {
    opMode: payload[0],
    staState: payload[1],
    staStateName: names[payload[1]] || `state_${payload[1]}`,
    extras,
  };
}

function buildFrames(sequence, frameType, subtype, payload) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload || 0);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK) {
    chunks.push(bytes.slice(offset, offset + MAX_CHUNK));
  }
  if (chunks.length === 0) chunks.push(new Uint8Array(0));

  return chunks.map((chunk, index) => {
    const hasMore = index < chunks.length - 1;
    const body = hasMore
      ? Uint8Array.from([bytes.length & 0xff, (bytes.length >> 8) & 0xff, ...chunk])
      : chunk;
    return Uint8Array.from([
      (subtype << 2) | frameType,
      hasMore ? CTRL_FRAG : 0x00,
      (sequence + index) & 0xff,
      body.length & 0xff,
      ...body,
    ]);
  });
}

function createNotificationParser() {
  let pending = null;
  return {
    feed(data) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
      if (bytes.length < 4) return [];

      const typeByte = bytes[0];
      const frameControl = bytes[1];
      const sequence = bytes[2];
      const dataLength = bytes[3];
      const fragmented = (frameControl & CTRL_FRAG) !== 0;
      let offset = 4;
      let totalLength = null;
      if (fragmented) {
        if (bytes.length < 6) return [];
        totalLength = bytes[offset] | (bytes[offset + 1] << 8);
        offset += 2;
      }

      const frameType = typeByte & 0x03;
      const subtype = typeByte >> 2;
      const payload = bytes.slice(offset, offset + dataLength - (fragmented ? 2 : 0));

      if (fragmented) {
        if (!pending || pending.frameType !== frameType || pending.subtype !== subtype) {
          pending = { frameType, subtype, totalLength, payload: [] };
        }
        pending.payload.push(...payload);
        return [];
      }

      if (pending && pending.frameType === frameType && pending.subtype === subtype) {
        const merged = Uint8Array.from([...pending.payload, ...payload]);
        const expectedLength = pending.totalLength;
        pending = null;
        return [{
          frameType,
          subtype,
          sequence,
          frameControl,
          payload: expectedLength ? merged.slice(0, expectedLength) : merged,
        }];
      }

      return [{ frameType, subtype, sequence, frameControl, payload }];
    },
  };
}

function decodeFrame(frame) {
  if (frame.frameType === FRAME_TYPE_DATA && frame.subtype === DATA_WIFI_STATUS) {
    return { kind: 'wifi_status', sequence: frame.sequence, ...parseWifiStatus(frame.payload) };
  }
  if (frame.frameType === FRAME_TYPE_DATA && frame.subtype === DATA_ERROR) {
    return { kind: 'error', sequence: frame.sequence, errorCode: frame.payload[0] ?? null };
  }
  return { kind: 'frame', sequence: frame.sequence, frameType: frame.frameType, subtype: frame.subtype };
}

module.exports = {
  BLUFI_UUIDS,
  FRAME_TYPE_CONTROL,
  FRAME_TYPE_DATA,
  CONTROL_SET_SEC_MODE,
  CONTROL_SET_OP_MODE,
  CONTROL_CONNECT_WIFI,
  CONTROL_GET_WIFI_STATUS,
  DATA_STA_SSID,
  DATA_STA_PASSWORD,
  DATA_WIFI_STATUS,
  DATA_ERROR,
  WIFI_SUCCESS,
  WIFI_FAIL,
  WIFI_CONNECTING,
  WIFI_REASON,
  WIFI_IP,
  MAX_CHUNK,
  textToBytes,
  parseWifiStatus,
  buildFrames,
  createNotificationParser,
  decodeFrame,
};
