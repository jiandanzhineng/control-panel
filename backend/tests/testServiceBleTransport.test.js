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
const testService = require('../services/testService');

describe('automatic tests over BLE transport', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    deviceService.state.devices = [];
    deviceService.clearRuntimeTransports();
  });

  afterEach(() => {
    testService.stopPlatform();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('sends test plan messages through the connected BLE device', () => {
    const sent = [];
    deviceService.connectTransportDevice({
      id: 'ble:cunzhi',
      name: 'BLUFI',
      type: 'CUNZHI01',
      connectionType: 'ble',
      data: {},
    }, { send: (message) => sent.push(message) });

    testService.startTest('ble:cunzhi');
    jest.advanceTimersByTime(2000);

    expect(sent).toEqual([
      { method: 'update', report_delay_ms: 100 },
      { method: 'update', power: 255 },
    ]);
  });
});
