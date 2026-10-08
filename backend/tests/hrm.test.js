/**
 * 心率带（HRM）noble 直连测试：用假 peripheral / 假 noble 覆盖
 * 订阅、身份、电量、断线与 5s 看门狗。假定时器用 jest.useFakeTimers。
 */
const { NobleBle, detectBrand, isHrmPeripheral } = require('../brands/nobleBle');
const { HrmConnection, normalizeMac } = require('../brands/hrmConnection');
const hrs = require('../brands/protocols/hrs');

const ADDR = '60:55:f9:7c:34:2e';

function fakeChar(uuid, props = ['notify', 'read']) {
  let listeners = [];
  return {
    uuid,
    properties: props,
    subscribed: false,
    readValue: null,
    on(ev, fn) { if (ev === 'data') listeners.push(fn); },
    removeListener(ev, fn) { if (ev === 'data') listeners = listeners.filter((x) => x !== fn); },
    listenerCount() { return listeners.length; },
    emit(data) { [...listeners].forEach((fn) => fn(data)); },
    async subscribeAsync() { this.subscribed = true; },
    async unsubscribeAsync() { this.subscribed = false; },
    async readAsync() { return this.readValue; },
  };
}

function fakePeripheral({ name = 'HRM-Virtual', serviceUuids = ['180d'], chars = null } = {}) {
  const list = chars || [
    fakeChar('00002a37-0000-1000-8000-00805f9b34fb'),
    fakeChar('00002a19-0000-1000-8000-00805f9b34fb'),
  ];
  const listeners = new Map();
  return {
    id: ADDR,
    address: ADDR,
    state: 'disconnected',
    advertisement: { localName: name, serviceUuids },
    rssi: -50,
    chars: list,
    async connectAsync() { this.state = 'connected'; },
    async disconnectAsync() { this.state = 'disconnected'; },
    async discoverAllServicesAndCharacteristicsAsync() {
      return { services: [{ characteristics: this.chars }], characteristics: this.chars };
    },
    once(ev, fn) { listeners.set(ev, fn); },
    removeListener() {},
    emitDisconnect() { this.state = 'disconnected'; listeners.get('disconnect')?.(); },
  };
}

function fakeNoble() {
  return { state: 'poweredOn', on() {}, removeListener() {} };
}

function newBle(p) {
  const ble = new NobleBle({ nobleImpl: fakeNoble() });
  ble._peripherals.set(ADDR, p);
  return ble;
}

describe('心率带识别', () => {
  test('广播服务 180D 命中（短号与全 UUID）', () => {
    expect(isHrmPeripheral({ advertisement: { serviceUuids: ['180d'] } })).toBe(true);
    expect(isHrmPeripheral({ advertisement: { serviceUuids: ['0000180d-0000-1000-8000-00805f9b34fb'] } })).toBe(true);
  });

  test('名字关键字兜底（大小写不敏感）', () => {
    expect(detectBrand('HRM-Virtual', {})).toBe('hrm');
    expect(detectBrand('hrm_sensor', {})).toBe('hrm');
    expect(detectBrand('Heart Rate Monitor', {})).toBe('hrm');
    expect(detectBrand('心率带', {})).toBe('hrm');
  });

  test('品牌心率带（名字无关键字）靠广播服务识别', () => {
    const polar = { advertisement: { localName: 'Polar H10', serviceUuids: ['180d'] } };
    expect(detectBrand('Polar H10', polar)).toBe('hrm');
  });

  test('非心率带不误判', () => {
    expect(detectBrand('YCY-FJB-03', {})).toBe('ycy');
    expect(detectBrand('47L121000', {})).toBe('dglab');
  });
});

