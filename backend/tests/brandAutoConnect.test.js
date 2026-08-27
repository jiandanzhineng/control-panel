const mockMem = new Map();
jest.mock('../utils/fileStorage', () => ({
  getItem: (key) => (mockMem.has(key) ? mockMem.get(key) : null),
  setItem: (key, value) => { mockMem.set(key, String(value)); },
}));

const mockDevices = [];
jest.mock('../services/deviceService', () => ({
  getDeviceById: (id) => mockDevices.find((d) => d.id === id) || null,
  listDevicesForApi: () => mockDevices.map((d) => ({ ...d })),
  connectTransportDevice: jest.fn(),
  disconnectTransportDevice: jest.fn(),
  stopExecutionDeviceAndWait: jest.fn(),
  invokeDeviceClose: jest.fn(),
}));

const brandService = require('../brands/brandService');

describe('品牌蓝牙自动连接设置', () => {
  beforeEach(() => {
    mockMem.clear();
    mockDevices.splice(0, mockDevices.length);
    brandService.stopAutoConnect();
  });
  afterEach(() => {
    brandService.stopAutoConnect();
  });

  test('默认开启已保存与所有支持自动连接', () => {
    expect(brandService.getSettings()).toEqual({ autoConnect: true, autoConnectAll: true });
  });

  test('PUT 后能读回关闭状态', () => {
    expect(brandService.setSettings({ autoConnect: false })).toEqual({
      autoConnect: false, autoConnectAll: true,
    });
    expect(brandService.setSettings({ autoConnectAll: false })).toEqual({
      autoConnect: false, autoConnectAll: false,
    });
    expect(brandService.getSettings()).toEqual({ autoConnect: false, autoConnectAll: false });
  });

  test('非法 autoConnect 抛错', () => {
    expect(() => brandService.setSettings({})).toThrow(/布尔/);
  });

  test('已保存名单来自设备列表，删除后不再出现', () => {
    mockDevices.push(
      { id: 'ycy:chrome-1', name: '杯', type: 'YCY_CUP', connected: false },
      { id: 'dglab-v2-chrome-2', name: '郊狼', type: 'DGLAB', connected: true },
      { id: 'aabbccddeeff', name: '往复', type: 'PJ01', connected: true },
    );
    expect(brandService.listSavedBleDevices()).toEqual([
      { deviceId: 'ycy:chrome-1', browserDeviceId: 'chrome-1', name: '杯', type: 'YCY_CUP', connected: false },
      { deviceId: 'dglab-v2-chrome-2', browserDeviceId: 'chrome-2', name: '郊狼', type: 'DGLAB', connected: true },
    ]);
    mockDevices.splice(0, 1);
    expect(brandService.listSavedBleDevices().map((d) => d.deviceId)).toEqual(['dglab-v2-chrome-2']);
  });

  test('广播名相同则沿用已保存设备 id', () => {
    mockDevices.push({
      id: 'ycy:old-id', name: 'YCY-FJB-03-DJ', type: 'YCY_CUP', connected: false,
    });
    const meta = { id: 'ycy:new-id', name: 'YCY-FJB-03-DJ' };
    brandService.stabilizeBrandBleId(meta);
    expect(meta.id).toBe('ycy:old-id');
  });

  test('native 连接经本机桥并用地址作设备 id', async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (String(url).includes('/api/connect')) {
        return { ok: true, json: async () => ({ ok: true, id: 'AA:BB' }) };
      }
      if (String(url).includes('/api/devices')) {
        return { ok: true, json: async () => ({ devices: [{ id: 'AA:BB', name: 'YCY-FJB-03-DJ', ready: true }] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const deviceService = require('../services/deviceService');
    await brandService.connect('ycy', {
      mode: 'native', address: 'AA:BB', name: 'YCY-FJB-03-DJ', fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/connect?addr=AA'), expect.anything());
    expect(deviceService.connectTransportDevice).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ycy:AA:BB', connectionType: 'brand' }),
      expect.anything(),
    );
    await brandService.disconnect('ycy:AA:BB');
  });

  test('native 扫描走本机桥并过滤非品牌名', async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (String(url).includes('/api/devices')) {
        return {
          ok: true,
          json: async () => ({
            devices: [
              { id: 'AA:BB:CC:DD:EE:FF', name: 'YCY-FJB-03-DJ', rssi: -50, ready: false },
              { id: '11:22', name: 'AirPods', rssi: -40, ready: false },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const found = await brandService.discover('ycy', { mode: 'native', fetchImpl });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      address: 'AA:BB:CC:DD:EE:FF',
      deviceId: 'ycy:AA:BB:CC:DD:EE:FF',
      mode: 'native',
    });
  });

  test('同名多条时优先沿用已连接记录', () => {
    mockDevices.push(
      { id: 'ycy:ghost', name: 'YCY-FJB-03-DJ', type: 'YCY_CUP', connected: false },
      { id: 'ycy:live', name: 'YCY-FJB-03-DJ', type: 'YCY_CUP', connected: true },
    );
    const meta = { id: 'ycy:new-id', name: 'YCY-FJB-03-DJ' };
    brandService.stabilizeBrandBleId(meta);
    expect(meta.id).toBe('ycy:live');
  });
});
