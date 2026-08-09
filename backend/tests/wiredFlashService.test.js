const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

jest.mock('../services/logService', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const manifestService = require('../services/firmwareManifestService');
const { WiredFlashService } = require('../services/wiredFlashService');

const sleep = () => Promise.resolve();

// ---- mock 串口:open 后注册 data 监听时立即回放启动日志 ----
class MockSerialPort {
  constructor(opts) {
    this.path = opts.path;
    this.baudRate = opts.baudRate;
    this.isOpen = false;
    this.setCalls = [];
    this.bootLog = MockSerialPort.bootLog;
    MockSerialPort.instances.push(this);
  }

  static async list() {
    return MockSerialPort.listResult;
  }

  open(cb) {
    this.isOpen = true;
    setImmediate(() => cb(null));
  }

  close(cb) {
    this.isOpen = false;
    setImmediate(() => cb(null));
  }

  set(flags, cb) {
    this.setCalls.push(flags);
    setImmediate(() => cb(null));
  }

  on(event, handler) {
    if (event === 'data') {
      this.dataHandler = handler;
      if (this.bootLog) handler(Buffer.from(this.bootLog));
    }
    return this;
  }

  write(data, cb) { setImmediate(() => cb(null)); }

  drain(cb) { setImmediate(() => cb(null)); }
}

MockSerialPort.instances = [];
MockSerialPort.listResult = [];
MockSerialPort.bootLog = null;

const BOOT_LOG = [
  'I (407) cpu_start: App version:      v1.1.38',
  'I (520) BLUFI_EXAMPLE: MAC Address: 6055f97c342c',
  'I (610) QTZ: device_init',
].join('\r\n');

const mergedContent = Buffer.from('fake merged firmware image');
const mergedSha256 = crypto.createHash('sha256').update(mergedContent).digest('hex');

const manifest = {
  latest_version: 'v1.1.38',
  generated_at: '2026-08-01T00:00:00.000000+00:00',
  firmwares: [
    {
      device: 'QTZ',
      kind: 'app',
      filename: 'under_silicon_QTZ_v1.1.38.bin',
      object_key: 'firmware/latest/under_silicon_QTZ_v1.1.38.bin',
      size_bytes: 100,
      sha256: 'a'.repeat(64),
    },
    {
      device: 'QTZ',
      kind: 'merged',
      filename: 'under_silicon_QTZ_v1.1.38_merged.bin',
      object_key: 'firmware/latest/under_silicon_QTZ_v1.1.38_merged.bin',
      size_bytes: mergedContent.length,
      sha256: mergedSha256,
    },
  ],
};

function makeSerialConnectionService() {
  return { sessions: new Map(), pendingConnections: new Map() };
}

function makeSerialReset() {
  return {
    enterDownloadMode: jest.fn(async () => {}),
    hardResetToApp: jest.fn(async () => {}),
  };
}

function makeEsptool() {
  const state = {
    writeFlash: jest.fn(async (opts) => {
      opts.reportProgress(0, 50, 100);
      opts.reportProgress(1, 100, 100);
    }),
    main: jest.fn(async () => 'ESP32-C3'),
    disconnect: jest.fn(async () => {}),
  };
  class MockTransport {
    constructor(device) { this.device = device; }

    async disconnect() { return state.disconnect(); }
  }
  class MockESPLoader {
    constructor(opts) { this.opts = opts; }

    async main(mode) { return state.main(mode); }

    async writeFlash(...args) { return state.writeFlash(...args); }
  }
  return {
    state,
    loadEsptool: async () => ({ ESPLoader: MockESPLoader, Transport: MockTransport }),
  };
}

function makeDownloadFetcher() {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => mergedContent.buffer.slice(
      mergedContent.byteOffset,
      mergedContent.byteOffset + mergedContent.byteLength,
    ),
  }));
}

function makeService(overrides = {}) {
  const serialReset = makeSerialReset();
  const esptool = makeEsptool();
  const serialConnectionService = makeSerialConnectionService();
  const downloadFetcher = makeDownloadFetcher();
  const cacheDir = overrides.cacheDir;
  const flashIds = [];
  const service = new WiredFlashService({
    SerialPortClass: MockSerialPort,
    serialReset,
    loadEsptool: esptool.loadEsptool,
    serialConnectionService,
    downloadFetcher,
    cacheDir,
    sleep,
    createFlashId: () => {
      const id = `flash-${flashIds.length + 1}`;
      flashIds.push(id);
      return id;
    },
    ...overrides,
  });
  return { service, serialReset, esptool, serialConnectionService, downloadFetcher, flashIds };
}

let cacheDir;

beforeEach(async () => {
  MockSerialPort.instances = [];
  MockSerialPort.listResult = [];
  MockSerialPort.bootLog = null;
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wired-flash-test-'));
  manifestService.setManifestFetcher(jest.fn(async () => manifest));
});