describe('心率带连接', () => {
  test('不要求写特征：订阅 2A37、读电量、无身份回退地址', async () => {
    const p = fakePeripheral();
    const ble = newBle(p);
    const ready = await ble.connect(ADDR);
    expect(ready.kind).toBe('hrm');
    expect(p.chars[0].subscribed).toBe(true);
    expect(ready.identity).toBe(null);
    expect(ble.getSession(ADDR).kind).toBe('hrm');
  });

  test('没有 2A37 时拒绝连接', async () => {
    const p = fakePeripheral({ chars: [fakeChar('00002a19-0000-1000-8000-00805f9b34fb')] });
    const ble = newBle(p);
    await expect(ble.connect(ADDR)).rejects.toThrow(/2A37/);
  });

  test('有 0xFF04 身份：返回 device_id 与固件版本', async () => {
    const identity = fakeChar('0000ff04-0000-1000-8000-00805f9b34fb');
    identity.readValue = Buffer.from('{"device_id":"aabbccddeeff","firmware_version":"v1.1.38"}');
    const p = fakePeripheral({ chars: [fakeChar('00002a37-0000-1000-8000-00805f9b34fb'), identity] });
    const ble = newBle(p);
    const ready = await ble.connect(ADDR);
    expect(ready.identity).toEqual({ deviceId: 'aabbccddeeff', firmwareVersion: 'v1.1.38' });
  });

  test('身份存在但非法：拒绝连接', async () => {
    const identity = fakeChar('0000ff04-0000-1000-8000-00805f9b34fb');
    identity.readValue = Buffer.from('{"device_id":"NOT-A-MAC","firmware_version":"v1"}');
    const p = fakePeripheral({ chars: [fakeChar('00002a37-0000-1000-8000-00805f9b34fb'), identity] });
    const ble = newBle(p);
    await expect(ble.connect(ADDR)).rejects.toThrow(/device_id/);
  });

  test('连接时读电量并通过事件上报', async () => {
    const battery = fakeChar('00002a19-0000-1000-8000-00805f9b34fb');
    battery.readValue = Buffer.from([88]);
    const p = fakePeripheral({ chars: [fakeChar('00002a37-0000-1000-8000-00805f9b34fb'), battery] });
    const ble = newBle(p);
    const events = [];
    ble.onHrmEvent((e) => events.push(e));
    const ready = await ble.connect(ADDR);
    expect(ready.battery).toBe(88);
    expect(events.find((e) => e.props?.battery === 88)).toBeTruthy();
  });

  test('重复 connect 幂等：不重复订阅、不叠加 data 监听', async () => {
    const p = fakePeripheral();
    const ble = newBle(p);
    const first = await ble.connect(ADDR);
    const second = await ble.connect(ADDR);
    expect(second).toBe(first);
    expect(p.chars[0].listenerCount()).toBe(1);
  });

  test('重连两次后一帧只产生一次上报', async () => {
    const p = fakePeripheral();
    const ble = newBle(p);
    const events = [];
    ble.onHrmEvent((e) => { if (e.type === 'data') events.push(e.props); });
    await ble.connect(ADDR);
    // 断线后再连（nobleBle 会摘掉旧监听），再断线再连：监听不该累积。
    p.emitDisconnect();
    await ble.connect(ADDR);
    p.emitDisconnect();
    await ble.connect(ADDR);
    p.chars[0].emit(Buffer.from([0x06, 133]));
    expect(events.filter((e) => e.heart_rate === 133).length).toBe(1);
  });

  test('主动 disconnect 摘掉 notify 监听并取消订阅', async () => {
    const p = fakePeripheral();
    const ble = newBle(p);
    await ble.connect(ADDR);
    await ble.disconnect(ADDR);
    expect(p.chars[0].listenerCount()).toBe(0);
    expect(p.chars[0].subscribed).toBe(false);
  });

  test('测量帧转发为设备属性', async () => {
    const p = fakePeripheral();
    const ble = newBle(p);
    const events = [];
    ble.onHrmEvent((e) => { if (e.type === 'data') events.push(e.props); });
    await ble.connect(ADDR);
    p.chars[0].emit(Buffer.from([0x06, 133]));
    expect(events[events.length - 1]).toEqual({ heart_rate: 133, hr_status: 'ok', hr_contact: 1 });
  });

  test('断线：清会话并通知监听者', async () => {
    const p = fakePeripheral();
    const ble = newBle(p);
    const events = [];
    ble.onHrmEvent((e) => events.push(e));
    await ble.connect(ADDR);
    p.emitDisconnect();
    expect(ble.getSession(ADDR)).toBe(null);
    expect(events.some((e) => e.type === 'disconnect')).toBe(true);
  });
});

