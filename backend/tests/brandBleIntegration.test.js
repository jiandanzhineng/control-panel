/**
 * Electron 主进程 brandBle:* IPC 集成链路测试。
 *
 * 覆盖：渲染进程发起 brandBle:connected → 主进程经 getBrandService().attachWebBle
 * 注册进 deviceService → 后端/玩法经 send 闭包把命令经 IPC 回渲染进程写 GATT →
 * 渲染进程回 brandBle:command-result → 电量经 brandBle:property 回传 →
 * brandBle:disconnected 清理 owner/transport/detach。
 *
 * 与 electronBleIntegration.test.js 不同：这里驱动的是 DG-LAB V2 的 brandBle 通道，
 * 且 select-bluetooth-device 只接纳 V2 广播名关键字（拒绝非 V2 设备）。
 */
const { createBrandBleMainIntegration } = require('../../electron/ble/brandMainIntegration');

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

function createWebContents(id) {
  const handlers = new Map();
  return {
    id,
    send: jest.fn(),
    on: jest.fn((event, handler) => handlers.set(event, handler)),
    isDestroyed: jest.fn(() => false),
    _handlers: handlers,
  };
}

describe('Electron brandBle (DG-LAB V2) main integration', () => {
  it('只接纳 V2 广播名的扫描候选', () => {
    const ipcMain = createIpcMain();
    const webContents = createWebContents(11);
    const integration = createBrandBleMainIntegration({
      ipcMain,
      getDeviceService: () => ({}),
      getBrandService: () => ({}),
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    integration.registerHandlers();
    integration.attachWindow({ webContents });

    const select = jest.fn();
    const selectionEvent = { preventDefault: jest.fn() };
    webContents._handlers.get('select-bluetooth-device')(
      selectionEvent,
      [
        { deviceId: 'a', deviceName: 'AirPods' },          // 拒
        { deviceId: 'b', deviceName: 'D-LAB ESTIM01' },    // 纳
        { deviceId: 'c', deviceName: 'YSKJ-2024' },        // 纳
        { deviceId: 'd', deviceName: 'YCY-FJB-03' },       // 纳
      ],
      select,
    );

    expect(selectionEvent.preventDefault).toHaveBeenCalled();
    const sent = webContents.send.mock.calls.find(([c]) => c === 'brandBle:scan-results')[1];
    expect(sent.map((x) => x.id).sort()).toEqual(['b', 'c', 'd']);
  });

  it('连通后注册进 deviceService，且命令经 IPC 回渲染进程写 GATT', async () => {
    const ipcMain = createIpcMain();
    const deviceService = {
      connectTransportDevice: jest.fn(),
      handleTransportProperty: jest.fn(),
      handleTransportMessage: jest.fn(),
      disconnectTransportDevice: jest.fn(),
    };
    const brandService = { attachWebBle: jest.fn(() => true), detachWebBle: jest.fn() };
    const webContents = createWebContents(12);
    const integration = createBrandBleMainIntegration({
      ipcMain,
      getDeviceService: () => deviceService,
      getBrandService: () => brandService,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    integration.registerHandlers();
    integration.attachWindow({ webContents });

    const metadata = {
      id: 'ble:v2-device',
      name: 'D-LAB ESTIM01',
      type: 'DGLAB',
      connectionType: 'brandBle',
      data: { battery: 90 },
    };
    await ipcMain.invoke('brandBle:connected', { sender: webContents }, metadata);

    // 主进程调用了 brandService.attachWebBle
    expect(brandService.attachWebBle).toHaveBeenCalledWith(
      metadata,
      expect.any(Function),
    );
    // attachWebBle 内部会把设备注册进 deviceService（由真实 brandService 完成）
    // 这里验证 send 闭包能经 IPC 把命令发回渲染进程
    const send = brandService.attachWebBle.mock.calls[0][1];
    const sending = send({ characteristic: 'pwmAB2', value: [0, 0] });

    const cmdCall = webContents.send.mock.calls.find(([c]) => c === 'brandBle:command');
    expect(cmdCall).toBeTruthy();
    expect(cmdCall[1]).toMatchObject({
      id: 'ble:v2-device',
      message: { characteristic: 'pwmAB2', value: [0, 0] },
      requestId: expect.any(String),
    });

    // 渲染进程完成写 GATT，回 result
    ipcMain.emit('brandBle:command-result', { sender: webContents }, {
      id: 'ble:v2-device',
      requestId: cmdCall[1].requestId,
      ok: true,
    });
    await expect(sending).resolves.toEqual({ ok: true });
  });

  it('电量属性经 brandBle:property 路由到 deviceService', async () => {
    const ipcMain = createIpcMain();
    const deviceService = {
      connectTransportDevice: jest.fn(),
      handleTransportProperty: jest.fn(),
      handleTransportMessage: jest.fn(),
      disconnectTransportDevice: jest.fn(),
    };
    const webContents = createWebContents(13);
    const integration = createBrandBleMainIntegration({
      ipcMain,
      getDeviceService: () => deviceService,
      getBrandService: () => ({ attachWebBle: jest.fn(() => true), detachWebBle: jest.fn() }),
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    integration.registerHandlers();
    integration.attachWindow({ webContents });

    // 先连上，建立 owner 关系（property/message/disconnected 均校验 owner）
    await ipcMain.invoke('brandBle:connected', { sender: webContents }, {
      id: 'ble:v2-device', type: 'DGLAB', connectionType: 'brandBle', data: {},
    });

    ipcMain.emit('brandBle:property', { sender: webContents }, {
      id: 'ble:v2-device', key: 'battery', value: 77,
    });
    expect(deviceService.handleTransportProperty)
      .toHaveBeenCalledWith('ble:v2-device', 'battery', 77, 'brandBle');
  });

  it('渲染进程写 GATT 失败时 reject 调用方', async () => {
    const ipcMain = createIpcMain();
    const deviceService = {
      connectTransportDevice: jest.fn(),
      handleTransportProperty: jest.fn(),
      handleTransportMessage: jest.fn(),
      disconnectTransportDevice: jest.fn(),
    };
    const brandService = { attachWebBle: jest.fn(() => true), detachWebBle: jest.fn() };
    const webContents = createWebContents(14);
    const integration = createBrandBleMainIntegration({
      ipcMain,
      getDeviceService: () => deviceService,
      getBrandService: () => brandService,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    integration.registerHandlers();
    integration.attachWindow({ webContents });

    await ipcMain.invoke('brandBle:connected', { sender: webContents }, {
      id: 'ble:v2-device', type: 'DGLAB', connectionType: 'brandBle', data: {},
    });
    const send = brandService.attachWebBle.mock.calls[0][1];
    const sending = send({ characteristic: 'pwmAB2', value: [1, 0] });
    const cmdCall = webContents.send.mock.calls.find(([c]) => c === 'brandBle:command')[1];
    ipcMain.emit('brandBle:command-result', { sender: webContents }, {
      id: 'ble:v2-device',
      requestId: cmdCall.requestId,
      ok: false,
      code: 'GATT_WRITE_FAILED',
      error: 'characteristic not writable',
    });
    await expect(sending).rejects.toMatchObject({
      code: 'GATT_WRITE_FAILED',
      message: 'characteristic not writable',
    });
  });

  it('断开时清理 owner、transport 与 brandService 登记', async () => {
    const ipcMain = createIpcMain();
    const deviceService = {
      connectTransportDevice: jest.fn(),
      handleTransportProperty: jest.fn(),
      handleTransportMessage: jest.fn(),
      disconnectTransportDevice: jest.fn(),
    };
    const brandService = { attachWebBle: jest.fn(() => true), detachWebBle: jest.fn() };
    const webContents = createWebContents(15);
    const integration = createBrandBleMainIntegration({
      ipcMain,
      getDeviceService: () => deviceService,
      getBrandService: () => brandService,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    integration.registerHandlers();
    integration.attachWindow({ webContents });

    // 先连上，建立 owner 关系
    await ipcMain.invoke('brandBle:connected', { sender: webContents }, {
      id: 'ble:v2-device', type: 'DGLAB', connectionType: 'brandBle', data: {},
    });
    expect(brandService.attachWebBle).toHaveBeenCalled();

    ipcMain.emit('brandBle:disconnected', { sender: webContents }, { id: 'ble:v2-device' });
    expect(deviceService.disconnectTransportDevice)
      .toHaveBeenCalledWith('ble:v2-device', 'brandBle');
    expect(brandService.detachWebBle).toHaveBeenCalledWith('ble:v2-device');
  });

  it('拒绝非 brandBle 连接类型的元数据', () => {
    const ipcMain = createIpcMain();
    const integration = createBrandBleMainIntegration({
      ipcMain,
      getDeviceService: () => ({}),
      getBrandService: () => ({}),
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    integration.registerHandlers();
    expect(() => ipcMain.invoke('brandBle:connected', { sender: createWebContents(16) }, {
      id: 'x', connectionType: 'ble',
    })).toThrow(TypeError);
  });
});
