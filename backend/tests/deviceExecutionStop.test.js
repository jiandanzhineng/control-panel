jest.mock('../services/mqttClientService', () => ({
  publish: jest.fn(),
}));

jest.mock('../utils/fileStorage', () => ({
  getItem: jest.fn(() => null),
  setItem: jest.fn(),
}));

jest.mock('../services/nicknameService', () => ({
  getNickname: jest.fn(() => null),
}));

jest.mock('../services/firmwareOtaService', () => ({}));

const mqttClient = require('../services/mqttClientService');
const deviceService = require('../services/deviceService');

function addConnectedDevice({ id, name, type }) {
  return deviceService.connectTransportDevice(
    { id, name, type, connectionType: 'mqtt' },
    {
      kind: 'mqtt',
      send: (message) => mqttClient.publish(`/drecv/${id}`, message),
    },
  );
}

describe('execution device reset interface', () => {
  beforeEach(async () => {
    mqttClient.publish.mockReset();
    await deviceService.clearAllDevices();
  });

  it.each([
    ['PJ01', { method: 'update', power: 0 }],
    ['TD01', { method: 'update', power: 0 }],
    ['OSR6', { method: 'update', power: 0 }],
    ['DIANJI', { method: 'update', shock: 0, voltage: 0 }],
    ['CUNZHI01', { method: 'update', shock: 0, voltage: 0, power: 0 }],
  ])('publishes the registered reset for %s', (type, expected) => {
    const deviceId = `${type.toLowerCase()}-1`;
    addConnectedDevice({ id: deviceId, name: type, type });

    const result = deviceService.stopExecutionDevice(deviceId);

    expect(result).toMatchObject({
      deviceId,
      eligible: true,
      commandSent: true,
      confirmed: false,
    });
    expect(mqttClient.publish).toHaveBeenCalledWith(`/drecv/${deviceId}`, expected);
    expect(expected).not.toHaveProperty('report_delay_ms');
  });

  it.each(['QIYA', 'QTZ', 'DZC01', 'ZIDONGSUO'])(
    'skips non-execution device type %s',
    (type) => {
      const deviceId = `${type.toLowerCase()}-1`;
      deviceService.addDevice({ id: deviceId, name: type, type });

      expect(deviceService.stopExecutionDevice(deviceId)).toEqual({
        deviceId,
        eligible: false,
        capabilities: [],
        commandSent: false,
        confirmed: false,
      });
      expect(mqttClient.publish).not.toHaveBeenCalled();
    },
  );
});
