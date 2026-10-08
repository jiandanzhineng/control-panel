/**
 * 心率带在 brandService 层的集成测试：
 * 发现（按广播服务/名字）、连接（设备 ID 取身份特征）、上行属性、断线置离线。
 * deviceService 用 mock，只验证 brandService 编排行为。
 */
const mockMem = new Map();
jest.mock('../utils/fileStorage', () => ({
  getItem: (key) => (mockMem.has(key) ? mockMem.get(key) : null),
  setItem: (key, value) => { mockMem.set(key, String(value)); },
  setItemAsync: async (key, value) => { mockMem.set(key, String(value)); },
}));

const mockDevices = [];
jest.mock('../services/deviceService', () => ({
  getDeviceById: (id) => mockDevices.find((d) => d.id === id) || null,
  listDevicesForApi: () => mockDevices.map((d) => ({ ...d })),
  connectTransportDevice: jest.fn((data) => {
    mockDevices.push({ id: data.id, name: data.name, type: data.type, connected: true, data: {} });
    return mockDevices[mockDevices.length - 1];
  }),
  disconnectTransportDevice: jest.fn((id) => {
    const d = mockDevices.find((x) => x.id === id);
    if (d) d.connected = false;
  }),
  handleTransportMessage: jest.fn((id, payload) => {
    const d = mockDevices.find((x) => x.id === id);
    if (!d) return false;
    d.data = { ...(d.data || {}), ...payload };
    return true;
  }),
  stopExecutionDeviceAndWait: jest.fn(),
  invokeDeviceClose: jest.fn(),
}));

const brandService = require('../brands/brandService');
const deviceService = require('../services/deviceService');

const ADDR = '60:55:f9:7c:34:2e';

function fakeBle({ identity = null, battery = null } = {}) {
  const listeners = new Set();
  const instance = {
    connect: jest.fn(async () => ({ address: ADDR, kind: 'hrm', identity, battery })),
    disconnect: jest.fn(async () => {}),
    onHrmEvent: jest.fn((cb) => { listeners.add(cb); return () => listeners.delete(cb); }),
    emit(evt) { listeners.forEach((cb) => cb(evt)); },
  };
  return instance;
}

describe('心率带发现', () => {
  beforeEach(() => {
    mockMem.clear();
    mockDevices.splice(0, mockDevices.length);
  });

  test('HRM 进入 SUPPORTED 且类型为 HRM', () => {
    expect(brandService.SUPPORTED).toContain('hrm');
    expect(brandService.resolveDeviceType('hrm', {})).toBe('HRM');
  });

  test('广播含 0x180D 或名字带 HRM 都被发现', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        devices: [
          { id: '60:55:f9:7c:34:2e', name: 'HRM-Virtual', serviceUuids: ['180d'], rssi: -50 },
          { id: 'AA:BB:CC:DD:EE:0F', name: 'Polar H10', serviceUuids: ['0000180d-0000-1000-8000-00805f9b34fb'] },
          { id: '11:22:33:44:55:66', name: 'AirPods', serviceUuids: ['180a'] },
        ],
      }),
    }));
    const found = await brandService.discover('hrm', { mode: 'native', fetchImpl });
    expect(found.map((d) => d.deviceId)).toEqual(['6055f97c342e', 'aabbccddee0f']);
    expect(found[0].brand).toBe('hrm');
    expect(found[0].suggestedName).toBe('HRM-Virtual');
  });
});

describe('心率带连接', () => {
  beforeEach(() => {
    mockMem.clear();
    mockDevices.splice(0, mockDevices.length);
    brandService.stopAutoConnect();
  });
  afterEach(async () => {
    brandService.stopAutoConnect();
    // connections 是模块级状态，逐台断开避免污染后续用例。
    for (const id of ['aabbccddeeff', '6055f97c342e']) {
      try { await brandService.disconnect(id); } catch (_) { /* 未连接 */ }
    }
    jest.restoreAllMocks();
  });

  test('有身份特征时设备 ID 取 device_id', async () => {
    const ble = fakeBle({ identity: { deviceId: 'aabbccddeeff', firmwareVersion: 'v1.1.38' }, battery: 77 });
    const res = await brandService.connect('hrm', { mode: 'native', address: ADDR, name: 'HRM-Virtual', ble });
    expect(res.type).toBe('HRM');
    expect(deviceService.connectTransportDevice).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'aabbccddeeff', type: 'HRM', connectionType: 'brand' }),
      expect.anything(),
    );
    const dev = brandService.list()[0];
    expect(dev.deviceId).toBe('aabbccddeeff');
    expect(dev.connected).toBe(true);
    expect(dev.metadata.kind).toBe('hrm-ble');
  });

  test('无身份特征（第三方心率带）回退规范化 BLE 地址', async () => {
    const ble = fakeBle({ identity: null });
    await brandService.connect('hrm', { mode: 'native', address: ADDR, name: 'Polar H10', ble });
    expect(deviceService.connectTransportDevice).toHaveBeenCalledWith(
      expect.objectContaining({ id: '6055f97c342e', type: 'HRM' }),
      expect.anything(),
    );
  });

  test('连接后测量帧经 handleTransportMessage 进入设备层', async () => {
    const ble = fakeBle({ identity: { deviceId: 'aabbccddeeff', firmwareVersion: 'v1' } });
    await brandService.connect('hrm', { mode: 'native', address: ADDR, name: 'HRM-Virtual', ble });
    ble.emit({ type: 'data', address: ADDR, props: { heart_rate: 128, hr_status: 'ok', hr_contact: 1 } });
    expect(deviceService.handleTransportMessage).toHaveBeenCalledWith(
      'aabbccddeeff',
      expect.objectContaining({ method: 'update', heart_rate: 128, hr_status: 'ok' }),
      'brand',
    );
  });

  test('断线：设备置离线且清会话（交给自动连接 tick 重连）', async () => {
    const ble = fakeBle({ identity: { deviceId: 'aabbccddeeff', firmwareVersion: 'v1' } });
    await brandService.connect('hrm', { mode: 'native', address: ADDR, name: 'HRM-Virtual', ble });
    expect(brandService.list()).toHaveLength(1);
    ble.emit({ type: 'disconnect', address: ADDR });
    // 断线后连接对象已从编排表移除（设备层同步解注册），自动连接 tick 会重新发现并连上。
    expect(brandService.list()).toHaveLength(0);
    expect(deviceService.disconnectTransportDevice).toHaveBeenCalledWith('aabbccddeeff', 'brand');
  });

  test('心率带记录进入已保存 BLE 名单（自动连接依据）', () => {
    mockDevices.push({ id: 'aabbccddeeff', name: 'HRM-Virtual', type: 'HRM', connected: true });
    const saved = brandService.listSavedBleDevices();
    expect(saved).toEqual([
      { deviceId: 'aabbccddeeff', browserDeviceId: 'aabbccddeeff', name: 'HRM-Virtual', type: 'HRM', connected: true },
    ]);
  });
});
