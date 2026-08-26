/**
 * 渲染进程役次元 Web Bluetooth 客户端。
 * 发现可写特征后，接收 { op:'write', value:number[] } 下发 0x35 帧。
 */
const WRITE_HINTS = ['ff41', 'ff31', 'ff71', 'ae01'];

function sameUuid(actual, expected) {
  return String(actual || '').toLowerCase().includes(expected);
}

async function writeCharacteristic(characteristic, value) {
  const data = Uint8Array.from(value);
  if (characteristic.properties?.writeWithoutResponse && characteristic.writeValueWithoutResponse) {
    await characteristic.writeValueWithoutResponse(data);
    return;
  }
  if (characteristic.writeValueWithResponse) {
    await characteristic.writeValueWithResponse(data);
    return;
  }
  await characteristic.writeValue(data);
}

function resolveType(name) {
  const n = String(name || '');
  if (/灌肠|enema|glj/i.test(n)) return 'YCY_ENEMA';
  if (/杯|cup|fjb/i.test(n)) return 'YCY_CUP';
  if (/toy|玩具|tdd|电机/i.test(n)) return 'YCY_TOY';
  if (/dj|ems|电击/i.test(n)) return 'YCY_EMS';
  return 'YCY_CUP';
}

class YcyBleClient {
  constructor(device, { onEvent = () => {} } = {}) {
    if (!device?.gatt) throw new TypeError('Bluetooth device requires GATT');
    this.device = device;
    this.id = `ycy:${device.id}`;
    this.browserDeviceId = device.id;
    this.onEvent = onEvent;
    this.writeChar = null;
    this.connected = false;
    this.onGattDisconnected = () => {
      this.connected = false;
      this.onEvent('disconnected', { id: this.id });
    };
  }

  async connect() {
    const server = await this.device.gatt.connect();
    this.device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    const services = await server.getPrimaryServices();
    const chars = [];
    for (const service of services) {
      try { chars.push(...await service.getCharacteristics()); } catch (_) { /* 部分服务不可读 */ }
    }
    for (const hint of WRITE_HINTS) {
      const hit = chars.find((c) => sameUuid(c.uuid, hint)
        && (c.properties.write || c.properties.writeWithoutResponse));
      if (hit) { this.writeChar = hit; break; }
    }
    if (!this.writeChar) {
      this.writeChar = chars.find((c) => c.properties.writeWithoutResponse || c.properties.write);
    }
    if (!this.writeChar) throw new Error('未找到役次元可写特征');
    this.connected = true;
    return {
      id: this.id,
      name: this.device.name || '役次元设备',
      type: resolveType(this.device.name),
      brand: 'ycy',
      connectionType: 'brandBle',
      browserDeviceId: this.browserDeviceId,
      data: {},
    };
  }

  async send(message) {
    if (message?.method === 'disconnect') return this.disconnect();
    if (message?.op === 'write' && message.value) {
      await writeCharacteristic(this.writeChar, message.value);
      return { ok: true };
    }
    throw new Error('役次元 WebBLE 仅接受 write 帧');
  }

  async disconnect() {
    try { this.device.gatt?.disconnect(); } catch (_) { /* 已断开 */ }
    this.connected = false;
    this.writeChar = null;
  }
}

module.exports = { YcyBleClient, resolveType };
