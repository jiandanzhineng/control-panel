jest.mock('../utils/fileStorage', () => ({
  getItem: jest.fn(() => null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/logService', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/mqttClientService', () => ({ publish: jest.fn() }));
jest.mock('../services/nicknameService', () => ({ getNickname: jest.fn() }));
jest.mock('../services/firmwareOtaService', () => ({ recordOtaStatus: jest.fn() }));

const storage = require('../utils/fileStorage');
const devices = require('../services/deviceService');

describe('device persistence', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    storage.setItemAsync.mockReset().mockResolvedValue(undefined);
    devices.state.devices = [{ id: 'demo', type: 'TD01', name: 'Motor', data: { power: 0 } }];
    devices.state.dataChangeHandlers = [];
  });

  afterEach(async () => {
    await devices.cleanup();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('coalesces reports while delivering every data change immediately', async () => {
    const changes = jest.fn();
    devices.onDeviceDataChange(changes);
    for (let power = 1; power <= 100; power++) devices.updateDeviceData('demo', { power });
    expect(changes).toHaveBeenCalledTimes(100);
    expect(storage.setItemAsync).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000);
    expect(storage.setItemAsync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.setItemAsync.mock.calls[0][1])[0].data.power).toBe(100);
  });

  it('saves regularly during continuous unchanged reporting', async () => {
    for (let report = 0; report < 30; report++) {
      devices.updateDeviceData('demo', { power: 0 });
      await jest.advanceTimersByTimeAsync(100);
    }
    expect(storage.setItemAsync).toHaveBeenCalledTimes(3);
    expect(JSON.parse(storage.setItemAsync.mock.calls[2][1])[0].lastReport).toBe(Date.now() - 100);
  });

  it('waits for the latest snapshot on shutdown', async () => {
    let release;
    storage.setItemAsync.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    devices.updateDeviceData('demo', { power: 7 });
    const flushing = devices.flushDevices();
    devices.updateDeviceData('demo', { power: 8 });
    const shutdown = devices.cleanup();
    let finished = false;
    shutdown.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await Promise.all([flushing, shutdown]);
    expect(storage.setItemAsync).toHaveBeenCalledTimes(2);
    expect(JSON.parse(storage.setItemAsync.mock.calls[1][1])[0].data.power).toBe(8);
  });

  it('does not restore a deleted device when a previous write finishes', async () => {
    let release;
    storage.setItemAsync.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    devices.updateDeviceData('demo', { power: 7 });
    const flushing = devices.flushDevices();
    await devices.removeDevice('demo');
    release();
    await flushing;
    expect(JSON.parse(storage.setItemAsync.mock.calls.at(-1)[1])).toEqual([]);
  });

  it('retries a failed write with the newest state', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    storage.setItemAsync.mockRejectedValueOnce(new Error('disk unavailable'));
    devices.updateDeviceData('demo', { power: 7 });
    await jest.advanceTimersByTimeAsync(1000);
    devices.updateDeviceData('demo', { power: 8 });
    await jest.advanceTimersByTimeAsync(1000);
    expect(storage.setItemAsync).toHaveBeenCalledTimes(2);
    expect(JSON.parse(storage.setItemAsync.mock.calls.at(-1)[1])[0].data.power).toBe(8);
  });
});
