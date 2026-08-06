jest.mock('electron', () => ({
  ipcRenderer: {
    invoke: jest.fn(),
    on: jest.fn(),
    send: jest.fn(),
  },
}));

const { BLE_UUIDS } = require('../../electron/ble/protocol');

describe('Electron BLE preload API', () => {
  const originalWindow = global.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(global, 'navigator');

  afterEach(() => {
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
});
