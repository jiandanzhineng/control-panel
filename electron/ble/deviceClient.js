const {
  BLE_UUIDS,
  decodeIdentity,
  decodeMessage,
  decodePropertyValue,
  encodeMessage,
  encodePropertyValue,
  propertyType,
} = require('./protocol');

const SAFE_DISCONNECT_PROPERTIES = Object.freeze({
  PJ01: { power: 0 },
  TD01: { power: 0 },
  OSR6: { power: 0 },
  QIYA: { report_delay_ms: 5000 },
  DIANJI: { shock: 0, voltage: 0 },
  ZIDONGSUO: { open: 1 },
  QTZ: { report_delay_ms: 10000 },
  DZC01: { report_delay_ms: 5000 },
  CUNZHI01: {
    game_mode: 0,
    shock: 0,
    voltage: 0,
    power: 0,
    report_delay_ms: 5000,
  },
});

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

class BleDeviceClient {
  constructor(device, { onEvent = () => {}, modeSwitchDelayMs = 200 } = {}) {
    if (!device?.gatt) throw new TypeError('Bluetooth device requires GATT');
    this.device = device;
    this.id = `ble:${device.id}`;
    this.browserDeviceId = device.id;
    this.firmwareVersion = null;
    this.legacyIdentity = true;
    this.onEvent = onEvent;
    this.modeSwitchDelayMs = modeSwitchDelayMs;
    this.type = '';
    this.connected = false;
    this.modeCharacteristic = null;
    this.messageCharacteristic = null;
    this.commandCharacteristic = null;
    this.properties = new Map();
    this.reportedValues = {};
    this.notificationListeners = [];
    this.writeChain = Promise.resolve();
    this.disconnectPromise = null;
    this.onGattDisconnected = () => this.handleGattDisconnected();
  }

  async connect() {
    let modeEnabled = false;
    this.reportedValues = {};
    try {
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService(BLE_UUIDS.service);
      const characteristics = await service.getCharacteristics();

      this.modeCharacteristic = characteristics.find((item) => sameUuid(item.uuid, BLE_UUIDS.mode));
      this.messageCharacteristic = characteristics.find((item) => sameUuid(item.uuid, BLE_UUIDS.message));
      this.commandCharacteristic = characteristics.find((item) => sameUuid(item.uuid, BLE_UUIDS.command));
      const identityCharacteristic = characteristics.find((item) => sameUuid(item.uuid, BLE_UUIDS.identity));
      if (!this.modeCharacteristic) throw new Error('Characteristic 0xFF02 not found');
      if (!this.commandCharacteristic) throw new Error('Characteristic 0xFF03 not found');

      if (identityCharacteristic) {
        if (!identityCharacteristic.properties.read) {
          throw new Error('Characteristic 0xFF04 is not readable');
        }
        const identity = decodeIdentity(
          bytesFromDataView(await identityCharacteristic.readValue()),
        );
        this.id = identity.deviceId;
        this.firmwareVersion = identity.firmwareVersion;
        this.legacyIdentity = false;
      }

      await writeCharacteristic(this.modeCharacteristic, Uint8Array.of(1));
      modeEnabled = true;
      if (this.modeSwitchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.modeSwitchDelayMs));
      }

      await this.discoverProperties(characteristics);
      const deviceType = this.properties.get('device_type');
      if (!deviceType?.characteristic.properties.read) {
        throw new Error('Readable device_type property not found');
      }
      this.type = decodePropertyValue(
        'device_type',
        bytesFromDataView(await deviceType.characteristic.readValue()),
      );
      if (!this.type) throw new Error('device_type is empty');

      await this.subscribeMessageChannel();
      const data = await this.readInitialValues();
      if (this.firmwareVersion) data.ver = this.firmwareVersion;
      this.connected = true;
      this.device.addEventListener('gattserverdisconnected', this.onGattDisconnected);

