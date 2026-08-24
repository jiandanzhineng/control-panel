/**
 * DG-LAB V2 Web Bluetooth 连接适配器与 brandService 接入测试。
 * 用注入的 send 闭包模拟「主进程 → 渲染进程 GATT 写队列」的 IPC 转发。
 */
const { DGLabV2WebBleConnection } = require('../brands/webBleConnection');
const v2 = require('../brands/protocols/dglabV2');

describe('DGLabV2WebBleConnection 适配器', () => {
  test('send 将品牌命令翻译后经 transportSend 下发', async () => {
    const sent = [];
    const conn = new DGLabV2WebBleConnection({
      deviceId: 'dglab-v2-x',
      send: (ops) => { sent.push(ops); return Promise.resolve({ ok: true }); },
    });
    await conn.send({ brand: 'dglab', cmd: 'v2_setStrength', a: 100, b: 50 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([{ characteristic: 'pwmAB2', value: v2.packStrength({ a: 100, b: 50 }) }]);
  });

  test('disconnect 经 transportSend 下发断开指令', () => {
    const sent = [];
    const conn = new DGLabV2WebBleConnection({
      deviceId: 'dglab-v2-x',
      send: (m) => { sent.push(m); return Promise.resolve(); },
    });
    conn.disconnect();
    expect(sent).toEqual([{ method: 'disconnect' }]);
  });

  test('未就绪（无 send）时 send 抛错', () => {
    const conn = new DGLabV2WebBleConnection({ deviceId: 'x' });
    expect(() => conn.send({ cmd: 'v2_stop' })).toThrow();
  });

  test('toMetadata 标记 v2 / webble', () => {
    const conn = new DGLabV2WebBleConnection({ deviceId: 'x', send: () => {} });
    expect(conn.toMetadata()).toMatchObject({
      brand: 'dglab', mode: 'webble', v2: true, kind: 'dglab-v2-webble',
    });
  });
});

describe('brandService.attachWebBle 集成', () => {
  const brandService = require('../brands/brandService');
  const DEVICE_ID = 'dglab-v2-integ';

  afterEach(() => {
    try { brandService.detachWebBle(DEVICE_ID); } catch (_) {}
  });

  test('attachWebBle 注册设备并可通过 control 下发 GATT 操作', async () => {
    const sent = [];
    const metadata = {
      id: DEVICE_ID,
      name: 'DG V2',
      type: 'DGLAB_V2',
      connectionType: 'brandBle',
      data: { battery: 88 },
    };
    brandService.attachWebBle(metadata, (ops) => { sent.push(ops); return Promise.resolve({ ok: true }); });

    expect(brandService.getConnection(DEVICE_ID)).toBeTruthy();
    const listed = brandService.list().find((d) => d.deviceId === DEVICE_ID);
    expect(listed).toBeTruthy();
    expect(listed.brand).toBe('dglab');
    expect(listed.mode).toBe('webble');
    expect(listed.type).toBe('DGLAB_V2');
    expect(listed.data.battery).toBe(88);

    brandService.dglabV2SetStrength(DEVICE_ID, { a: 100, b: 50 });
    brandService.dglabV2SetWaveform(DEVICE_ID, { channel: 'A', x: 5, y: 200 });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual([{ characteristic: 'pwmAB2', value: v2.packStrength({ a: 100, b: 50 }) }]);
    expect(sent[1]).toEqual([{ characteristic: 'pwmA34', value: v2.packWaveform({ x: 5, y: 200, z: 0 }) }]);

    brandService.dglabV2Stop(DEVICE_ID);
    expect(sent[2]).toEqual([{ characteristic: 'pwmAB2', value: v2.packStrength({ a: 0, b: 0 }) }]);

    brandService.detachWebBle(DEVICE_ID);
    expect(brandService.getConnection(DEVICE_ID)).toBeFalsy();
  });
});