afterEach(async () => {
  manifestService.resetForTests();
  await fs.rm(cacheDir, { recursive: true, force: true });
});

describe('identify 启动日志解析', () => {
  test('解析版本 / MAC / 型号并执行复位时序', async () => {
    MockSerialPort.bootLog = BOOT_LOG;
    const { service } = makeService({ cacheDir });

    const result = await service.identify('COM17');

    expect(result).toEqual({
      path: 'COM17',
      identified: true,
      deviceType: 'QTZ',
      version: 'v1.1.38',
      mac: '6055f97c342c',
    });
    const port = MockSerialPort.instances[0];
    expect(port.setCalls).toEqual([
      { dtr: true, rts: true },
      { dtr: false, rts: false },
      { dtr: true, rts: true },
    ]);
    expect(port.isOpen).toBe(false);
  });

  test('sta MAC 兜底解析 + 未知识别不报错', async () => {
    MockSerialPort.bootLog = [
      'I (300) wifi:sta (60:55:f9:7c:34:2c)',
      'I (900) UNKNOWN_TAG: hello',
    ].join('\r\n');
    const { service } = makeService({ cacheDir });

    const result = await service.identify('COM17');

    expect(result.identified).toBe(false);
    expect(result.deviceType).toBeNull();
    expect(result.mac).toBe('6055f97c342c');
    expect(result.version).toBeNull();
  });

  test('型号匹配大小写不敏感', async () => {
    MockSerialPort.bootLog = 'I (610) qtz: device_init';
    const { service } = makeService({ cacheDir });

    const result = await service.identify('COM17');
    expect(result.deviceType).toBe('QTZ');
  });

  test('串口被占用时报 SERIAL_PORT_BUSY', async () => {
    const { service, serialConnectionService } = makeService({ cacheDir });
    serialConnectionService.sessions.set('COM17', { deviceId: 'dev-1' });

    await expect(service.identify('COM17')).rejects.toMatchObject({
      code: 'SERIAL_PORT_BUSY',
      status: 409,
    });
  });

  test('缺少 path 报 400', async () => {
    const { service } = makeService({ cacheDir });
    await expect(service.identify()).rejects.toMatchObject({ code: 'SERIAL_PATH_REQUIRED', status: 400 });
  });
});

describe('listPorts', () => {
  test('标注被 serialConnectionService 占用的端口', async () => {
    MockSerialPort.listResult = [{ path: 'COM17' }, { path: 'COM3' }];
    const { service, serialConnectionService } = makeService({ cacheDir });
    serialConnectionService.sessions.set('COM17', { deviceId: 'dev-1' });

    const ports = await service.listPorts();

    expect(ports).toEqual([
      { path: 'COM17', busy: true, deviceId: 'dev-1' },
      { path: 'COM3', busy: false, deviceId: null },
    ]);
  });
});

describe('getFirmwareForDevice', () => {
  test('取 kind=merged 条目并计算 updateAvailable', async () => {
    const { service } = makeService({ cacheDir });

    const result = await service.getFirmwareForDevice('QTZ', 'v1.1.30');

    expect(result.supported).toBe(true);
    expect(result.currentVersion).toBe('v1.1.30');
    expect(result.latestVersion).toBe('v1.1.38');
    expect(result.updateAvailable).toBe(true);
    expect(result.firmware.kind).toBe('merged');
    expect(result.firmware.sha256).toBe(mergedSha256);
    expect(result.firmware.url).toContain('under_silicon_QTZ_v1.1.38_merged.bin');
  });

  test('无 merged 固件时 supported=false', async () => {
    const { service } = makeService({ cacheDir });
    const result = await service.getFirmwareForDevice('NO_SUCH_TYPE', null);
    expect(result.supported).toBe(false);
    expect(result.firmware).toBeNull();
  });
});