      return {
        id: this.id,
        name: this.device.name || this.type,
        type: this.type,
        connectionType: 'ble',
        firmwareVersion: this.firmwareVersion,
        legacyIdentity: this.legacyIdentity,
        browserDeviceId: this.browserDeviceId,
        data,
        properties: [...this.properties.values()].map((entry) => ({
          name: entry.name,
          type: propertyType(entry.name),
          read: !!entry.characteristic.properties.read,
          write: !!(entry.characteristic.properties.write || entry.characteristic.properties.writeWithoutResponse),
          notify: !!entry.characteristic.properties.notify,
        })),
      };
    } catch (error) {
      if (modeEnabled && this.modeCharacteristic) {
        try { await writeCharacteristic(this.modeCharacteristic, Uint8Array.of(0)); } catch (_) {}
      }
      if (this.device.gatt.connected) {
        try { this.device.gatt.disconnect(); } catch (_) {}
      }
      this.connected = false;
      this.cleanupListeners();
      throw error;
    }
  }

  async discoverProperties(characteristics) {
    this.properties.clear();
    for (const characteristic of characteristics) {
      if (
        sameUuid(characteristic.uuid, BLE_UUIDS.mode)
        || sameUuid(characteristic.uuid, BLE_UUIDS.message)
        || sameUuid(characteristic.uuid, BLE_UUIDS.command)
        || sameUuid(characteristic.uuid, BLE_UUIDS.identity)
      ) {
        continue;
      }

      let descriptors = [];
      try {
        descriptors = await characteristic.getDescriptors(BLE_UUIDS.userDescription);
      } catch (_) {
        try { descriptors = await characteristic.getDescriptors(); } catch (_) {}
      }
      const descriptor = descriptors.find((item) => sameUuid(item.uuid, BLE_UUIDS.userDescription));
      if (!descriptor) continue;
      const name = new TextDecoder().decode(bytesFromDataView(await descriptor.readValue())).trim();
      if (!name) continue;

      this.properties.set(name, { name, characteristic });
      // Firmware emits per-property notifications in BLE mode rather than an
      // aggregate report, so every readable/notifiable property participates
      // in the client-side report snapshot.
      if (characteristic.properties.notify) {
        await this.subscribeProperty(name, characteristic);
      }
    }
  }

  async subscribeProperty(name, characteristic) {
    const listener = (event) => {
      try {
        const value = decodePropertyValue(name, bytesFromDataView(event.target.value));
        this.reportedValues[name] = value;
        this.onEvent('property', { id: this.id, key: name, value });
      } catch (error) {
        this.onEvent('error', { id: this.id, operation: 'property-notification', error: error.message });
      }
    };
    characteristic.addEventListener('characteristicvaluechanged', listener);
    try {
      await characteristic.startNotifications();
      this.notificationListeners.push({ characteristic, listener });
    } catch (error) {
      characteristic.removeEventListener('characteristicvaluechanged', listener);
      this.onEvent('error', { id: this.id, operation: 'subscribe-property', property: name, error: error.message });
    }
  }

  async subscribeMessageChannel() {
    const characteristic = this.messageCharacteristic;
    if (!characteristic?.properties.notify) return;
    const listener = (event) => {
      try {
        const message = decodeMessage(bytesFromDataView(event.target.value));
        if (message) this.onEvent('message', { id: this.id, message });
      } catch (error) {
        this.onEvent('error', { id: this.id, operation: 'message-notification', error: error.message });
      }
    };
    characteristic.addEventListener('characteristicvaluechanged', listener);
    try {
      await characteristic.startNotifications();
      this.notificationListeners.push({ characteristic, listener });
    } catch (error) {
      characteristic.removeEventListener('characteristicvaluechanged', listener);
      this.onEvent('error', { id: this.id, operation: 'subscribe-message', error: error.message });
    }
  }

  async readInitialValues() {
    const data = {};
    for (const [name, entry] of this.properties) {
      if (!entry?.characteristic.properties.read) continue;
      try {
        data[name] = decodePropertyValue(
          name,
          bytesFromDataView(await entry.characteristic.readValue()),
        );
      } catch (error) {
        this.onEvent('error', { id: this.id, operation: 'initial-read', property: name, error: error.message });
      }
    }
    // Notifications can arrive before the backend has registered the device,
    // and a busy sensor can make a concurrent GATT read fail. Preserve those
    // values in the initial report, preferring the newer notification value.
    Object.assign(data, this.reportedValues);
    this.reportedValues = { ...data };
    return data;
  }

  enqueueWrite(operation) {
    const result = this.writeChain.catch(() => {}).then(operation);
    this.writeChain = result;
    return result;
  }

  async send(message) {
    if (!this.connected) throw new Error(`BLE device is not connected: ${this.id}`);
    if (message?.method === 'update') {
      const updates = Object.entries(message).filter(([key]) => key !== 'method');
      return this.enqueueWrite(async () => {
        for (const [name, value] of updates) {
          const entry = this.properties.get(name);
          if (!entry) throw new Error(`BLE property not found: ${name}`);
          if (!(entry.characteristic.properties.write || entry.characteristic.properties.writeWithoutResponse)) {
            throw new Error(`BLE property is not writable: ${name}`);
          }
          await writeCharacteristic(entry.characteristic, encodePropertyValue(name, value));
        }
      });
    }

    return this.enqueueWrite(() => writeCharacteristic(
      this.commandCharacteristic,
      encodeMessage(message),
    ));
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
        const safe = SAFE_DISCONNECT_PROPERTIES[this.type] || {};
        const supported = Object.fromEntries(
          Object.entries(safe).filter(([name]) => this.properties.has(name)),
        );
        if (Object.keys(supported).length > 0) {
          try { await this.send({ method: 'update', ...supported }); } catch (_) {}
        }
        try {
          await this.writeChain.catch(() => {});
          await writeCharacteristic(this.modeCharacteristic, Uint8Array.of(0));
        } catch (_) {}
      }
      if (this.device.gatt.connected) this.device.gatt.disconnect();
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
  BleDeviceClient,
  SAFE_DISCONNECT_PROPERTIES,
};
