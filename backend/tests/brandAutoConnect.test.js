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
