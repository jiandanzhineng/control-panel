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

  test('MAC 设备 ID 小写无冒号无前缀', () => {
    expect(brandService.normalizeMacDeviceId('FF:26:02:28:4C:CD')).toBe('ff2602284ccd');
    expect(brandService.normalizeMacDeviceId('ycy:AA:BB:CC:DD:EE:FF')).toBe('aabbccddeeff');
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
    mockDevices.push({ id: 'ff2602284ccd', name: '杯2', type: 'YCY_CUP', connected: false });
    expect(brandService.listSavedBleDevices().map((d) => d.deviceId)).toEqual(['dglab-v2-chrome-2', 'ff2602284ccd']);
  });

  test('广播名相同则沿用已保存设备 id', () => {
    mockDevices.push({
      id: 'ycy:old-id', name: 'YCY-FJB-03-DJ', type: 'YCY_CUP', connected: false,
    });
    // 无浏览器身份可比对时，按名字认回那条离线记录（保住昵称与玩法映射）。
    const meta = { id: 'anon-new', name: 'YCY-FJB-03-DJ' };
    brandService.stabilizeBrandBleId(meta);
    expect(meta.id).toBe('ycy:old-id');
  });

  test('native 连接经本机桥并用地址作设备 id', async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (String(url).includes('/api/connect')) {
        return { ok: true, json: async () => ({ ok: true, id: 'AA:BB' }) };
      }
      if (String(url).includes('/api/devices')) {
        return { ok: true, json: async () => ({ devices: [{ id: 'AA:BB:CC:DD:EE:FF', name: 'YCY-FJB-03-DJ', ready: true }] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const deviceService = require('../services/deviceService');
    await brandService.connect('ycy', {
      mode: 'native', address: 'AA:BB:CC:DD:EE:FF', name: 'YCY-FJB-03-DJ', fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/connect?addr=AA'), expect.anything());
    expect(deviceService.connectTransportDevice).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'aabbccddeeff', connectionType: 'brand' }),
      expect.anything(),
    );
    await brandService.disconnect('aabbccddeeff');
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
      deviceId: 'aabbccddeeff',
      mode: 'native',
    });
  });

  test('browserDeviceId 相同则认回同一台（跨重连保住昵称）', () => {
    mockDevices.push(
      { id: 'ycy:chromium-aaa', name: 'YCY-FJB-03-DJ', type: 'YCY_CUP', connected: false },
    );
    const meta = { id: 'ycy:new-id', name: 'YCY-FJB-03-DJ', browserDeviceId: 'chromium-aaa' };
    brandService.stabilizeBrandBleId(meta);
    expect(meta.id).toBe('ycy:chromium-aaa');
  });

  test('无浏览器身份时按名字认回一条离线记录', () => {
    mockDevices.push(
      { id: 'ycy:ghost', name: 'YCY-FJB-03-DJ', type: 'YCY_CUP', connected: false },
      { id: 'ycy:live', name: 'YCY-FJB-03-DJ', type: 'YCY_CUP', connected: true },
    );
    // id 不带品牌前缀 → 无从解析浏览器身份，才允许名字兜底；且必须挑离线那条。
    const meta = { id: 'anon-1', name: 'YCY-FJB-03-DJ' };
    brandService.stabilizeBrandBleId(meta);
    expect(meta.id).toBe('ycy:ghost');
  });

  test('浏览器身份不匹配时独立注册，不抢在线同名设备', () => {
    mockDevices.push(
      { id: 'ycy:first', name: 'YCY-FJB-03-DJ', type: 'YCY_CUP', connected: true },
    );
    const meta = { id: 'ycy:second', name: 'YCY-FJB-03-DJ' };
    brandService.stabilizeBrandBleId(meta);
    expect(meta.id).toBe('ycy:second');
  });
});

describe('品牌连接断线重连', () => {
  beforeEach(() => {
    mockMem.clear();
    mockDevices.splice(0, mockDevices.length);
    brandService.stopAutoConnect();
  });
  afterEach(() => { brandService.stopAutoConnect(); });

  // 回归：setState 若不透传 reconnectAttempts，计数永远停在 1，
  // MAX_RECONNECT 永不触达 —— 退化为每 10s 无限重试且永远停留「重连中」。
  test('重试三次后放弃，退避递增且不再重连', async () => {
    const realTimeout = global.setTimeout;
    const delays = [];
    let depth = 0;
    global.setTimeout = (fn, ms) => {
      delays.push(ms);
      if (depth++ > 12) return { unref() {} };
      realTimeout(fn, 0);
      return { unref() {} };
    };
    let first = true;
    class WS {
      constructor() {
        this.readyState = 1;
        if (first) {
          first = false;
          realTimeout(() => { this.onopen?.(); realTimeout(() => this.onclose?.(), 0); }, 0);
        } else {
          realTimeout(() => this.onerror?.(new Error('refused')), 0);
        }
      }
      on() {} once() {} send() {} close() {} ping() {}
    }
    try {
      await brandService.connect('dglab', { host: '10.255.255.1', WebSocketClass: WS });
      await new Promise((r) => realTimeout(r, 300));
      expect(delays).toEqual([5000, 10000, 15000]);
      const dev = brandService.list()[0];
      expect(dev.status).toBe('error');
      expect(dev.reconnecting).toBe(false);
    } finally {
      global.setTimeout = realTimeout;
      try { await brandService.disconnect('dglab-10.255.255.1'); } catch (_) { /* 已清理 */ }
    }
  });
});
