const sosexy = require('../../backend/brands/protocols/sosexy');

function bytesFromValue(value) {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseProperties(payload) {
  const bytes = payload instanceof Uint8Array ? payload : Uint8Array.from(payload || []);
  if (bytes[0] !== 0) return null;
  let offset = 1;
  const count = bytes[offset++];
  const result = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 3 > bytes.length) return null;
    const id = (bytes[offset] << 8) | bytes[offset + 1];
    const descriptor = bytes[offset + 2];
    offset += 3;
    const length = descriptor === 0xaf ? 15 : (descriptor & 0x0f);
    if (!length || offset + length > bytes.length) return null;
    result.push({ id, descriptor, value: bytes.slice(offset, offset + length) });
    offset += length;
  }
  return result;
}

function emitProperty(onEvent, id, bytes) {
  const value = bytes.length === 1 ? bytes[0]
    : bytes.length === 2 ? ((bytes[0] << 8) | bytes[1])
      : Array.from(bytes);
  const keys = {
    0x0001: 'vibration',
    0x0002: 'vibrationMode',
    0x0003: 'shock',
    0x0004: 'shockMode',
    0x0005: 'battery',
    0x0007: 'suction',
    0x0008: 'suctionMode',
    0x0009: 'outOfControlMinutes',
    0x000a: 'outOfControlRemaining',
    0x000b: 'outOfControlMask',
    0x000d: 'light',
    0x000e: 'microcurrentProtection',
  };
  const key = keys[id];
  if (key) onEvent('property', { key, value });
}

class SosexyBleClient {
  constructor(device, { onEvent = () => {} } = {}) {
    if (!device?.gatt) throw new TypeError('Bluetooth device requires GATT');
    this.device = device;
    this.id = `sosexy:${device.id}`;
    this.browserDeviceId = device.id;
    this.onEvent = onEvent;
    this.writeChar = null;
    this.notifyChar = null;
    this.connected = false;
    this.writeChain = Promise.resolve();
    this.packetBuffers = new Map();
    this.onGattDisconnected = () => this.handleGattDisconnected();
    this.onNotification = (event) => this.handleNotification(event);
  }

  async connect() {
    const server = await this.device.gatt.connect();
    try {
      const service = await server.getPrimaryService(sosexy.SERVICE_UUID);
      this.writeChar = await service.getCharacteristic(sosexy.WRITE_UUID);
      this.notifyChar = await service.getCharacteristic(sosexy.NOTIFY_UUID);
      if (!this.writeChar?.properties?.write && !this.writeChar?.properties?.writeWithoutResponse) {
        throw new Error('SOSEXY EE03 不可写');
      }
      if (this.notifyChar?.properties?.notify || this.notifyChar?.properties?.indicate) {
        this.notifyChar.addEventListener('characteristicvaluechanged', this.onNotification);
        await this.notifyChar.startNotifications();
      }
      this.connected = true;
      this.device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
      return {
        id: this.id,
        name: this.device.name || 'SOSEXY PID 0004',
        type: 'SOSEXY_PID0004',
        brand: 'sosexy',
        connectionType: 'brandBle',
        browserDeviceId: this.browserDeviceId,
        data: {
          pid: '0004',
          service: sosexy.SERVICE_UUID,
          writeCharacteristic: sosexy.WRITE_UUID,
          notifyCharacteristic: sosexy.NOTIFY_UUID,
        },
      };
    } catch (error) {
      try { this.device.gatt?.disconnect(); } catch (_) {}
      this.cleanupListeners();
      throw error;
    }
  }

  handleNotification(event) {
    try {
      const frame = bytesFromValue(event.target.value);
      if (frame.length < 2) return;
      const messageId = frame[0];
      const sequence = frame[1];
      let state = this.packetBuffers.get(messageId);
      if (!state || sequence !== state.nextSequence) {
        state = { nextSequence: sequence, chunks: [] };
      }
      state.nextSequence = sequence + 1;
      state.chunks.push(frame.slice(2));
      this.packetBuffers.set(messageId, state);
      if (frame.length >= 20) return;
      this.packetBuffers.delete(messageId);
      const properties = parseProperties(Uint8Array.from(state.chunks.flatMap((chunk) => Array.from(chunk))));
      for (const item of properties || []) emitProperty((key, payload) => {
        this.onEvent(key, { id: this.id, ...payload });
      }, item.id, item.value);
    } catch (error) {
      this.onEvent('error', { id: this.id, operation: 'notification', error: error?.message || String(error) });
    }
  }

  enqueueWrite(operation) {
    const result = this.writeChain.catch(() => {}).then(operation);
    this.writeChain = result;
    return result;
  }

  async writeValue(value) {
    const data = Uint8Array.from(value || []);
    if (this.writeChar.properties?.writeWithoutResponse && this.writeChar.writeValueWithoutResponse) {
      await this.writeChar.writeValueWithoutResponse(data);
    } else if (this.writeChar.writeValueWithResponse) {
      await this.writeChar.writeValueWithResponse(data);
    } else {
      await this.writeChar.writeValue(data);
    }
  }

  async send(message) {
    if (message?.method === 'disconnect') {
      await this.disconnect();
      return { ok: true, disconnected: true };
    }
    if (!this.connected) throw new Error(`SOSEXY BLE 未连接: ${this.id}`);
    const values = message?.op === 'writeMany'
      ? message.values
      : message?.op === 'write' ? [message.value] : null;
    if (!Array.isArray(values)) throw new Error('SOSEXY BLE 仅接受 write/writeMany 帧');
    return this.enqueueWrite(async () => {
      for (let i = 0; i < values.length; i += 1) {
        await this.writeValue(values[i]);
        if (i + 1 < values.length) await sleep(30);
      }
      return { ok: true };
    });
  }

  async disconnect() {
    try { await this.writeChain.catch(() => {}); } catch (_) {}
    try { this.device.gatt?.disconnect(); } catch (_) {}
    this.connected = false;
    this.cleanupListeners();
    this.onEvent('disconnected', { id: this.id });
  }

  handleGattDisconnected() {
    if (!this.connected) return;
    this.connected = false;
    this.cleanupListeners();
    this.onEvent('disconnected', { id: this.id });
  }

  cleanupListeners() {
    this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    this.notifyChar?.removeEventListener('characteristicvaluechanged', this.onNotification);
    this.packetBuffers.clear();
  }
}

module.exports = { SosexyBleClient, parseProperties };
