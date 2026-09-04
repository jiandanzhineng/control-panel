const { EventEmitter } = require('events');
const { AutoProvisionService, constants } = require('../services/autoProvisionService');

function createHarness(options = {}) {
  const serialSettings = { autoConnect: options.autoConnect === true };
  const serialService = new EventEmitter();
  Object.assign(serialService, {
    reservations: new Map(),
    getSettings: jest.fn(() => ({ ...serialSettings })),
    setSettings: jest.fn(async (patch) => {
      serialSettings.autoConnect = patch.autoConnect;
      return { ...serialSettings };
    }),
    listPorts: jest.fn(async () => options.ports || []),
    connect: jest.fn(),
    reservePort: jest.fn((path, token) => {
      serialService.reservations.set(path, token);
      return () => serialService.reservations.delete(path);
    }),
    releasePort: jest.fn((path) => serialService.reservations.delete(path)),
  });

  const flashService = {
    startFlash: jest.fn(async () => ({ flashId: 'flash-1' })),
    onFlashStatus: jest.fn(() => () => {}),
    waitForFlash: jest.fn(async () => ({ status: 'success', progress: 100 })),
  };

  const store = new Map();
  const service = new AutoProvisionService({
    serialService,
    flashService,
    storage: {
      getItem: (key) => store.get(key) || null,
      setItem: (key, value) => store.set(key, value),
    },
    setTimeout: (fn) => { fn(); return { unref() {} }; },
  });

  return { service, serialService, flashService, serialSettings };
}

const CH34X_PORT = { path: 'COM9', vendorId: '1A86', friendlyName: 'CH343 (COM9)', status: 'idle' };
const OTHER_PORT = { path: 'COM8', vendorId: '0403', friendlyName: 'FTDI (COM8)', status: 'idle' };

function probeError(code) {
  const error = new Error(`probe failed: ${code}`);
  error.code = code;
  return error;
}

function entryFor(service, path) {
  return service.getState().ports.find((port) => port.path === path);
}

