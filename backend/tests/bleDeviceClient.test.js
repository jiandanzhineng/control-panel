const { BleDeviceClient } = require('../../electron/ble/deviceClient');
const { BLE_UUIDS } = require('../../electron/ble/protocol');

function dataView(bytes) {
  const value = Uint8Array.from(bytes);
  return new DataView(value.buffer);
}

function textView(value) {
  return dataView(new TextEncoder().encode(value));
}

function characteristic(uuid, {
  name,
  value = [0, 0, 0, 0],
  text,
  readError,
  notifyValue,
  read = false,
  write = false,
  notify = false,
} = {}) {
  const listeners = new Map();
  return {
    uuid,
    properties: { read, write, writeWithoutResponse: false, notify },
    writes: [],
    async getDescriptors() {
      if (!name) return [];
      return [{ uuid: BLE_UUIDS.userDescription, readValue: async () => textView(name) }];
    },
    async readValue() {
      if (readError) throw readError;
      if (text !== undefined) return textView(text);
      return name === 'device_type' ? textView('TD01') : dataView(value);
    },
    async writeValueWithResponse(bytes) {
      this.writes.push([...new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)]);
    },
    addEventListener(event, handler) {
      listeners.set(event, handler);
    },
    removeEventListener(event) {
      listeners.delete(event);
    },
    async startNotifications() {
      if (notifyValue) this.emit(notifyValue);
      return this;
    },
    emit(bytes) {
      listeners.get('characteristicvaluechanged')?.({ target: { value: dataView(bytes) } });
    },
  };
}

