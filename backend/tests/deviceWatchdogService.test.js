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
const watchdog = require('../services/deviceWatchdogService');

describe('external device watchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-04T12:00:00.000Z'));
    mqttClient.publish.mockReset();
    deviceService.clearAllDevices();
    watchdog.resetForTests();
  });

  afterEach(() => {
    watchdog.resetForTests();
    jest.useRealTimers();
  });

  it('stops every CUNZHI01 output without changing report delay when a lease expires', async () => {
    deviceService.addDevice({ id: 'cunzhi-1', name: 'CUNZHI01', type: 'CUNZHI01' });

    const lease = watchdog.heartbeat({ clientId: 'xiaonian-client', ttlSeconds: 5 });
    expect(lease).toEqual({
      ok: true,
      clientId: 'xiaonian-client',
      ttlSeconds: 5,
      expiresAt: '2026-08-04T12:00:05.000Z',
    });

    await jest.advanceTimersByTimeAsync(5000);

    expect(mqttClient.publish).toHaveBeenCalledWith('/drecv/cunzhi-1', {
      method: 'update',
      shock: 0,
      voltage: 0,
      power: 0,
    });
    expect(mqttClient.publish.mock.calls.flatMap(([, payload]) => Object.keys(payload)))
      .not.toContain('report_delay_ms');
  });

  it('ignores the old deadline after the same client refreshes its lease', async () => {
    deviceService.addDevice({ id: 'motor-1', name: 'motor', type: 'TD01' });
    watchdog.heartbeat({ clientId: 'xiaonian-client', ttlSeconds: 5 });

    await jest.advanceTimersByTimeAsync(4000);
    watchdog.heartbeat({ clientId: 'xiaonian-client', ttlSeconds: 5 });
    await jest.advanceTimersByTimeAsync(1000);

    expect(mqttClient.publish).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(4000);
    expect(mqttClient.publish).toHaveBeenCalledTimes(1);
  });

  it('clears every lease and stops once when any registered client expires', async () => {
    deviceService.addDevice({ id: 'motor-1', name: 'motor', type: 'TD01' });
    watchdog.heartbeat({ clientId: 'xiaonian-client', ttlSeconds: 5 });
    watchdog.heartbeat({ clientId: 'another-client', ttlSeconds: 10 });

    await jest.advanceTimersByTimeAsync(5000);
    expect(mqttClient.publish).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5000);
    expect(mqttClient.publish).toHaveBeenCalledTimes(1);
  });

  it('retries one failing device without blocking others or touching sensors', async () => {
    deviceService.addDevice({ id: 'good-motor', name: 'good', type: 'TD01' });
    deviceService.addDevice({ id: 'bad-shock', name: 'bad', type: 'DIANJI' });
    deviceService.addDevice({ id: 'pressure', name: 'sensor', type: 'QIYA' });
    mqttClient.publish.mockImplementation((topic) => {
      if (topic === '/drecv/bad-shock') throw new Error('broker unavailable');
    });

    const stopping = watchdog.stopAll({
      clientId: 'xiaonian-client',
      reason: 'client-shutdown',
      trigger: 'client-request',
    });
    await jest.advanceTimersByTimeAsync(100);
    const result = await stopping;

    expect(result.ok).toBe(false);
    expect(result.skipped).toEqual(['pressure']);
    expect(result.stopped).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: 'good-motor', commandSent: true, attempts: 1 }),
      expect.objectContaining({ deviceId: 'bad-shock', commandSent: false, attempts: 3 }),
    ]));
    expect(mqttClient.publish.mock.calls.filter(([topic]) => topic === '/drecv/bad-shock'))
      .toHaveLength(3);
  });

  it.each([
    [{ clientId: '', ttlSeconds: 30 }, 'INVALID_CLIENT_ID'],
    [{ clientId: 'space is invalid', ttlSeconds: 30 }, 'INVALID_CLIENT_ID'],
    [{ clientId: 'valid', ttlSeconds: 4 }, 'INVALID_TTL_SECONDS'],
    [{ clientId: 'valid', ttlSeconds: 601 }, 'INVALID_TTL_SECONDS'],
    [{ clientId: 'valid', ttlSeconds: 5.5 }, 'INVALID_TTL_SECONDS'],
  ])('rejects an invalid heartbeat without creating a lease', (input, code) => {
    expect(() => watchdog.heartbeat(input)).toThrow(expect.objectContaining({ code }));
  });
});
