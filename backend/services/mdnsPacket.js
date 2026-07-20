const net = require('net');

const HEADER_SIZE = 12;
const TYPE_A = 1;
const TYPE_ANY = 255;
const CLASS_IN = 1;
const CACHE_FLUSH = 0x8000;
const RESPONSE_FLAGS = 0x8400;
const HOST_NAME = 'easysmart.local';
const STANDARD_TTL = 120;
const LEGACY_TTL = 10;

function readName(packet, start) {
  const labels = [];
  const visited = new Set();
  let cursor = start;
  let nextOffset = null;

  while (cursor < packet.length) {
    if (visited.has(cursor)) return null;
    visited.add(cursor);

    const length = packet[cursor];
    if (length === 0) {
      return { name: labels.join('.'), nextOffset: nextOffset ?? cursor + 1 };
    }

    if ((length & 0xc0) === 0xc0) {
      if (cursor + 1 >= packet.length) return null;
      if (nextOffset === null) nextOffset = cursor + 2;
      cursor = ((length & 0x3f) << 8) | packet[cursor + 1];
      continue;
    }

    if (length > 63 || cursor + length + 1 > packet.length) return null;
    labels.push(packet.toString('utf8', cursor + 1, cursor + length + 1));
    cursor += length + 1;
  }

  return null;
}

function inspectQuery(value) {
  const packet = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (packet.length < HEADER_SIZE || (packet[2] & 0x80) !== 0) return null;

  const questionCount = packet.readUInt16BE(4);
  if (questionCount === 0) return null;

  let offset = HEADER_SIZE;
  let relevantQuestion = null;
  for (let index = 0; index < questionCount; index += 1) {
    const questionStart = offset;
    const decoded = readName(packet, offset);
    if (!decoded) return null;
    offset = decoded.nextOffset;
    if (offset + 4 > packet.length) return null;

    const type = packet.readUInt16BE(offset);
    const rawClass = packet.readUInt16BE(offset + 2);
    const questionClass = rawClass & 0x7fff;
    offset += 4;

    if (
      !relevantQuestion
      && decoded.name.toLowerCase() === HOST_NAME
      && (type === TYPE_A || type === TYPE_ANY)
      && questionClass === CLASS_IN
    ) {
      relevantQuestion = {
        bytes: Buffer.from(packet.subarray(questionStart, offset)),
        unicastRequested: (rawClass & 0x8000) !== 0,
      };
    }
  }

  if (!relevantQuestion) return null;
  return {
    id: packet.readUInt16BE(0),
    question: relevantQuestion.bytes,
    unicastRequested: relevantQuestion.unicastRequested,
  };
}

function ipv4Bytes(address) {
  if (!net.isIPv4(address)) {
    throw new TypeError(`Invalid IPv4 address: ${address}`);
  }
  return Buffer.from(address.split('.').map(Number));
}

function encodedName(name) {
  const parts = [];
  for (const label of name.split('.')) {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length === 0 || bytes.length > 63) {
      throw new TypeError(`Invalid DNS label: ${label}`);
    }
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function recordTail(address, ttl, cacheFlush) {
  const result = Buffer.alloc(14);
  result.writeUInt16BE(TYPE_A, 0);
  result.writeUInt16BE(CLASS_IN | (cacheFlush ? CACHE_FLUSH : 0), 2);
  result.writeUInt32BE(ttl, 4);
  result.writeUInt16BE(4, 8);
  ipv4Bytes(address).copy(result, 10);
  return result;
}

function legacyUnicastResponse(query, address, ttl = LEGACY_TTL) {
  if (!query || !Buffer.isBuffer(query.question)) {
    throw new TypeError('A parsed mDNS query is required');
  }

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt16BE(query.id, 0);
  header.writeUInt16BE(RESPONSE_FLAGS, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);

  return Buffer.concat([
    header,
    query.question,
    Buffer.from([0xc0, 0x0c]),
    recordTail(address, ttl, false),
  ]);
}

function multicastResponse(address, ttl = STANDARD_TTL) {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt16BE(RESPONSE_FLAGS, 2);
  header.writeUInt16BE(1, 6);

  return Buffer.concat([
    header,
    encodedName(HOST_NAME),
    recordTail(address, ttl, true),
  ]);
}

module.exports = {
  HOST_NAME,
  inspectQuery,
  legacyUnicastResponse,
  multicastResponse,
};
