jest.mock('../services/mqttClientService', () => ({
  publish: jest.fn(),
}));

jest.mock('../services/deviceService', () => ({
  state: { devices: [] },
  onDeviceDataChange: jest.fn(),
  connectedDevices: jest.fn(),
  getDeviceById: jest.fn(),
}));

const mqttClient = require('../services/mqttClientService');
const deviceService = require('../services/deviceService');
const testService = require('../services/testService');

describe('testService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    deviceService.state.devices = [];
    deviceService.connectedDevices.mockReturnValue([]);
    deviceService.getDeviceById.mockReturnValue(null);
  });

  afterEach(() => {
    testService.stopPlatform();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('starts automatic test steps for CUNZHI01 devices', () => {
    const device = { id: 'cunzhi01-dev', type: 'CUNZHI01', connected: true };
    deviceService.getDeviceById.mockReturnValue(device);

    testService.startTest(device.id);
    jest.advanceTimersByTime(8000);

    expect(mqttClient.publish.mock.calls).toEqual([
      ['/drecv/cunzhi01-dev', { method: 'update', report_delay_ms: 100 }],
      ['/drecv/cunzhi01-dev', { method: 'update', power: 255 }],
      ['/drecv/cunzhi01-dev', { method: 'update', power: 0 }],
      ['/drecv/cunzhi01-dev', { method: 'update', shock: 1, voltage: 24 }],
      ['/drecv/cunzhi01-dev', { method: 'update', shock: 0, voltage: 24 }],
    ]);
  });

  it('stops CUNZHI01 tests with safe output and default report delay', () => {
    const device = { id: 'cunzhi01-dev', type: 'CUNZHI01', connected: true };
    deviceService.getDeviceById.mockReturnValue(device);

    testService.startTest(device.id);
    mqttClient.publish.mockClear();

    testService.stopTest(device.id);

    expect(mqttClient.publish.mock.calls).toEqual([
      ['/drecv/cunzhi01-dev', { method: 'update', power: 0 }],
      ['/drecv/cunzhi01-dev', { method: 'update', shock: 0, voltage: 0 }],
      ['/drecv/cunzhi01-dev', { method: 'update', report_delay_ms: 5000 }],
    ]);
  });
});
