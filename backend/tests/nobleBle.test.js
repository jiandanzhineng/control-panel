const { NobleBle, pickWriteChar, matchesBrand } = require('../brands/nobleBle');
const { NobleBleConnection } = require('../brands/nobleConnection');
const ycy = require('../brands/protocols/ycy');

function fakeChar(uuid, props = { writeWithoutResponse: true }) {
  return {
    uuid,
    properties: props,
    written: [],
    write(buf, _without, cb) { this.written.push(Buffer.from(buf)); cb && cb(); },
    writeAsync(buf) { this.written.push(Buffer.from(buf)); return Promise.resolve(); },
  };
}

describe('nobleBle 写特征选择', () => {
  test('FJB 优先 FF41', () => {
    const ae = fakeChar('0000ae01-0000-1000-8000-00805f9b34fb');
    const ff41 = fakeChar('0000ff41-0000-1000-8000-00805f9b34fb');
    expect(pickWriteChar([ae, ff41]).uuid).toContain('ff41');
  });

  test('noble WinRT 属性是字符串数组也能写', () => {
    const ff41 = { uuid: 'ff41', properties: ['writeWithoutResponse', 'notify'] };
    expect(pickWriteChar([ff41]).uuid).toBe('ff41');
  });

  test('无 write 属性的 FF41 仍选用', () => {
    expect(pickWriteChar([{ uuid: 'ff41', properties: {} }]).uuid).toBe('ff41');
  });

  test('灌肠机一代优先 FF B1', () => {
    const ffb1 = fakeChar('0000ffb1-0000-1000-8000-00805f9b34fb');
    const ff41 = fakeChar('0000ff41-0000-1000-8000-00805f9b34fb');
    expect(pickWriteChar([ff41, ffb1]).uuid).toContain('ffb1');
  });

  test('名称识别杯/电击', () => {
    expect(matchesBrand('ycy', 'YCY-FJB-03')).toBe(true);
    expect(matchesBrand('dglab', 'YCY-FJB-03')).toBe(false);
    expect(matchesBrand('dglab', '47L-123')).toBe(true);
  });

  test('郊狼 3.0 优先 150A，不选 2a00', () => {
    const gap = fakeChar('2a00', { write: true });
    const write = fakeChar('0000150a-0000-1000-8000-00805f9b34fb', { write: true });
    expect(pickWriteChar([gap, write]).uuid).toContain('150a');
    expect(pickWriteChar([gap])).toBeNull();
  });
});

describe('NobleBle connect/write', () => {
  test('连上后写下 FJB 6 字节帧', async () => {
    const write = fakeChar('0000ff41-0000-1000-8000-00805f9b34fb');
    const p = {
      id: '60:55:f9:7c:34:2c',
      address: '60:55:f9:7c:34:2c',
      advertisement: { localName: 'YCY-FJB-03' },
      rssi: -40,
      connectAsync: async () => {},
      discoverAllServicesAndCharacteristicsAsync: async () => ({
        services: [{ characteristics: [write] }],
      }),
      disconnectAsync: async () => {},
    };
    const nobleImpl = {
      state: 'poweredOn',
      on() {},
      removeListener() {},
      startScanningAsync: async () => {},
      stopScanningAsync: async () => {},
    };
    const ble = new NobleBle({ nobleImpl });
    ble._peripherals.set('60:55:f9:7c:34:2c', p);
    const conn = await ble.connect('60:55:f9:7c:34:2c');
    expect(conn.writeUuid.toLowerCase()).toContain('ff41');
    const frame = ycy.buildFjb03({ stroke: 10, vibe: 5, axis: 0 });
    const out = await ble.write('60:55:f9:7c:34:2c', frame);
    expect(write.written[0].equals(frame)).toBe(true);
    expect(out.written).toBe(frame.toString('hex'));
  });

  test('GATT 第一次空特征会重试', async () => {
    const write = fakeChar('0000ff41-0000-1000-8000-00805f9b34fb');
    let n = 0;
    const p = {
      id: 'eb:34:02:8f:f6:a5',
      address: 'eb:34:02:8f:f6:a5',
      advertisement: { localName: 'YCY-XX' },
      state: 'disconnected',
      connectAsync: async () => { p.state = 'connected'; },
      discoverAllServicesAndCharacteristicsAsync: async () => {
        n += 1;
        if (n === 1) return { services: [], characteristics: [] };
        return { services: [{ characteristics: [write] }], characteristics: [write] };
      },
      disconnectAsync: async () => {},
    };
    const ble = new NobleBle({
      nobleImpl: { state: 'poweredOn', on() {}, removeListener() {} },
    });
    ble._peripherals.set('eb:34:02:8f:f6:a5', p);
    const conn = await ble.connect('eb:34:02:8f:f6:a5');
    expect(n).toBeGreaterThan(1);
    expect(conn.writeUuid.toLowerCase()).toContain('ff41');
  });

  test('GATT 一直为空则断开重连再发现', async () => {
    const write = fakeChar('0000ff41-0000-1000-8000-00805f9b34fb');
    let n = 0;
    let disconnected = 0;
    const p = {
      id: 'eb:34:02:8f:f6:a5',
      address: 'eb:34:02:8f:f6:a5',
      advertisement: { localName: 'YCY-XX' },
      state: 'disconnected',
      connectAsync: async () => { p.state = 'connected'; },
      disconnectAsync: async () => { disconnected += 1; p.state = 'disconnected'; },
      discoverAllServicesAndCharacteristicsAsync: async () => {
        n += 1;
        if (disconnected === 0) return { services: [], characteristics: [] };
        return { services: [{ characteristics: [write] }], characteristics: [write] };
      },
    };
    const ble = new NobleBle({
      nobleImpl: { state: 'poweredOn', on() {}, removeListener() {} },
    });
    ble._peripherals.set('eb:34:02:8f:f6:a5', p);
    const conn = await ble.connect('eb:34:02:8f:f6:a5');
    expect(disconnected).toBeGreaterThan(0);
    expect(n).toBeGreaterThan(2);
    expect(conn.writeUuid.toLowerCase()).toContain('ff41');
  });
});

