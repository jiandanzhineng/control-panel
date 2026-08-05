const { once } = require('events');

jest.mock('../services/mqttService', () => ({
  start: jest.fn(async () => ({ running: true, broker: 'mock', port: 1883 })),
  stop: jest.fn(async () => ({ running: false, broker: 'mock' })),
}));

jest.mock('../services/mdnsService', () => ({
  publish: jest.fn(async () => ({ running: true, pid: 12345, ip: '192.168.1.10' })),
  unpublish: jest.fn(async () => ({ running: false })),
}));

jest.mock('../services/mqttClientService', () => ({
  init: jest.fn(),
  onMessage: jest.fn(),
}));

jest.mock('../services/deviceService', () => ({
  initDeviceList: jest.fn(),
  handleDeviceMessage: jest.fn(),
  onDeviceDataChange: jest.fn(),
  cleanup: jest.fn(),
}));

jest.mock('../services/serialConnectionService', () => ({
  start: jest.fn(async () => ({ autoConnect: false })),
  shutdown: jest.fn(async () => {}),
  listPorts: jest.fn(async () => []),
  getSettings: jest.fn(() => ({ autoConnect: false })),
}));

jest.mock('../services/deviceWatchdogService', () => ({
  heartbeat: jest.fn(),
  stopAll: jest.fn(),
  shutdown: jest.fn(async () => ({ ok: true })),
}));

jest.mock('../services/bridgeService', () => ({
  init: jest.fn(),
}));

const mqttService = require('../services/mqttService');
const mdnsService = require('../services/mdnsService');
const serialConnectionService = require('../services/serialConnectionService');
const deviceService = require('../services/deviceService');
const deviceWatchdogService = require('../services/deviceWatchdogService');
const backend = require('../index');

describe('backend server lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (backend.server.listening) {
      const closed = once(backend.server, 'close');
      backend.server.close();
      await closed;
    }
    await backend.stopRuntimeServices();
  });

  it('starts mDNS and MQTT when the exported server starts listening', async () => {
    const listening = once(backend.server, 'listening');
    backend.server.listen(0, '127.0.0.1');
    await listening;
    const result = await backend.startRuntimeServices();

    expect(mqttService.start).toHaveBeenCalledTimes(1);
    expect(mdnsService.publish).toHaveBeenCalledTimes(1);
    expect(serialConnectionService.start).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      mqtt: expect.objectContaining({ running: true, port: 1883 }),
      mdns: expect.objectContaining({ running: true, ip: '192.168.1.10' }),
      serial: { autoConnect: false },
    });
  });

  it('stops mDNS and MQTT when the exported server closes', async () => {
    const listening = once(backend.server, 'listening');
    backend.server.listen(0, '127.0.0.1');
    await listening;
    await backend.startRuntimeServices();

    const closed = once(backend.server, 'close');
    backend.server.close();
    await closed;
    await backend.stopRuntimeServices();

    expect(mqttService.stop).toHaveBeenCalledTimes(1);
    expect(mdnsService.unpublish).toHaveBeenCalledTimes(1);
    expect(serialConnectionService.shutdown).toHaveBeenCalledTimes(1);
  });

  it('waits for the watchdog and BLE hook before stopping transports and cleaning devices', async () => {
    const listening = once(backend.server, 'listening');
    backend.server.listen(0, '127.0.0.1');
    await listening;
    await backend.startRuntimeServices();

    const disconnectBle = jest.fn(async () => {});
    await backend.shutdownBackend('test-shutdown', { beforeTransportShutdown: disconnectBle });

    expect(deviceWatchdogService.shutdown).toHaveBeenCalledWith('test-shutdown');
    expect(deviceService.cleanup).toHaveBeenCalledTimes(1);
    expect(serialConnectionService.shutdown).toHaveBeenCalledTimes(1);
    expect(mqttService.stop).toHaveBeenCalledTimes(1);
    expect(deviceWatchdogService.shutdown.mock.invocationCallOrder[0])
      .toBeLessThan(disconnectBle.mock.invocationCallOrder[0]);
    expect(disconnectBle.mock.invocationCallOrder[0])
      .toBeLessThan(serialConnectionService.shutdown.mock.invocationCallOrder[0]);
    expect(serialConnectionService.shutdown.mock.invocationCallOrder[0])
      .toBeLessThan(mqttService.stop.mock.invocationCallOrder[0]);
    expect(mqttService.stop.mock.invocationCallOrder[0])
      .toBeLessThan(deviceService.cleanup.mock.invocationCallOrder[0]);
    expect(backend.server.listening).toBe(false);
  });
});
