/**
 * 渲染进程侧 DG-LAB 原版 V2（Coyote）蓝牙直连客户端。
 *
 * 与既有 BleDeviceClient（BLUFI）结构对齐：连接 GATT、缓存特征句柄、
 * 通过 onEvent 把属性 / 消息 / 断开事件回传主进程。区别在于：
 *   - 仅面向 DG-LAB V2（Coyote）GATT 服务（955A180B-…），不涉及 BLUFI 自定义协议；
 *   - 写操作以“GATT 操作数组”（来自 protocols/dglabV2.toGattOps）为单位。
 *
 * 该模块运行于 Electron 渲染进程（preload），可安全 require 后端纯函数模块。
 */
const {
  V2_UUIDS,
  V2_CHAR_BY_NAME,
  DGLAB_V2_NAMES,
} = require('../../backend/brands/protocols/dglabV2');

function bytesFromDataView(value) {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function sameUuid(actual, expected) {
  return String(actual || '').toLowerCase() === expected;
}

async function writeCharacteristic(characteristic, value) {
  if (typeof characteristic.writeValueWithResponse === 'function') {
    await characteristic.writeValueWithResponse(value);
    return;
  }
  if (typeof characteristic.writeValue === 'function') {
    await characteristic.writeValue(value);
    return;
  }
  if (typeof characteristic.writeValueWithoutResponse === 'function') {
    await characteristic.writeValueWithoutResponse(value);
    return;
  }
  throw new Error(`Characteristic ${characteristic.uuid} is not writable`);
}

function resolveCharacteristic(chars, name) {
  const uuid = V2_CHAR_BY_NAME[name];
  return uuid ? chars.find((c) => sameUuid(c.uuid, uuid)) : undefined;
}

class BrandBleClient {
  constructor(device, { onEvent = () => {}, modeSwitchDelayMs = 0, nameKeywords = [] } = {}) {
    if (!device?.gatt) throw new TypeError('Bluetooth device requires GATT');
    this.device = device;
    this.id = `dglab-v2-${device.id}`;
    this.browserDeviceId = device.id;
    this.nameKeywords = nameKeywords;
    this.onEvent = onEvent;
    this.modeSwitchDelayMs = modeSwitchDelayMs;
    this.type = 'DGLAB_V2';
    this.connected = false;
    this.chars = {};
    this.notificationListeners = [];
    this.writeChain = Promise.resolve();
    this.disconnectPromise = null;
    this.onGattDisconnected = () => this.handleGattDisconnected();
  }

  async connect() {
    let gattConnected = false;
    this.chars = {};
    try {
      const server = await this.device.gatt.connect();
      gattConnected = true;
      const service = await server.getPrimaryService(V2_UUIDS.service);
      const characteristics = await service.getCharacteristics();

      this.chars.pwmAB2 = resolveCharacteristic(characteristics, 'pwmAB2');
      this.chars.pwmA34 = resolveCharacteristic(characteristics, 'pwmA34');
      this.chars.pwmB34 = resolveCharacteristic(characteristics, 'pwmB34');
      this.chars.battery = resolveCharacteristic(characteristics, 'battery');

      if (!this.chars.pwmAB2) throw new Error('DG-LAB V2 特征 PWM_AB2 未找到');
      if (!this.chars.pwmA34 || !this.chars.pwmB34) {
        throw new Error('DG-LAB V2 波形特征（PWM_A34 / PWM_B34）未找到');
      }

      const data = {};
      let battery = null;
      if (this.chars.battery) {
        try {
          const raw = await this.chars.battery.readValue();
          battery = bytesFromDataView(raw).length ? bytesFromDataView(raw)[0] : null;
          data.battery = battery;
        } catch (_) { /* 电量读取失败不阻断连接 */ }
        if (this.chars.battery.properties.notify) {
          await this.subscribeBattery();
        }
      }

      this.connected = true;
      this.device.addEventListener('gattserverdisconnected', this.onGattDisconnected);

      return {
        id: this.id,
        name: this.device.name || 'DG-LAB V2',
        type: this.type,
        connectionType: 'brandBle',
        browserDeviceId: this.browserDeviceId,
        data,
        properties: [
          { name: 'pwmAB2', type: 'bytes', read: false, write: true, notify: false },
          { name: 'pwmA34', type: 'bytes', read: false, write: true, notify: false },
          { name: 'pwmB34', type: 'bytes', read: false, write: true, notify: false },
          { name: 'battery', type: 'int', read: true, write: false, notify: !!this.chars.battery?.properties.notify },
        ],
      };
    } catch (error) {
      if (gattConnected && this.device.gatt.connected) {
        try { this.device.gatt.disconnect(); } catch (_) {}
      }
      this.connected = false;
      this.cleanupListeners();
      throw error;
    }
  }

  async subscribeBattery() {
    const characteristic = this.chars.battery;
    if (!characteristic?.properties.notify) return;
    const listener = (event) => {
      try {
        const value = bytesFromDataView(event.target.value)[0];
        this.onEvent('property', { id: this.id, key: 'battery', value });
      } catch (error) {
        this.onEvent('error', { id: this.id, operation: 'battery-notification', error: error.message });
      }
    };
    characteristic.addEventListener('characteristicvaluechanged', listener);
    try {
      await characteristic.startNotifications();
      this.notificationListeners.push({ characteristic, listener });
    } catch (error) {
      characteristic.removeEventListener('characteristicvaluechanged', listener);
      this.onEvent('error', { id: this.id, operation: 'subscribe-battery', error: error.message });
    }
  }

  enqueueWrite(operation) {
    const result = this.writeChain.catch(() => {}).then(operation);
    this.writeChain = result;
    return result;
  }

  /**
   * 执行 GATT 操作数组（来自 protocols/dglabV2.toGattOps）。
   * 每个 op：{ characteristic, value?: number[], read?: boolean }
   * value 为十进制数组，写入前转为 Uint8Array。
   * 特殊 op：{ method: 'disconnect' } 触发 GATT 断开。
   */
  async send(message) {
    if (message && message.method === 'disconnect') {
      await this.disconnect();
      return { ok: true, disconnected: true };
    }
    if (!this.connected) throw new Error(`DG-LAB V2 未连接: ${this.id}`);
    const ops = Array.isArray(message) ? message : [message];
    return this.enqueueWrite(async () => {
      for (const op of ops) {
        const characteristic = this.chars[op.characteristic];
        if (!characteristic) throw new Error(`未知的 DG-LAB V2 特征: ${op.characteristic}`);
        if (op.read) {
          const raw = await characteristic.readValue();
          const value = bytesFromDataView(raw);
          this.onEvent('property', {
            id: this.id,
            key: op.characteristic,
            value: value.length === 1 ? value[0] : Array.from(value),
          });
          continue;
        }
        if (!Array.isArray(op.value)) {
          throw new Error(`DG-LAB V2 写操作缺少 value: ${op.characteristic}`);
        }
        await writeCharacteristic(characteristic, Uint8Array.from(op.value));
      }
      return { ok: true };
    });
  }

  async disconnect() {
    if (this.disconnectPromise) return this.disconnectPromise;
    this.disconnectPromise = this.performDisconnect();
    try {
      return await this.disconnectPromise;
    } finally {
      this.disconnectPromise = null;
    }
  }

  async performDisconnect() {
    try {
      if (this.connected) {
        try { await this.writeChain.catch(() => {}); } catch (_) {}
      }
      if (this.device.gatt?.connected) this.device.gatt.disconnect();
    } finally {
      this.connected = false;
      this.cleanupListeners();
      this.onEvent('disconnected', { id: this.id });
    }
  }

  handleGattDisconnected() {
    if (!this.connected) return;
    this.connected = false;
    this.cleanupListeners();
    this.onEvent('disconnected', { id: this.id });
  }

  cleanupListeners() {
    this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    for (const { characteristic, listener } of this.notificationListeners) {
      characteristic.removeEventListener('characteristicvaluechanged', listener);
    }
    this.notificationListeners = [];
  }
}

module.exports = {
  BrandBleClient,
  V2_UUIDS,
  V2_CHAR_BY_NAME,
  DGLAB_V2_NAMES,
};
