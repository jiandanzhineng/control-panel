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

  test('名称识别杯/电击', () => {
    expect(matchesBrand('ycy', 'YCY-FJB-03')).toBe(true);
    expect(matchesBrand('dglab', 'YCY-FJB-03')).toBe(false);
    expect(matchesBrand('dglab', '47L-123')).toBe(true);
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
});