describe('autoProvisionService', () => {
  it('临时强制串口自动连接，stop 时恢复原值', async () => {
    const { service, serialService, serialSettings } = createHarness({ autoConnect: false });
    await service.start();
    expect(serialSettings.autoConnect).toBe(true);
    await service.stop();
    expect(serialSettings.autoConnect).toBe(false);
    expect(serialService.setSettings).toHaveBeenCalledTimes(2);
  });

  it('原本已开启自动连接时，stop 不关闭它', async () => {
    const { service, serialService, serialSettings } = createHarness({ autoConnect: true });
    await service.start();
    await service.stop();
    expect(serialSettings.autoConnect).toBe(true);
    expect(serialService.setSettings).not.toHaveBeenCalled();
  });

  it('握手成功直接进 connected，不烧录', async () => {
    const { service, serialService, flashService } = createHarness({ ports: [CH34X_PORT] });
    serialService.connect.mockResolvedValue({ id: 'aabbccddeeff', type: 'CUNZHI01' });
    service.setSettings({ autoFlash: true, deviceType: 'CUNZHI01' });
    await service.start();
    await Promise.allSettled([...service.runs.values()]);

    const entry = entryFor(service, 'COM9');
    expect(entry.stage).toBe('connected');
    expect(entry.deviceId).toBe('aabbccddeeff');
    expect(flashService.startFlash).not.toHaveBeenCalled();
  });

  it('CH34x 握手超时 → 烧录 → 二次握手成功', async () => {
    const { service, serialService, flashService } = createHarness({ ports: [CH34X_PORT] });
    serialService.connect
      .mockRejectedValueOnce(probeError('SERIAL_PROBE_TIMEOUT'))
      .mockRejectedValueOnce(probeError('SERIAL_PROBE_TIMEOUT'))
      .mockResolvedValueOnce({ id: 'aabbccddeeff', type: 'CUNZHI01' });
    service.setSettings({ autoFlash: true, deviceType: 'CUNZHI01' });
    await service.start();
    await Promise.allSettled([...service.runs.values()]);

    expect(flashService.startFlash).toHaveBeenCalledWith(
      { path: 'COM9', deviceType: 'CUNZHI01' },
      { reservationToken: service.token },
    );
    const entry = entryFor(service, 'COM9');
    expect(entry.stage).toBe('connected');
    expect(entry.flashed).toBe(true);
  });

  it('非 CH34x 端口握手失败不烧录，直接失败终态', async () => {
    const { service, serialService, flashService } = createHarness({ ports: [OTHER_PORT] });
    serialService.connect.mockRejectedValue(probeError('SERIAL_PROBE_TIMEOUT'));
    service.setSettings({ autoFlash: true, deviceType: 'CUNZHI01' });
    await service.start();
    await Promise.allSettled([...service.runs.values()]);

    expect(flashService.startFlash).not.toHaveBeenCalled();
    const entry = entryFor(service, 'COM8');
    expect(entry.stage).toBe('failed');
    expect(entry.message).toContain('非 CH34x');
  });

  it('端口被占用(SERIAL_OPEN_FAILED)不烧录', async () => {
    const { service, serialService, flashService } = createHarness({ ports: [CH34X_PORT] });
    serialService.connect.mockRejectedValue(probeError('SERIAL_OPEN_FAILED'));
    service.setSettings({ autoFlash: true, deviceType: 'CUNZHI01' });
    await service.start();
    await Promise.allSettled([...service.runs.values()]);

    expect(flashService.startFlash).not.toHaveBeenCalled();
    expect(entryFor(service, 'COM9').error.code).toBe('SERIAL_OPEN_FAILED');
  });

  it('未开启自动烧录时握手失败不烧录', async () => {
    const { service, serialService, flashService } = createHarness({ ports: [CH34X_PORT] });
    serialService.connect.mockRejectedValue(probeError('SERIAL_PROBE_TIMEOUT'));
    service.setSettings({ autoFlash: false, deviceType: 'CUNZHI01' });
    await service.start();
    await Promise.allSettled([...service.runs.values()]);

    expect(flashService.startFlash).not.toHaveBeenCalled();
    expect(entryFor(service, 'COM9').message).toContain('未开启自动烧录');
  });

  it('未选型号时不烧录', async () => {
    const { service, serialService, flashService } = createHarness({ ports: [CH34X_PORT] });
    serialService.connect.mockRejectedValue(probeError('SERIAL_PROBE_TIMEOUT'));
    service.setSettings({ autoFlash: true, deviceType: '' });
    await service.start();
    await Promise.allSettled([...service.runs.values()]);

    expect(flashService.startFlash).not.toHaveBeenCalled();
    expect(entryFor(service, 'COM9').message).toContain('未选择烧录型号');
  });

  it('烧录后二次握手仍失败 → failed 终态并保持端口预留', async () => {
    const { service, serialService } = createHarness({ ports: [CH34X_PORT] });
    serialService.connect.mockRejectedValue(probeError('SERIAL_PROBE_TIMEOUT'));
    service.setSettings({ autoFlash: true, deviceType: 'CUNZHI01' });
    await service.start();
    await Promise.allSettled([...service.runs.values()]);

    const entry = entryFor(service, 'COM9');
    expect(entry.stage).toBe('failed');
    expect(entry.message).toBe('烧录后仍无法连接');
    expect(serialService.reservations.get('COM9')).toBe(service.token);
    expect(serialService.connect).toHaveBeenCalledTimes(
      constants.PROBE_MAX_ATTEMPTS + constants.POST_FLASH_PROBE_ATTEMPTS,
    );
  });

  it('failed 终态不再自动重跑，手动 retry 才重新走流水线', async () => {
    const { service, serialService } = createHarness({ ports: [CH34X_PORT] });
    serialService.connect.mockRejectedValue(probeError('SERIAL_PROBE_TIMEOUT'));
    service.setSettings({ autoFlash: false, deviceType: 'CUNZHI01' });
    await service.start();
    await Promise.allSettled([...service.runs.values()]);
    const attemptsAfterFail = serialService.connect.mock.calls.length;

    service.schedulePipeline('COM9');
    expect(service.runs.has('COM9')).toBe(false);
    expect(serialService.connect).toHaveBeenCalledTimes(attemptsAfterFail);

    serialService.connect.mockResolvedValue({ id: 'aabbccddeeff', type: 'CUNZHI01' });
    await service.retry('COM9');
    await Promise.allSettled([...service.runs.values()]);
    expect(entryFor(service, 'COM9').stage).toBe('connected');
  });

  it('拔出端口清除条目并释放预留', async () => {
    const { service, serialService } = createHarness({ ports: [CH34X_PORT] });
    serialService.connect.mockRejectedValue(probeError('SERIAL_PROBE_TIMEOUT'));
    service.setSettings({ autoFlash: false, deviceType: 'CUNZHI01' });
    await service.start();
    await Promise.allSettled([...service.runs.values()]);
    expect(serialService.reservations.has('COM9')).toBe(true);

    serialService.emit('port-removed', { path: 'COM9' });
    expect(entryFor(service, 'COM9')).toBeUndefined();
    expect(serialService.reservations.has('COM9')).toBe(false);
  });

  it('烧录失败进 failed 且不再二次探测', async () => {
    const { service, serialService, flashService } = createHarness({ ports: [CH34X_PORT] });
    serialService.connect.mockRejectedValue(probeError('SERIAL_PROBE_TIMEOUT'));
    flashService.waitForFlash.mockResolvedValue({
      status: 'failed', error: { code: 'FLASH_CONNECT_FAILED', message: '进入下载模式失败' },
    });
    service.setSettings({ autoFlash: true, deviceType: 'CUNZHI01' });
    await service.start();
    await Promise.allSettled([...service.runs.values()]);

    const entry = entryFor(service, 'COM9');
    expect(entry.stage).toBe('failed');
    expect(entry.error.code).toBe('FLASH_CONNECT_FAILED');
    expect(serialService.connect).toHaveBeenCalledTimes(constants.PROBE_MAX_ATTEMPTS);
  });

  it('热插拔新端口触发流水线', async () => {
    const { service, serialService } = createHarness({ ports: [] });
    serialService.connect.mockResolvedValue({ id: 'aabbccddeeff', type: 'CUNZHI01' });
    await service.start();
    serialService.emit('port-added', CH34X_PORT);
    await Promise.allSettled([...service.runs.values()]);
    expect(entryFor(service, 'COM9').stage).toBe('connected');
  });

  it('设置持久化并通过 update 事件广播', async () => {
    const { service } = createHarness();
    const updates = [];
    service.on('update', (state) => updates.push(state.settings));
    service.setSettings({ autoFlash: true, deviceType: 'TD01' });
    expect(service.getSettings()).toEqual({ autoFlash: true, deviceType: 'TD01' });
    expect(updates.at(-1)).toEqual({ autoFlash: true, deviceType: 'TD01' });
    expect(() => service.setSettings({ autoFlash: 'yes' })).toThrow(/boolean/);
  });
});
