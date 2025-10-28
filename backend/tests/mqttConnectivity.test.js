const net = require('net');
const mqttService = require('../services/mqttService');

jest.setTimeout(15000);

function encodeRemainingLength(value) {
  const bytes = [];
  do {
    let encodedByte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) encodedByte |= 0x80;
    bytes.push(encodedByte);
  } while (value > 0);
  return Buffer.from(bytes);
}

function buildConnectPacket(clientId = `jestClient_${Date.now()}`) {
  const protoName = Buffer.from('MQTT');
  const vh = Buffer.concat([
    Buffer.from([0x00, protoName.length]), // Protocol Name length
    protoName,                              // "MQTT"
    Buffer.from([0x04]),                    // Protocol Level 4 (MQTT 3.1.1)
    Buffer.from([0x02]),                    // Connect Flags: Clean Session
    Buffer.from([0x00, 0x3C]),              // Keep Alive: 60 seconds
  ]);

  const idBuf = Buffer.from(clientId);
  const payload = Buffer.concat([
    Buffer.from([0x00, idBuf.length]),
    idBuf,
  ]);

  const remainingLength = vh.length + payload.length; // fixed header not included
  const fixedHeader = Buffer.concat([
    Buffer.from([0x10]), // CONNECT packet type
    encodeRemainingLength(remainingLength),
  ]);

  return Buffer.concat([fixedHeader, vh, payload]);
}

function waitForPort(host, port, deadlineMs = 6000, stepMs = 200) {
  const end = Date.now() + deadlineMs;
  return new Promise(async (resolve, reject) => {
    while (Date.now() < end) {
      const ok = await new Promise((r) => {
        const s = net.connect({ host, port });
        let settled = false;
        const finish = (val) => { if (settled) return; settled = true; try { s.destroy(); } catch (_) {} r(val); };
        s.once('connect', () => finish(true));
        s.once('error', () => finish(false));
        s.setTimeout(stepMs, () => finish(false));
      });
      if (ok) return resolve(true);
      await new Promise((r) => setTimeout(r, stepMs));
    }
    reject(new Error(`Port ${port} on ${host} did not become ready`));
  });
}

function performHandshake(host, port, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let timer = setTimeout(() => {
      try { sock.destroy(); } catch (_) {}
      reject(new Error('Handshake timed out'));
    }, timeoutMs);

    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Socket error: ${err && err.message}`));
    });

    sock.once('connect', () => {
      const pkt = buildConnectPacket();
      sock.write(pkt);
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // Expect at least 4 bytes for CONNACK in MQTT 3.1.1: 0x20, 0x02, flags, returnCode
      if (buf.length >= 4) {
        const type = buf[0] & 0xF0;
        const rl = buf[1];
        const sessionPresent = buf[2];
        const returnCode = buf[3];
        clearTimeout(timer);
        try { sock.end(); } catch (_) {}
        if (type !== 0x20) return reject(new Error(`Expected CONNACK (0x20), got 0x${type.toString(16)}`));
        if (rl !== 0x02) return reject(new Error(`Expected remaining length 0x02, got 0x${rl.toString(16)}`));
        if (returnCode !== 0x00) return reject(new Error(`CONNACK return code not success: 0x${returnCode.toString(16)}`));
        return resolve({ sessionPresent: (sessionPresent & 0x01) === 1 });
      }
    });
  });
}

describe('MQTT protocol handshake', () => {
  afterEach(() => {
    try { mqttService.stop(); } catch (_) {}
  });

  it('CONNECT -> CONNACK should succeed on started broker', async () => {
    // Use a non-default port to avoid conflicts with any existing broker
    const port = 1884;
    mqttService.start({ port, bind: '127.0.0.1' });

    await waitForPort('127.0.0.1', port, 8000, 250); // if not ready -> throws
    const res = await performHandshake('127.0.0.1', port, 6000);
    expect(typeof res.sessionPresent).toBe('boolean');
  });
});