describe('Electron BLE device client', () => {
  it('admits firmware service, routes updates, and emits property notifications', async () => {
    const mode = characteristic(BLE_UUIDS.mode, { write: true });
    const message = characteristic(BLE_UUIDS.message, { read: true, notify: true });
    const command = characteristic(BLE_UUIDS.command, { write: true });
    const deviceType = characteristic('0000ff10-0000-1000-8000-00805f9b34fb', {
      name: 'device_type', read: true,
    });
    const power = characteristic('0000ff11-0000-1000-8000-00805f9b34fb', {
      name: 'power', value: [0, 0, 0, 0], read: true, write: true, notify: true,
    });
    const gameDuration = characteristic('0000ff12-0000-1000-8000-00805f9b34fb', {
      name: 'game_duration', value: [30, 0, 0, 0], read: true, notify: true,
    });
    const line1Text = characteristic('0000ff13-0000-1000-8000-00805f9b34fb', {
      name: 'line1_text', text: 'Ready', read: true, notify: true,
    });
    const pressure1 = characteristic('0000ff14-0000-1000-8000-00805f9b34fb', {
      name: 'pressure1',
      read: true,
      notify: true,
      readError: new Error('GATT busy'),
      notifyValue: [0, 0, 32, 64],
    });
    const service = {
      getCharacteristics: async () => [
        message, mode, command, deviceType, power, gameDuration, line1Text, pressure1,
      ],
    };
    const server = { getPrimaryService: jest.fn(async () => service) };
    const disconnectListeners = new Map();
    const device = {
      id: 'esp32-c3-browser-id',
      name: 'BLUFI',
      gatt: {
        connected: false,
        connect: jest.fn(async () => {
          device.gatt.connected = true;
          return server;
        }),
        disconnect: jest.fn(() => {
          device.gatt.connected = false;
        }),
      },
      addEventListener: jest.fn((event, handler) => disconnectListeners.set(event, handler)),
      removeEventListener: jest.fn((event) => disconnectListeners.delete(event)),
    };
    const events = [];
    const client = new BleDeviceClient(device, {
      modeSwitchDelayMs: 0,
      onEvent: (event, payload) => events.push({ event, payload }),
    });

    const connected = await client.connect();
    expect(connected).toMatchObject({
      id: 'ble:esp32-c3-browser-id',
      name: 'BLUFI',
      type: 'TD01',
      connectionType: 'ble',
      data: {
        device_type: 'TD01',
        power: 0,
        game_duration: 30,
        line1_text: 'Ready',
        pressure1: 2.5,
      },
      firmwareVersion: null,
      legacyIdentity: true,
      browserDeviceId: 'esp32-c3-browser-id',
    });
    expect(server.getPrimaryService).toHaveBeenCalledWith(BLE_UUIDS.service);
    expect(mode.writes).toEqual([[1]]);

    await client.send({ method: 'update', power: 128 });
    expect(power.writes).toEqual([[128, 0, 0, 0]]);

    power.emit([64, 0, 0, 0]);
    gameDuration.emit([45, 0, 0, 0]);
    line1Text.emit(new TextEncoder().encode('Running'));
    expect(events).toContainEqual({
      event: 'property',
      payload: { id: 'ble:esp32-c3-browser-id', key: 'power', value: 64 },
    });
    expect(events).toContainEqual({
      event: 'property',
      payload: { id: 'ble:esp32-c3-browser-id', key: 'game_duration', value: 45 },
    });
    expect(events).toContainEqual({
      event: 'property',
      payload: { id: 'ble:esp32-c3-browser-id', key: 'line1_text', value: 'Running' },
    });

    await client.disconnect();
    expect(mode.writes.at(-1)).toEqual([0]);
    expect(device.gatt.disconnect).toHaveBeenCalled();
  });

  it('uses the firmware identity instead of the Chromium device id', async () => {
    const mode = characteristic(BLE_UUIDS.mode, { write: true });
    const command = characteristic(BLE_UUIDS.command, { write: true });
    const identity = characteristic(BLE_UUIDS.identity, {
      read: true,
      text: JSON.stringify({
        device_id: 'aabbccddeeff',
        firmware_version: 'v1.1.38',
      }),
    });
    const deviceType = characteristic('0000ff10-0000-1000-8000-00805f9b34fb', {
      name: 'device_type', read: true,
    });
    const device = {
      id: 'chromium-private-id',
      name: 'BLUFI',
      gatt: {
        connected: false,
        connect: jest.fn(async () => {
          device.gatt.connected = true;
          return {
            getPrimaryService: async () => ({
              getCharacteristics: async () => [mode, command, identity, deviceType],
            }),
          };
        }),
        disconnect: jest.fn(() => { device.gatt.connected = false; }),
      },
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    const client = new BleDeviceClient(device, { modeSwitchDelayMs: 0 });
    await expect(client.connect()).resolves.toMatchObject({
      id: 'aabbccddeeff',
      firmwareVersion: 'v1.1.38',
      legacyIdentity: false,
      browserDeviceId: 'chromium-private-id',
      data: { ver: 'v1.1.38' },
    });
  });

  it('rejects a present but malformed identity characteristic', async () => {
    const mode = characteristic(BLE_UUIDS.mode, { write: true });
    const command = characteristic(BLE_UUIDS.command, { write: true });
    const identity = characteristic(BLE_UUIDS.identity, {
      read: true,
      text: '{"device_id":"bad"}',
    });
    const device = {
      id: 'chromium-private-id',
      name: 'BLUFI',
      gatt: {
        connected: true,
        connect: jest.fn(async () => ({
          getPrimaryService: async () => ({
            getCharacteristics: async () => [mode, command, identity],
          }),
        })),
        disconnect: jest.fn(() => { device.gatt.connected = false; }),
      },
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    const client = new BleDeviceClient(device, { modeSwitchDelayMs: 0 });
    await expect(client.connect()).rejects.toThrow(/device_id/);
    expect(mode.writes).toEqual([]);
    expect(device.gatt.disconnect).toHaveBeenCalled();
  });

  it('restores WiFi mode when GATT admission fails after switching modes', async () => {
    const mode = characteristic(BLE_UUIDS.mode, { write: true });
    const command = characteristic(BLE_UUIDS.command, { write: true });
    const service = { getCharacteristics: async () => [mode, command] };
    const device = {
      id: 'unsupported-device',
      name: 'BLUFI',
      gatt: {
        connected: true,
        connect: jest.fn(async () => ({
          getPrimaryService: async () => service,
        })),
        disconnect: jest.fn(() => {
          device.gatt.connected = false;
        }),
      },
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    const client = new BleDeviceClient(device, { modeSwitchDelayMs: 0 });

    await expect(client.connect()).rejects.toThrow(/device_type/);

    expect(mode.writes).toEqual([[1], [0]]);
    expect(device.gatt.disconnect).toHaveBeenCalled();
  });

  it('makes concurrent callers wait for the same safe disconnect', async () => {
    const mode = characteristic(BLE_UUIDS.mode, { write: true });
    const command = characteristic(BLE_UUIDS.command, { write: true });
    const deviceType = characteristic('0000ff10-0000-1000-8000-00805f9b34fb', {
      name: 'device_type', read: true,
    });
    let releaseModeWrite;
    const writeMode = mode.writeValueWithResponse.bind(mode);
    mode.writeValueWithResponse = async (bytes) => {
      await writeMode(bytes);
      if (bytes[0] === 0) {
        await new Promise((resolve) => { releaseModeWrite = resolve; });
      }
    };
    const device = {
      id: 'concurrent-disconnect',
      name: 'BLUFI',
      gatt: {
        connected: false,
        connect: jest.fn(async () => {
          device.gatt.connected = true;
          return {
            getPrimaryService: async () => ({
              getCharacteristics: async () => [mode, command, deviceType],
            }),
          };
        }),
        disconnect: jest.fn(() => { device.gatt.connected = false; }),
      },
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    const client = new BleDeviceClient(device, { modeSwitchDelayMs: 0 });
    await client.connect();

    const first = client.disconnect();
    while (!releaseModeWrite) await Promise.resolve();
    let secondFinished = false;
    const second = client.disconnect().then(() => { secondFinished = true; });
    await Promise.resolve();

    expect(secondFinished).toBe(false);
    releaseModeWrite();
    await Promise.all([first, second]);
    expect(mode.writes).toEqual([[1], [0]]);
    expect(device.gatt.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('役次元型号分类', () => {
  const { resolveType } = require('../../electron/ble/ycyDeviceClient');

  test('未知型号默认电击型，YISK 识别为灌肠型', () => {
    expect(resolveType('YSKJ-2024')).toBe('YCY_EMS');
    expect(resolveType('YYC-DJ-V2')).toBe('YCY_EMS');
    expect(resolveType('YISK-003V3')).toBe('YCY_ENEMA');
    expect(resolveType('YCY-FJB-03')).toBe('YCY_CUP');
  });
});
