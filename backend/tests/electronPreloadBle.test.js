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
});