describe('nobleBle 扫描合并', () => {
  test('并行 scan 只启动一次，第一台后很快返回', async () => {
    let starts = 0;
    const listeners = [];
    const p = {
      id: 'aa:bb:cc:dd:ee:ff',
      address: 'aa:bb:cc:dd:ee:ff',
      advertisement: { localName: 'YCY-FJB-03' },
      rssi: -40,
    };
    const nobleImpl = {
      state: 'poweredOn',
      on(ev, fn) { if (ev === 'discover') listeners.push(fn); },
      removeListener(ev, fn) {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
      startScanningAsync: async () => {
        starts += 1;
        setImmediate(() => listeners.forEach((fn) => fn(p)));
      },
      stopScanningAsync: async () => {},
    };
    const ble = new NobleBle({ nobleImpl });
    const t0 = Date.now();
    const [ycyList, dglabList] = await Promise.all([
      ble.scan({ brand: 'ycy' }),
      ble.scan({ brand: 'dglab' }),
    ]);
    expect(starts).toBe(1);
    expect(ycyList[0].name).toBe('YCY-FJB-03');
    expect(dglabList).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('NobleBleConnection 组帧', () => {
  test('setFjb 经 inner 写成 0x35 12', async () => {
    const written = [];
    const ble = {
      connect: async () => {},
      write: async (_a, frame) => { written.push(Buffer.from(frame)); return { ok: true }; },
      disconnect: async () => {},
    };
    const conn = new NobleBleConnection({
      brand: 'ycy', deviceId: '6055f97c342c', address: '60:55:f9:7c:34:2c',
      type: 'YCY_CUP', ble,
    });
    await conn.connect();
    conn.send({ brand: 'ycy', cmd: 'setFjb', stroke: 10, vibe: 5, axis: 0 });
    expect(written[0][0]).toBe(0x35);
    expect(written[0][1]).toBe(0x12);
    expect(written[0][2]).toBe(10);
  });

  test('47L 走 V3，写 150A 的 BF/B0', async () => {
    const written = [];
    const ble = {
      connect: async () => ({ writeUuid: '150a' }),
      write: async (_a, frame, uuid) => {
        written.push({ buf: Buffer.from(frame), uuid });
        return { ok: true };
      },
      disconnect: async () => {},
    };
    const timers = { setInterval: (fn) => { timers.fn = fn; return 1; }, clearInterval: () => {} };
    const conn = new NobleBleConnection({
      brand: 'dglab', deviceId: 'da1ec3bd748e', address: 'da:1e:c3:bd:74:8e',
      type: 'DGLAB', name: '47L121000', ble, timers,
    });
    await conn.connect();
    expect(written[0].buf[0]).toBe(0xBF);
    expect(String(written[0].uuid).toLowerCase()).toContain('150a');
    conn.send({ brand: 'dglab', cmd: 'setPattern', intensity: 50 });
    const b0 = written.find((w) => w.buf[0] === 0xB0 && w.buf[2] === 100);
    expect(b0).toBeTruthy();
    expect(b0.buf[1]).toBe(0x0F);
    await conn.disconnect();
  });

  test('D-LAB 仍走 V2 写 1504', async () => {
    const uuids = [];
    const ble = {
      connect: async () => ({ writeUuid: '955a1504-0fe2-f5aa-a094-84b8d4f3e8ad' }),
      write: async (_a, _frame, uuid) => { uuids.push(uuid); return { ok: true }; },
      disconnect: async () => {},
    };
    const conn = new NobleBleConnection({
      brand: 'dglab', deviceId: 'd1', address: 'aa:bb:cc:dd:ee:ff',
      type: 'DGLAB', name: 'D-LAB ESTIM01', ble,
    });
    await conn.connect();
    conn.send({ brand: 'dglab', cmd: 'stopPattern' });
    expect(String(uuids[0]).toLowerCase()).toContain('1504');
    expect(conn.toMetadata().proto).toBe('v2');
  });

  test('指定写 UUID 找不到则失败', async () => {
    const write = fakeChar('2a00', { write: true });
    const p = {
      id: 'da:1e:c3:bd:74:8e',
      address: 'da:1e:c3:bd:74:8e',
      advertisement: { localName: '47L121000' },
      connectAsync: async () => {},
      discoverAllServicesAndCharacteristicsAsync: async () => ({
        services: [{ characteristics: [write] }],
      }),
      disconnectAsync: async () => {},
    };
    const ble = new NobleBle({
      nobleImpl: { state: 'poweredOn', on() {}, removeListener() {} },
    });
    ble._peripherals.set('da:1e:c3:bd:74:8e', p);
    await expect(ble.connect('da:1e:c3:bd:74:8e')).rejects.toThrow(/写特征/);
    write.uuid = '0000150a-0000-1000-8000-00805f9b34fb';
    await ble.connect('da:1e:c3:bd:74:8e');
    await expect(ble.write('da:1e:c3:bd:74:8e', Buffer.from([1]), '955a1504-0fe2-f5aa-a094-84b8d4f3e8ad'))
      .rejects.toThrow(/写特征不匹配/);
  });
});
