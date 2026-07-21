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

jest.mock('../services/bridgeService', () => ({
  init: jest.fn(),
}));

const mqttService = require('../services/mqttService');
const mdnsService = require('../services/mdnsService');
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
    expect(result).toEqual({
      mqtt: expect.objectContaining({ running: true, port: 1883 }),
      mdns: expect.objectContaining({ running: true, ip: '192.168.1.10' }),
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
  });
});
