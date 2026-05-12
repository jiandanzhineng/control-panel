jest.mock('../services/mqttClientService', () => ({
  publish: jest.fn(),
}));

jest.mock('../services/logService', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mqttClient = require('../services/mqttClientService');
const firmwareOtaService = require('../services/firmwareOtaService');

const manifest = {
  latest_version: 'v1.1.33',
  generated_at: '2026-05-09T15:47:14.729626+00:00',
  commit: '91824601b8ed818e1ef468dcff5db22f19c46a0a',
  firmwares: [
    {
      device: 'CUNZHI01',
      kind: 'app',
      filename: 'under_silicon_CUNZHI01_v1.1.33.bin',
      object_key: 'firmware/latest/under_silicon_CUNZHI01_v1.1.33.bin',
      size_bytes: 1528112,
      sha256: 'eef7e8995f0b867acaffe4d537a47584df6e929a2c86aba287286ac34614de5d',
    },
    {
      device: 'CUNZHI01',
      kind: 'merged',
      filename: 'under_silicon_CUNZHI01_v1.1.33_merged.bin',
      object_key: 'firmware/latest/under_silicon_CUNZHI01_v1.1.33_merged.bin',
      size_bytes: 1593648,
      sha256: '70ce854d0b5ea519706f64a0c096088b1d7b9427cdd3936455bf48e8e5fe95a8',
    },
  ],
};

describe('firmwareOtaService', () => {
  beforeEach(() => {
    firmwareOtaService.resetForTests();
    mqttClient.publish.mockReset();
    firmwareOtaService.setManifestFetcher(async () => manifest);
  });

  afterEach(() => {
    firmwareOtaService.resetForTests();
  });

  it('matches app firmware and ignores merged firmware', async () => {
    const result = await firmwareOtaService.getLatestFirmwareForDevice({
      id: 'dev01',
      type: 'CUNZHI01',
      connected: true,
      data: { ver: 'v1.1.28' },
    });

    expect(result.supported).toBe(true);
    expect(result.latestVersion).toBe('v1.1.33');
    expect(result.updateAvailable).toBe(true);
    expect(result.firmware.filename).toBe('under_silicon_CUNZHI01_v1.1.33.bin');
    expect(result.firmware.kind).toBe('app');
    expect(result.firmware.url).toBe('http://firmware.undersilicon.cn/firmware/latest/under_silicon_CUNZHI01_v1.1.33.bin');
  });

  it('returns unsupported when no app firmware exists', async () => {
    const result = await firmwareOtaService.getLatestFirmwareForDevice({
      id: 'dev02',
      type: 'OSR6',
      connected: true,
      data: { ver: 'v1.1.28' },
    });

    expect(result.supported).toBe(false);
    expect(result.updateAvailable).toBe(false);
    expect(result.firmware).toBe(null);
  });

  it('checks multiple devices with one manifest fetch', async () => {
    let fetchCount = 0;
    firmwareOtaService.setManifestFetcher(async () => {
      fetchCount += 1;
      return manifest;
    });

    const result = await firmwareOtaService.getLatestFirmwareForDevices([
      { id: 'dev01', type: 'CUNZHI01', connected: true, data: { ver: 'v1.1.28' } },
      { id: 'dev02', type: 'CUNZHI01', connected: true, data: { ver: 'v1.1.33' } },
      { id: 'dev03', type: 'OSR6', connected: true, data: { ver: 'v1.1.28' } },
    ]);

    expect(fetchCount).toBe(1);
    expect(result).toHaveLength(3);
    expect(result[0].updateAvailable).toBe(true);
    expect(result[1].updateAvailable).toBe(false);
    expect(result[2].supported).toBe(false);
  });

  it('publishes exact OTA payload when updating to latest', async () => {
    const result = await firmwareOtaService.updateDeviceToLatest({
      id: 'dev01',
      type: 'CUNZHI01',
      connected: true,
      data: { ver: 'v1.1.28' },
    });

    expect(mqttClient.publish).toHaveBeenCalledWith('/drecv/dev01', {
      method: 'ota_update',
      url: 'http://firmware.undersilicon.cn/firmware/latest/under_silicon_CUNZHI01_v1.1.33.bin',
    });
    expect(result.status.status).toBe('requested');
    expect(result.status.filename).toBe('under_silicon_CUNZHI01_v1.1.33.bin');
  });

  it('rejects offline devices', async () => {
    await expect(firmwareOtaService.updateDeviceToLatest({
      id: 'dev01',
      type: 'CUNZHI01',
      connected: false,
      data: { ver: 'v1.1.28' },
    })).rejects.toMatchObject({ code: 'DEVICE_OFFLINE', status: 409 });
  });

  it('rejects devices already on latest version by default', async () => {
    await expect(firmwareOtaService.updateDeviceToLatest({
      id: 'dev01',
      type: 'CUNZHI01',
      connected: true,
      data: { ver: 'v1.1.33' },
    })).rejects.toMatchObject({ code: 'ALREADY_LATEST', status: 409 });
  });

  it('updates multiple devices and keeps per-device failures isolated', async () => {
    mqttClient.publish.mockImplementation((topic) => {
      if (topic === '/drecv/dev05') throw new Error('mqtt unavailable');
    });

    const result = await firmwareOtaService.updateDevicesToLatest([
      { id: 'dev01', type: 'CUNZHI01', connected: true, data: { ver: 'v1.1.28' } },
      { id: 'dev02', type: 'CUNZHI01', connected: true, data: { ver: 'v1.1.33' } },
      { id: 'dev03', type: 'OSR6', connected: true, data: { ver: 'v1.1.28' } },
      { id: 'dev04', type: 'CUNZHI01', connected: false, data: { ver: 'v1.1.28' } },
      { id: 'dev05', type: 'CUNZHI01', connected: true, data: { ver: 'v1.1.28' } },
    ]);

    expect(result.requestedCount).toBe(1);
    expect(result.skippedCount).toBe(3);
    expect(result.failedCount).toBe(1);
    expect(result.results.find((item) => item.deviceId === 'dev01').ok).toBe(true);
    expect(result.results.find((item) => item.deviceId === 'dev02').error.code).toBe('ALREADY_LATEST');
    expect(result.results.find((item) => item.deviceId === 'dev03').error.code).toBe('FIRMWARE_NOT_SUPPORTED');
    expect(result.results.find((item) => item.deviceId === 'dev04').error.code).toBe('DEVICE_OFFLINE');
    expect(result.results.find((item) => item.deviceId === 'dev05').error.code).toBe('OTA_MQTT_PUBLISH_FAILED');
  });

  it('blinks only online devices confirmed to be on latest firmware', async () => {
    const publisher = jest.fn((deviceId, action) => ({
      topic: `/drecv/${deviceId}`,
      message: { method: 'action', action },
    }));

    const result = await firmwareOtaService.blinkLatestDevices([
      { id: 'latest', type: 'CUNZHI01', connected: true, data: { ver: 'v1.1.33' } },
      { id: 'old', type: 'CUNZHI01', connected: true, data: { ver: 'v1.1.28' } },
      { id: 'unknown', type: 'CUNZHI01', connected: true, data: {} },
      { id: 'unsupported', type: 'OSR6', connected: true, data: { ver: 'v1.1.33' } },
      { id: 'offline', type: 'CUNZHI01', connected: false, data: { ver: 'v1.1.33' } },
    ], publisher);

    expect(result.requestedCount).toBe(1);
    expect(result.skippedCount).toBe(4);
    expect(result.failedCount).toBe(0);
    expect(publisher).toHaveBeenCalledTimes(1);
    expect(publisher).toHaveBeenCalledWith('latest', 'blink');
    expect(result.results.find((item) => item.deviceId === 'latest').message).toEqual({
      method: 'action',
      action: 'blink',
    });
    expect(result.results.find((item) => item.deviceId === 'old').error.code).toBe('FIRMWARE_UPDATE_AVAILABLE');
    expect(result.results.find((item) => item.deviceId === 'unknown').error.code).toBe('FIRMWARE_VERSION_UNKNOWN');
    expect(result.results.find((item) => item.deviceId === 'unsupported').error.code).toBe('FIRMWARE_NOT_SUPPORTED');
    expect(result.results.find((item) => item.deviceId === 'offline').error.code).toBe('DEVICE_OFFLINE');
  });

  it('keeps blinking other latest devices when one publish fails', async () => {
    const publisher = jest.fn((deviceId, action) => {
      if (deviceId === 'failed') throw new Error('mqtt unavailable');
      return {
        topic: `/drecv/${deviceId}`,
        message: { method: 'action', action },
      };
    });

    const result = await firmwareOtaService.blinkLatestDevices([
      { id: 'ok', type: 'CUNZHI01', connected: true, data: { ver: 'v1.1.33' } },
      { id: 'failed', type: 'CUNZHI01', connected: true, data: { ver: 'v1.1.33' } },
    ], publisher);

    expect(result.requestedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(publisher).toHaveBeenCalledTimes(2);
    expect(result.results.find((item) => item.deviceId === 'failed').error.code).toBe('DEVICE_ACTION_PUBLISH_FAILED');
  });

  it('records and emits OTA status updates', () => {
    const handler = jest.fn();
    const unsubscribe = firmwareOtaService.onOtaStatus('dev01', handler);

    const status = firmwareOtaService.recordOtaStatus('dev01', {
      status: 'downloading',
      progress: 41.4,
      msg: 'Downloading',
    });

    expect(status).toMatchObject({
      deviceId: 'dev01',
      status: 'downloading',
      progress: 41,
      msg: 'Downloading',
    });
    expect(handler).toHaveBeenCalledWith(status);
    expect(firmwareOtaService.getOtaStatus('dev01')).toBe(status);

    unsubscribe();
  });
});
