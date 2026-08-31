const gxp = require('../../backend/brands/protocols/gxp');

function bytesFromValue(value) {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function isShortUuid(uuid, short) {
  const s = String(uuid || '').toLowerCase().replace(/-/g, '');
  return s.startsWith(`0000${short}`);
}

async function writeCharacteristic(characteristic, data) {
  if (typeof characteristic.writeValueWithResponse === 'function') {
    await characteristic.writeValueWithResponse(data);
    return;
  }
  if (typeof characteristic.writeValue === 'function') {
    await characteristic.writeValue(data);
    return;
  }
  throw new Error('GXP FF03 不支持带响应写入');
}

class GxpBleClient {
  constructor(device, { onEvent = () => {} } = {}) {
    if (!device?.gatt) throw new TypeError('Bluetooth device requires GATT');
    this.device = device;
    this.id = `gxp:${device.id}`;
    this.browserDeviceId = device.id;
    this.onEvent = onEvent;
    this.writeChar = null;
    this.notifyChar = null;
    this.connected = false;
    this.writeChain = Promise.resolve();
    this.onGattDisconnected = () => this.handleGattDisconnected();
    this.onNotification = (event) => this.handleNotification(event);
  }

  async connect() {
    const server = await this.device.gatt.connect();
    try {
      const services = await server.getPrimaryServices();
      for (const service of services) {
        const chars = await service.getCharacteristics();
        for (const ch of chars) {
          if (isShortUuid(ch.uuid, 'ff03')) this.writeChar = ch;
          if (isShortUuid(ch.uuid, 'ff02')) this.notifyChar = ch;
        }
      }
      if (!this.writeChar) throw new Error('未找到 FF03 控制特征');
      if (this.notifyChar?.properties?.notify || this.notifyChar?.properties?.indicate) {
        this.notifyChar.addEventListener('characteristicvaluechanged', this.onNotification);
        await this.notifyChar.startNotifications();
      }
      this.connected = true;
      this.device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
      return {
        id: this.id,
        name: this.device.name || 'gxp艾萝机娘二代',
        type: 'GXP_XA9935',
        brand: 'gxp',
        connectionType: 'brandBle',
        browserDeviceId: this.browserDeviceId,
        data: {
          writeCharacteristic: gxp.WRITE_UUID,
          notifyCharacteristic: gxp.NOTIFY_UUID,
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
      this.onEvent('message', { id: this.id, message: Buffer.from(frame).toString('hex') });
    } catch (error) {
      this.onEvent('error', { id: this.id, operation: 'notification', error: error?.message || String(error) });
    }
  }

  enqueueWrite(operation) {
    const result = this.writeChain.catch(() => {}).then(operation);
    this.writeChain = result;
    return result;
  }

  async send(message) {
    if (message?.method === 'disconnect') {
      await this.disconnect();
      return { ok: true, disconnected: true };
    }
    if (!this.connected) throw new Error(`GXP BLE 未连接: ${this.id}`);
    const values = message?.op === 'writeMany'
      ? message.values
      : message?.op === 'write' ? [message.value] : null;
    if (!Array.isArray(values)) throw new Error('GXP BLE 仅接受 write/writeMany 帧');
    return this.enqueueWrite(async () => {
      for (const value of values) {
        await writeCharacteristic(this.writeChar, Uint8Array.from(value || []));
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
  }
}

module.exports = { GxpBleClient };
