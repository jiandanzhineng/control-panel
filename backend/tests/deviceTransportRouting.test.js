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

describe('device transport routing', () => {
  beforeEach(() => {
    deviceService.state.devices = [];
    deviceService.clearRuntimeTransports();
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
      connectionType: 'ble',
      data: { power: 128 },
    });
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        deviceId: 'ble:esp32-c3',
        changes: { power: { old: 0, new: 128 } },
      }),
    ]));
  });
});