describe('心率带看门狗', () => {
  test('5s 无测量帧 → heart_rate=0 + stale', async () => {
    const p = fakePeripheral();
    const ble = newBle(p);
    const events = [];
    ble.onHrmEvent((e) => { if (e.type === 'data') events.push(e.props); });
    await ble.connect(ADDR);
    p.chars[0].emit(Buffer.from([0x06, 120]));
    // 看门狗用真实定时器轮询（1s 一次，5s 判定），这里把时间轴前移以缩短等待。
    const session = ble.getSession(ADDR);
    session.lastFrameAt = Date.now() - 6000;
    await new Promise((r) => setTimeout(r, 1400));
    const stale = events.find((e) => e.hr_status === 'stale');
    expect(stale).toEqual({ heart_rate: 0, hr_status: 'stale' });
  }, 10000);

  test('持续有帧时不再重复报 stale', async () => {
    const p = fakePeripheral();
    const ble = newBle(p);
    const events = [];
    ble.onHrmEvent((e) => { if (e.type === 'data') events.push(e.props); });
    await ble.connect(ADDR);
    const session = ble.getSession(ADDR);
    session.lastFrameAt = Date.now() - 6000;
    await new Promise((r) => setTimeout(r, 1400));
    expect(events.filter((e) => e.hr_status === 'stale').length).toBe(1);
    // 之后持续有帧：不再重复报
    p.chars[0].emit(Buffer.from([0x06, 121]));
    await new Promise((r) => setTimeout(r, 1400));
    expect(events.filter((e) => e.hr_status === 'stale').length).toBe(1);
  }, 15000);
});

describe('HrmConnection 适配器', () => {
  test('连接后按身份确定设备 ID，缺失则回退 BLE 地址', async () => {
    const p = fakePeripheral();
    const ble = newBle(p);
    const conn = new HrmConnection({ deviceId: 'ffffffffffff', address: ADDR, ble });
    await conn.connect();
    expect(conn.resolvedDeviceId).toBe('6055f97c342e');
    expect(conn.toMetadata().kind).toBe('hrm-ble');
  });

  test('下行命令静默忽略，不抛错', async () => {
    const ble = { connect: async () => ({}), onHrmEvent: () => () => {}, disconnect: async () => {} };
    const conn = new HrmConnection({ deviceId: 'aabbccddeeff', address: ADDR, ble });
    await conn.connect();
    expect(conn.send({ method: 'update', report_delay_ms: 100 })).toEqual({ ok: true, ignored: true });
  });

  test('数据回调把属性交给上层', async () => {
    let handler = null;
    const ble = {
      connect: async () => ({ identity: null }),
      onHrmEvent: (cb) => { handler = cb; return () => {}; },
      disconnect: async () => {},
    };
    const got = [];
    const conn = new HrmConnection({ deviceId: 'aabbccddeeff', address: ADDR, ble, onData: (p) => got.push(p) });
    await conn.connect();
    handler({ type: 'data', address: ADDR, props: { heart_rate: 99, hr_status: 'ok' } });
    expect(got).toContainEqual({ heart_rate: 99, hr_status: 'ok' });
  });

  test('地址规范化与 brandService 同规则', () => {
    expect(normalizeMac('60:55:F9:7C:34:2E')).toBe('6055f97c342e');
    expect(normalizeMac('bad')).toBe('');
  });

  test('hrs 身份解析：缺失返回 null，非法抛错', () => {
    expect(hrs.parseIdentity(null)).toBe(null);
    expect(hrs.parseIdentity(Buffer.from(''))).toBe(null);
    expect(() => hrs.parseIdentity(Buffer.from('{'))).toThrow(/JSON/);
  });
});
