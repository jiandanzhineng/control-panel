const READY_PREFIX = '@DEBUG READY';
const MESSAGE_PREFIX = '@MSG ';
const MAX_LINE_LENGTH = 16 * 1024;
const DEVICE_ID_RE = /^[0-9a-f]{12}$/;
const FIRMWARE_VERSION_RE = /^v[^\s]{1,30}$/;

function parseIdentity(text) {
  let identity;
  try {
    identity = JSON.parse(text);
  } catch (_) {
    return null;
  }
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null;
  if (!DEVICE_ID_RE.test(identity.device_id)) return null;
  if (typeof identity.firmware_version !== 'string'
      || !FIRMWARE_VERSION_RE.test(identity.firmware_version)) return null;
  return {
    deviceId: identity.device_id,
    firmwareVersion: identity.firmware_version,
  };
}

function parseLine(line) {
  const clean = String(line || '').replace(/\r$/, '');
  if (clean.length > MAX_LINE_LENGTH) return { type: 'invalid', reason: 'line-too-long' };

  if (clean === READY_PREFIX) return { type: 'invalid-ready', reason: 'legacy-ready' };
  if (clean.startsWith(`${READY_PREFIX} `)) {
    const identity = parseIdentity(clean.slice(READY_PREFIX.length + 1));
    return identity
      ? { type: 'ready', ...identity }
      : { type: 'invalid-ready', reason: 'invalid-identity' };
  }
  if (clean.startsWith(MESSAGE_PREFIX)) {
    try {
      const message = JSON.parse(clean.slice(MESSAGE_PREFIX.length));
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return { type: 'invalid-message', reason: 'invalid-payload' };
      }
      return { type: 'message', message };
    } catch (_) {
      return { type: 'invalid-message', reason: 'invalid-json' };
    }
  }
  return { type: 'log', line: clean };
}

class SerialLineParser {
  constructor(options = {}) {
    this.maxLineLength = options.maxLineLength || MAX_LINE_LENGTH;
    this.buffer = '';
    this.discardUntilNewline = false;
  }

  push(chunk) {
    const events = [];
    let text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');

    if (this.discardUntilNewline) {
      const newline = text.indexOf('\n');
      if (newline < 0) return events;
      text = text.slice(newline + 1);
      this.discardUntilNewline = false;
    }

    this.buffer += text;
    if (this.buffer.length > this.maxLineLength && !this.buffer.includes('\n')) {
      this.buffer = '';
      this.discardUntilNewline = true;
      return [{ type: 'invalid', reason: 'line-too-long' }];
    }

    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      events.push(line.length > this.maxLineLength
        ? { type: 'invalid', reason: 'line-too-long' }
        : parseLine(line));
    }

    if (this.buffer.length > this.maxLineLength) {
      this.buffer = '';
      this.discardUntilNewline = true;
      events.push({ type: 'invalid', reason: 'line-too-long' });
    }
    return events;
  }

  reset() {
    this.buffer = '';
    this.discardUntilNewline = false;
  }
}

function encodeCommand(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('Serial command must be an object');
  }
  return `@CMD ${JSON.stringify(message)}\r\n`;
}

module.exports = {
  READY_PREFIX,
  MESSAGE_PREFIX,
  MAX_LINE_LENGTH,
  FIRMWARE_VERSION_RE,
  parseIdentity,
  parseLine,
  SerialLineParser,
  encodeCommand,
};
