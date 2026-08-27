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

  it('resets YCY_ENEMA through the pump stop command', () => {
    const deviceId = 'enema-1';
    addConnectedDevice({ id: deviceId, name: 'YISK', type: 'YCY_ENEMA' });

    const result = deviceService.stopExecutionDevice(deviceId);

    expect(result).toMatchObject({ eligible: true, commandSent: true });
    expect(mqttClient.publish).toHaveBeenCalledWith(`/drecv/${deviceId}`, {
      brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'stop',
    });
  });

  it('waits for an asynchronous WebBLE stop write before confirming', async () => {
    let release;
    const sent = [];
    await deviceService.connectTransportDevice(
      { id: 'webble-stop', name: 'YCY-FJB-03', type: 'YCY_CUP', connectionType: 'brandBle' },
      {
        kind: 'brandBle',
        send: (message) => {
          sent.push(message);
          return new Promise((resolve) => { release = resolve; });
        },
      },
    );

    const stopping = deviceService.stopExecutionDeviceAndWait('webble-stop');
    await Promise.resolve();
    expect(sent).toEqual([{ brand: 'ycy', cmd: 'stopFjb' }]);
    let finished = false;
    stopping.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release({ ok: true });
    await expect(stopping).resolves.toMatchObject({ confirmed: true, commandSent: true });
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