describe('startFlash 状态机', () => {
  async function runToEnd({ service, flashIds }) {
    // flashId 可预测,先订阅再启动,确保看到完整状态序列
    const expectedId = `flash-${flashIds.length + 1}`;
    const statuses = [];
    service.onFlashStatus(expectedId, (s) => statuses.push(s.status));
    const { flashId } = await service.startFlash({ path: 'COM17', deviceType: 'QTZ' });
    expect(flashId).toBe(expectedId);
    const finalStatus = await service.waitForFlash(flashId);
    return { flashId, statuses, finalStatus };
  }

  test('成功路径:downloading → verifying → entering_bootloader → flashing → resetting → success', async () => {
    const helpers = makeService({ cacheDir });
    const { service, serialReset, esptool } = helpers;

    const { statuses, finalStatus } = await runToEnd(helpers);

    expect(finalStatus.status).toBe('success');
    expect(finalStatus.progress).toBe(100);
    expect(statuses).toEqual([
      'pending',
      'downloading',
      'verifying',
      'entering_bootloader',
      'flashing',
      'flashing',
      'flashing',
      'resetting',
      'success',
    ]);
    expect(statuses).not.toContain('failed');

    expect(serialReset.enterDownloadMode).toHaveBeenCalledTimes(1);
    expect(serialReset.enterDownloadMode).toHaveBeenCalledWith('COM17');
    expect(serialReset.hardResetToApp).toHaveBeenCalledWith('COM17');
    expect(esptool.state.main).toHaveBeenCalledWith('no_reset');

    const writeArgs = esptool.state.writeFlash.mock.calls[0][0];
    expect(writeArgs.fileArray).toHaveLength(1);
    expect(writeArgs.fileArray[0].address).toBe(0x0);
    expect(writeArgs.fileArray[0].data).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(writeArgs.fileArray[0].data).equals(mergedContent)).toBe(true);
    expect(writeArgs.flashMode).toBe('dio');
    expect(writeArgs.flashFreq).toBe('80m');
    expect(writeArgs.flashSize).toBe('4MB');
    expect(writeArgs.eraseAll).toBe(false);
    expect(writeArgs.compress).toBe(true);
  });

  test('缓存命中时跳过重复下载', async () => {
    const helpers = makeService({ cacheDir });
    const { downloadFetcher } = helpers;

    await runToEnd(helpers);
    await runToEnd(helpers);

    expect(downloadFetcher).toHaveBeenCalledTimes(1);
  });

  test('sha256 校验失败进入 failed', async () => {
    const badManifest = {
      ...manifest,
      firmwares: manifest.firmwares.map((item) => (
        item.kind === 'merged' ? { ...item, sha256: '0'.repeat(64) } : item
      )),
    };
    manifestService.setManifestFetcher(jest.fn(async () => badManifest));
    const helpers = makeService({ cacheDir });
    const { esptool } = helpers;

    const { finalStatus } = await runToEnd(helpers);

    expect(finalStatus.status).toBe('failed');
    expect(finalStatus.error.code).toBe('FIRMWARE_CHECKSUM_MISMATCH');
    expect(esptool.state.writeFlash).not.toHaveBeenCalled();
  });

  test('无 merged 固件进入 failed / FIRMWARE_NOT_SUPPORTED', async () => {
    const { service } = makeService({ cacheDir });
    const { flashId } = await service.startFlash({ path: 'COM17', deviceType: 'NOPE' });
    const finalStatus = await service.waitForFlash(flashId);
    expect(finalStatus.status).toBe('failed');
    expect(finalStatus.error.code).toBe('FIRMWARE_NOT_SUPPORTED');
  });

  test('main 同步失败重试 3 次后报 FLASH_CONNECT_FAILED', async () => {
    const { service, serialReset, esptool } = makeService({ cacheDir });
    esptool.state.main.mockRejectedValue(new Error('sync failed'));

    const { flashId } = await service.startFlash({ path: 'COM17', deviceType: 'QTZ' });
    const finalStatus = await service.waitForFlash(flashId);

    expect(finalStatus.status).toBe('failed');
    expect(finalStatus.error.code).toBe('FLASH_CONNECT_FAILED');
    expect(serialReset.enterDownloadMode).toHaveBeenCalledTimes(3);
    expect(esptool.state.main).toHaveBeenCalledTimes(3);
  });

  test('烧录前端口被占用直接拒绝', async () => {
    const { service, serialConnectionService } = makeService({ cacheDir });
    serialConnectionService.sessions.set('COM17', { deviceId: 'dev-1' });

    await expect(service.startFlash({ path: 'COM17', deviceType: 'QTZ' })).rejects.toMatchObject({
      code: 'SERIAL_PORT_BUSY',
      status: 409,
    });
  });

  test('参数缺失报 400', async () => {
    const { service } = makeService({ cacheDir });
    await expect(service.startFlash({ deviceType: 'QTZ' })).rejects.toMatchObject({ code: 'SERIAL_PATH_REQUIRED', status: 400 });
    await expect(service.startFlash({ path: 'COM17' })).rejects.toMatchObject({ code: 'DEVICE_TYPE_REQUIRED', status: 400 });
  });

  test('getFlashStatus 未知 flashId 返回 null,onFlashStatus 可退订', async () => {
    const { service } = makeService({ cacheDir });
    expect(service.getFlashStatus('nope')).toBeNull();

    const { flashId } = await service.startFlash({ path: 'COM17', deviceType: 'QTZ' });
    const seen = [];
    const off = service.onFlashStatus(flashId, (s) => seen.push(s.status));
    off();
    await service.waitForFlash(flashId);
    expect(seen).toEqual([]);
  });
});
