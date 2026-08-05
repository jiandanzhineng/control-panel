jest.mock('../services/mqttClientService', () => ({
  publish: jest.fn(),
}));

jest.mock('../utils/fileStorage', () => ({
  getItem: jest.fn(() => null),
  setItem: jest.fn(),
}));

jest.mock('../services/logService', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../services/nicknameService', () => ({
  getNickname: jest.fn(() => null),
}));

jest.mock('../services/firmwareOtaService', () => ({
  recordOtaStatus: jest.fn(),
}));

const deviceService = require('../services/deviceService');
const deviceConnections = require('../services/deviceConnectionService');
const fileStorage = require('../utils/fileStorage');

describe('device transport routing', () => {
  beforeEach(() => {
    deviceService.state.devices = [];
    deviceService.clearRuntimeTransports();
    deviceService.stopOfflineCheck();
    fileStorage.getItem.mockReturnValue(null);
  });

  it('routes an existing device operation through its connected BLE transport', () => {
    const sent = [];
    deviceService.connectTransportDevice({
      id: 'ble:esp32-c3',
      name: '偏轴电机控制器-C3',
      type: 'TD01',
      connectionType: 'ble',
      data: { battery: 91, power: 0 },
    }, {
      send(message) {
        sent.push(message);
      },
    });

    expect(deviceService.getDeviceForApi('ble:esp32-c3')).toMatchObject({
      id: 'ble:esp32-c3',
      type: 'TD01',
      connected: true,
      connectionType: 'ble',
      data: { battery: 91, power: 0 },
    });

    deviceService.executeDeviceOperation('ble:esp32-c3', 'start');

    expect(sent).toEqual([{ method: 'update', power: 255 }]);
  });

  it('ignores persisted runtime connection fields from old records', () => {
    fileStorage.getItem.mockReturnValue(JSON.stringify([{
      id: 'old-device', name: 'saved', type: 'TD01', data: { power: 3 },
      connected: true, connectionType: 'ble', controlConnection: 'ble',
      connections: [{ type: 'ble' }],
    }]));
    deviceService.initDeviceList();
    expect(deviceService.getDeviceForApi('old-device')).toMatchObject({
      id: 'old-device', name: 'saved', type: 'TD01', data: { power: 3 },
      connected: false, connectionType: null, controlConnection: null, connections: [],
    });
    deviceService.stopOfflineCheck();
  });

  it('publishes BLE property changes and disconnect state through the device API', () => {
    const changes = [];
    deviceService.onDeviceDataChange((event) => changes.push(event));
    deviceService.connectTransportDevice({
      id: 'ble:esp32-c3',
      name: '偏轴电机控制器-C3',
      type: 'TD01',
      connectionType: 'ble',
      data: { power: 0 },
    }, { send() {} });

    deviceService.handleTransportProperty(
      'ble:esp32-c3',
      'power',
      128,
      'ble',
    );
    deviceService.disconnectTransportDevice('ble:esp32-c3', 'ble');

    expect(deviceService.getDeviceForApi('ble:esp32-c3')).toMatchObject({
      connected: false,
      connectionType: null,
      controlConnection: null,
      connections: [],
      data: { power: 128 },
    });
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        deviceId: 'ble:esp32-c3',
        changes: { power: { old: 0, new: 128 } },
      }),
    ]));
  });

  it('merges MQTT, serial and BLE for one device and keeps all upstream messages', async () => {
    await deviceService.handleDeviceMessage({
      topic: '/dpub/aabbccddeeff',
      text: JSON.stringify({ method: 'report', device_type: 'TD01', power: 0 }),
    });
    const serialSent = [];
    const bleSent = [];
    deviceService.connectTransportDevice({
      id: 'aabbccddeeff', type: 'TD01', connectionType: 'serial',
      firmwareVersion: 'v1.2.3', transportMetadata: { portPath: 'COM5' },
    }, { send: (message) => serialSent.push(message) });
    deviceService.connectTransportDevice({
      id: 'aabbccddeeff', type: 'TD01', connectionType: 'ble', firmwareVersion: 'v1.2.3',
    }, { send: (message) => bleSent.push(message) });

    expect(deviceService.getDeviceForApi('aabbccddeeff')).toMatchObject({
      connected: true,
      controlConnection: 'mqtt',
      connections: [
        { type: 'mqtt' },
        { type: 'serial', portPath: 'COM5' },
        { type: 'ble' },
      ],
    });
    expect(deviceService.handleTransportMessage(
      'aabbccddeeff', { method: 'update', key: 'power', value: 10 }, 'serial',
    )).toBe(true);
    expect(deviceService.handleTransportMessage(
      'aabbccddeeff', { method: 'update', key: 'power', value: 20 }, 'ble',
    )).toBe(true);
    expect(deviceService.getDeviceById('aabbccddeeff').data.power).toBe(20);

    deviceService.setControlConnection('aabbccddeeff', 'serial');
    deviceService.publishDeviceMessage('aabbccddeeff', { method: 'stop' });
    expect(serialSent).toEqual([{ method: 'stop' }]);
    expect(bleSent).toEqual([]);
  });

  it('expires only MQTT while serial and BLE keep the physical device online', async () => {
    await deviceService.handleDeviceMessage({
      topic: '/dpub/aabbccddeeff',
      text: JSON.stringify({ method: 'report', device_type: 'TD01' }),
    });
    deviceService.connectTransportDevice(
      { id: 'aabbccddeeff', type: 'TD01', connectionType: 'serial' },
      { send() {} },
    );
    deviceService.connectTransportDevice(
      { id: 'aabbccddeeff', type: 'TD01', connectionType: 'ble' },
      { send() {} },
    );
    const mqtt = deviceConnections.listConnectionRecords('aabbccddeeff')
      .find((connection) => connection.type === 'mqtt');
    mqtt.lastActivity = Date.now() - deviceService.state.DEVICE_OFFLINE_TIMEOUT - 1;
    deviceService.checkDevicesOfflineStatus();

    expect(deviceService.getDeviceForApi('aabbccddeeff')).toMatchObject({
      connected: true,
      controlConnection: 'serial',
      connections: [{ type: 'serial' }, { type: 'ble' }],
    });
  });

  it('waits for the transport handle to close before deleting a device', async () => {
    let releaseDisconnect;
    const disconnect = jest.fn(() => new Promise((resolve) => {
      releaseDisconnect = resolve;
    }));
    deviceService.connectTransportDevice({
      id: 'serial-device',
      name: 'Serial device',
      type: 'QTZ',
      connectionType: 'serial',
    }, { kind: 'serial', send: jest.fn(), disconnect });

    const deleting = deviceService.deleteDeviceById('serial-device');
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(deviceService.getDeviceById('serial-device')).toBeTruthy();

    releaseDisconnect();
    await expect(deleting).resolves.toBe(true);
    expect(deviceService.getDeviceById('serial-device')).toBeUndefined();
    expect(deviceService.getDeviceForApi('serial-device')).toBeNull();
  });
});
