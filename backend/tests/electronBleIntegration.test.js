const { createBleMainIntegration } = require('../../electron/ble/mainIntegration');

function createIpcMain() {
  const handles = new Map();
  const listeners = new Map();
  return {
    handle: jest.fn((channel, handler) => handles.set(channel, handler)),
    on: jest.fn((channel, handler) => listeners.set(channel, handler)),
    invoke(channel, event, ...args) {
      return handles.get(channel)(event, ...args);
    },
    emit(channel, event, ...args) {
      return listeners.get(channel)(event, ...args);
    },
  };
}

describe('Electron BLE main integration', () => {
  it('selects admitted candidates and bridges the connected transport', async () => {
    const ipcMain = createIpcMain();
    const deviceService = {
      connectTransportDevice: jest.fn(),
      handleTransportProperty: jest.fn(),
      handleTransportMessage: jest.fn(),
      disconnectTransportDevice: jest.fn(),
    };
    const webContentsHandlers = new Map();
    const webContents = {
      id: 7,
      send: jest.fn(),
      on: jest.fn((event, handler) => webContentsHandlers.set(event, handler)),
      isDestroyed: jest.fn(() => false),
    };
    const integration = createBleMainIntegration({
      ipcMain,
      getDeviceService: () => deviceService,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    integration.registerHandlers();
    integration.attachWindow({ webContents });

    const select = jest.fn();
    const selectionEvent = { preventDefault: jest.fn() };
    webContentsHandlers.get('select-bluetooth-device')(
      selectionEvent,
      [
        { deviceId: 'wrong', deviceName: 'Headphones' },
        { deviceId: 'esp32', deviceName: 'BLUFI' },
      ],
      select,
    );

    expect(selectionEvent.preventDefault).toHaveBeenCalled();
    expect(webContents.send).toHaveBeenCalledWith('ble:scan-results', [
      { id: 'esp32', name: 'BLUFI' },
    ]);
    await ipcMain.invoke('ble:select-device', { sender: webContents }, 'esp32');
    expect(select).toHaveBeenCalledWith('esp32');

    const metadata = {
      id: 'ble:esp32',
      name: 'BLUFI',
      type: 'TD01',
      connectionType: 'ble',
      data: { power: 0 },
    };
    await ipcMain.invoke('ble:connected', { sender: webContents }, metadata);
    expect(deviceService.connectTransportDevice).toHaveBeenCalledWith(
      metadata,
      expect.objectContaining({ kind: 'ble', send: expect.any(Function) }),
    );

    const transport = deviceService.connectTransportDevice.mock.calls[0][1];
    const sending = transport.send({ method: 'update', power: 128 });
    expect(webContents.send).toHaveBeenCalledWith('ble:command', expect.objectContaining({
      id: 'ble:esp32',
      message: { method: 'update', power: 128 },
      requestId: expect.any(String),
    }));
    const request = webContents.send.mock.calls.find(([channel]) => channel === 'ble:command')[1];
    ipcMain.emit('ble:command-result', { sender: webContents }, {
      id: 'ble:esp32', requestId: request.requestId, ok: true,
    });
    await expect(sending).resolves.toEqual({ ok: true });

    ipcMain.emit('ble:property', { sender: webContents }, {
      id: 'ble:esp32', key: 'power', value: 64,
    });
    expect(deviceService.handleTransportProperty)
      .toHaveBeenCalledWith('ble:esp32', 'power', 64, 'ble');
  });

  it('returns renderer BLE write failures to the caller', async () => {
    const ipcMain = createIpcMain();
    const deviceService = {
      connectTransportDevice: jest.fn(),
      handleTransportProperty: jest.fn(),
      handleTransportMessage: jest.fn(),
      disconnectTransportDevice: jest.fn(),
    };
    const webContents = {
      id: 8,
      send: jest.fn(),
      on: jest.fn(),
      isDestroyed: jest.fn(() => false),
    };
    const integration = createBleMainIntegration({
      ipcMain,
      getDeviceService: () => deviceService,
    });
    integration.registerHandlers();
    const metadata = {
      id: 'ble:esp32', type: 'TD01', connectionType: 'ble', data: {},
    };
    await ipcMain.invoke('ble:connected', { sender: webContents }, metadata);
    const transport = deviceService.connectTransportDevice.mock.calls[0][1];

    const sending = transport.send({ method: 'update', power: 128 });
    const request = webContents.send.mock.calls[0][1];
    ipcMain.emit('ble:command-result', { sender: webContents }, {
      id: 'ble:esp32',
      requestId: request.requestId,
      ok: false,
      code: 'BLE_PROPERTY_NOT_WRITABLE',
      error: 'power is not writable',
    });

    await expect(sending).rejects.toMatchObject({
      code: 'BLE_PROPERTY_NOT_WRITABLE',
      message: 'power is not writable',
    });
  });

  it('waits for the BLE renderer to safely disconnect every device', async () => {
    const ipcMain = createIpcMain();
    const webContents = {
      id: 9,
      send: jest.fn(),
      on: jest.fn(),
      isDestroyed: jest.fn(() => false),
    };
    const integration = createBleMainIntegration({
      ipcMain,
      getDeviceService: () => ({ disconnectTransportDevice: jest.fn() }),
    });
    integration.registerHandlers();

    const disconnecting = integration.requestDisconnectAll({ webContents }, { timeoutMs: 100 });
    expect(webContents.send).toHaveBeenCalledWith(
      'ble:disconnect-all',
      expect.objectContaining({ requestId: expect.any(String) }),
    );

    const request = webContents.send.mock.calls.find(([channel]) => channel === 'ble:disconnect-all')[1];
    ipcMain.emit('ble:disconnect-all-complete', { sender: webContents }, {
      requestId: request.requestId,
      ok: true,
    });

    await expect(disconnecting).resolves.toEqual({ ok: true });
  });
});
