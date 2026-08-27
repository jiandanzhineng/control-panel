jest.mock('electron', () => ({
  ipcRenderer: {
    invoke: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
    send: jest.fn(),
  },
}));

const { BLE_UUIDS } = require('../../electron/ble/protocol');

describe('Electron BLE preload API', () => {
  const originalWindow = global.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(global, 'navigator');

  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;

    if (originalNavigator) Object.defineProperty(global, 'navigator', originalNavigator);
    else delete global.navigator;
  });

  it('uses the BLUFI name filter required by Electron discovery on Windows', async () => {
    const cancelled = Object.assign(new Error('Selection cancelled'), { name: 'NotFoundError' });
    const requestDevice = jest.fn().mockRejectedValue(cancelled);
    global.window = { fetch: jest.fn() };
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: { bluetooth: { requestDevice } },
    });

    require('../../electron/preload');

    await expect(global.window.bleApi.connect()).rejects.toBe(cancelled);
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ namePrefix: 'BLUFI' }],
      optionalServices: [BLE_UUIDS.service],
    });
  });

  it('exposes provisioning device selection and scan result IPC', async () => {
    const { ipcRenderer } = require('electron');
    global.window = { fetch: jest.fn() };
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: { bluetooth: { requestDevice: jest.fn() } },
    });
    ipcRenderer.invoke.mockResolvedValue({ ok: true });

    require('../../electron/preload');

    expect(global.window.provisionApi.isSupported()).toBe(true);
    await global.window.provisionApi.selectDevice('device-1');
    await global.window.provisionApi.cancelSelection();
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, 'ble:select-device', 'device-1');
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, 'ble:cancel-selection');

    const callback = jest.fn();
    const dispose = global.window.provisionApi.onScanResults(callback);
    const listener = ipcRenderer.on.mock.calls.find(([channel]) => channel === 'ble:scan-results')[1];
    listener({}, [{ id: 'device-1', name: 'BLUFI_DEVICE' }]);
    expect(callback).toHaveBeenCalledWith([{ id: 'device-1', name: 'BLUFI_DEVICE' }]);

    dispose();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('ble:scan-results', listener);
  });

  it('includes the official YCY EMS service for Windows Web Bluetooth', async () => {
    const cancelled = Object.assign(new Error('Selection cancelled'), { name: 'NotFoundError' });
    const requestDevice = jest.fn().mockRejectedValue(cancelled);
    global.window = { fetch: jest.fn() };
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: { bluetooth: { requestDevice } },
    });

    require('../../electron/preload');

    await expect(global.window.ycyBleApi.connect()).rejects.toBe(cancelled);
    expect(requestDevice).toHaveBeenCalledWith(expect.objectContaining({
      acceptAllDevices: true,
      optionalServices: expect.arrayContaining(['98a9cd00-ca0a-4cf8-9f85-e93949467558']),
    }));
  });

  it('brandBle connect scans all nearby brand devices without namePrefix', async () => {
    const cancelled = Object.assign(new Error('Selection cancelled'), { name: 'NotFoundError' });
    const requestDevice = jest.fn().mockRejectedValue(cancelled);
    global.window = { fetch: jest.fn() };
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: { bluetooth: { requestDevice } },
    });
    jest.resetModules();
    require('../../electron/preload');
    await expect(global.window.brandBleApi.connect()).rejects.toBe(cancelled);
    expect(requestDevice).toHaveBeenCalledWith(expect.objectContaining({
      acceptAllDevices: true,
      optionalServices: expect.arrayContaining([
        '955a180b-0fe2-f5aa-a094-84b8d4f3e8ad',
        '0000ff40-0000-1000-8000-00805f9b34fb',
      ]),
    }));
  });

  it('getKnownDevices 用 getDevices，不弹选择框', async () => {
    const requestDevice = jest.fn();
    const getDevices = jest.fn().mockResolvedValue([{ id: 'chrome-1', name: 'YCY-FJB-03' }]);
    global.window = { fetch: jest.fn() };
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: { bluetooth: { requestDevice, getDevices } },
    });
    require('../../electron/preload');
    await expect(global.window.brandBleApi.getKnownDevices()).resolves.toEqual([
      { id: 'chrome-1', name: 'YCY-FJB-03' },
    ]);
    expect(requestDevice).not.toHaveBeenCalled();
  });

  it('connectKnown 找不到已授权设备时不调用 requestDevice', async () => {
    const requestDevice = jest.fn();
    const getDevices = jest.fn().mockResolvedValue([]);
    global.window = { fetch: jest.fn() };
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: { bluetooth: { requestDevice, getDevices } },
    });
    require('../../electron/preload');
    await expect(global.window.brandBleApi.connectKnown('chrome-1')).rejects.toThrow(/不可见/);
    expect(requestDevice).not.toHaveBeenCalled();
  });
});
