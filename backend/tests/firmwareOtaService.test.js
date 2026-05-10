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
    expect(result.firmware.url).toBe('https://firmware.undersilicon.cn/firmware/latest/under_silicon_CUNZHI01_v1.1.33.bin');
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

  it('publishes exact OTA payload when updating to latest', async () => {
    const result = await firmwareOtaService.updateDeviceToLatest({
      id: 'dev01',
      type: 'CUNZHI01',
      connected: true,
      data: { ver: 'v1.1.28' },
    });

    expect(mqttClient.publish).toHaveBeenCalledWith('/drecv/dev01', {
      method: 'ota_update',
      url: 'https://firmware.undersilicon.cn/firmware/latest/under_silicon_CUNZHI01_v1.1.33.bin',
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
