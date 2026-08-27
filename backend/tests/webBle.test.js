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
      type: 'DGLAB',
      connectionType: 'brandBle',
      data: { battery: 88 },
    };
    brandService.attachWebBle(metadata, (ops) => { sent.push(ops); return Promise.resolve({ ok: true }); });

    expect(brandService.getConnection(DEVICE_ID)).toBeTruthy();
    const listed = brandService.list().find((d) => d.deviceId === DEVICE_ID);
    expect(listed).toBeTruthy();
    expect(listed.brand).toBe('dglab');
    expect(listed.mode).toBe('webble');
    expect(listed.type).toBe('DGLAB');
    expect(listed.data.battery).toBe(88);

    brandService.control(DEVICE_ID, { brand: 'dglab', cmd: 'v2_setStrength', a: 100, b: 50 });
    brandService.control(DEVICE_ID, { brand: 'dglab', cmd: 'v2_setWaveform', channel: 'A', x: 5, y: 200 });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual([{ characteristic: 'pwmAB2', value: v2.packStrength({ a: 100, b: 50 }) }]);
    expect(sent[1]).toEqual([{ characteristic: 'pwmA34', value: v2.packWaveform({ x: 5, y: 200, z: 0 }) }]);

    brandService.control(DEVICE_ID, { brand: 'dglab', cmd: 'v2_stop' });
    expect(sent[2]).toEqual([{ characteristic: 'pwmAB2', value: v2.packStrength({ a: 0, b: 0 }) }]);

    brandService.detachWebBle(DEVICE_ID);
    expect(brandService.getConnection(DEVICE_ID)).toBeFalsy();
  });

  test('设备类型层命令（setPattern/stopPattern）也能驱动 V2 蓝牙设备', () => {
    const sent = [];
    brandService.attachWebBle(
      { id: DEVICE_ID, name: 'DG V2', type: 'DGLAB', connectionType: 'brandBle' },
      (ops) => { sent.push(ops); return Promise.resolve({ ok: true }); },
    );
    const deviceService = require('../services/deviceService');
    deviceService.invokeDeviceCapability(DEVICE_ID, 'shock', 'start', { voltage: 50 });
    expect(sent[0]).toHaveLength(3); // 强度 + A波形 + B波形
    expect(sent[0][0]).toEqual({ characteristic: 'pwmAB2', value: v2.packStrength({ a: v2.uiToHwStrength(50), b: v2.uiToHwStrength(50) }) });

    deviceService.invokeDeviceCapability(DEVICE_ID, 'shock', 'stop', {});
    expect(sent[1]).toEqual([{ characteristic: 'pwmAB2', value: v2.packStrength({ a: 0, b: 0 }) }]);
  });

  test('通用 YCY 元数据按名称推断具体类型，不把 YISK 当成未知类型', () => {
    const metadata = brandService.attachWebBle(
      { id: 'ycy:yisk', name: 'YISK-003V3', type: 'YCY', connectionType: 'brandBle' },
      () => Promise.resolve({ ok: true }),
    );
    expect(metadata.type).toBe('YCY_ENEMA');
    expect(brandService.list().find((d) => d.deviceId === 'ycy:yisk').type).toBe('YCY_ENEMA');
    brandService.detachWebBle('ycy:yisk');
  });

  test('setPattern 后单通道 setEstim 保留另一通道强度', () => {
    const sent = [];
    const conn = new DGLabV2WebBleConnection({
      deviceId: 'dglab-v2-state',
      send: (ops) => { sent.push(ops); return Promise.resolve({ ok: true }); },
    });
    conn.send({ cmd: 'setPattern', intensity: 50 });
    conn.send({ cmd: 'setEstim', channel: 'a', intensity: 128 });
    expect(sent[1]).toEqual([{
      characteristic: 'pwmAB2',
      value: v2.packStrength({ a: Math.round(128 / 255 * v2.STRENGTH_HW_MAX), b: v2.uiToHwStrength(50) }),
    }]);
  });
});

describe('YCY WebBLE 经设备操作下发写帧', () => {
  const brandService = require('../brands/brandService');
  const deviceService = require('../services/deviceService');
  const ycy = require('../brands/protocols/ycy');
  const CUP_ID = 'ycy:test-cup';

  afterEach(() => {
    try { brandService.detachWebBle(CUP_ID); } catch (_) {}
  });

  test('试控 motors.set 经能力层写出 FJB 帧', () => {
    const sent = [];
    brandService.attachWebBle(
      { id: CUP_ID, name: 'YCY-FJB-03', type: 'YCY_CUP', brand: 'ycy', connectionType: 'brandBle' },
      (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); },
    );
    deviceService.invokeDeviceCapability(CUP_ID, 'motors', 'set', {
      channels: { stroke: { value: 255, direction: 1 }, vibe: { value: 255 }, axis: { value: 0 } },
    });
    expect(sent[0]).toMatchObject({ op: 'write' });
    expect(Buffer.from(sent[0].value).equals(ycy.buildFjb03({ stroke: 20, vibe: 20, axis: 0 }))).toBe(true);
  });

  test('启动旋转走 deviceService，下发 0x35 写帧而不是 setMotors', () => {
    const sent = [];
    brandService.attachWebBle(
      { id: CUP_ID, name: 'YCY-FJB-03', type: 'YCY_CUP', brand: 'ycy', connectionType: 'brandBle' },
      (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); },
    );
    deviceService.executeDeviceOperation(CUP_ID, 'start');
    expect(sent[0]).toMatchObject({ op: 'write' });
    expect(Buffer.from(sent[0].value).equals(ycy.buildFjb03({ stroke: 15, vibe: 15, axis: 0 }))).toBe(true);
  });

  test('setMode 复用当前通道强度，不发送 0 强度帧', () => {
    const sent = [];
    const conn = new (require('../brands/ycyWebBleConnection').YcyWebBleConnection)({
      deviceId: 'ycy:ems', send: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); }, type: 'YCY_EMS',
    });
    conn.send({ cmd: 'setStrength', channel: 'A', value: 50 });
    conn.send({ cmd: 'setMode', channel: 'A', mode: 3 });
    expect(Buffer.from(sent[1].value).equals(ycy.buildEmsStrength({ channel: 'A', value: 50, wave: 3 }))).toBe(true);
  });

  test('WebBLE 断开先等待停止帧再发 disconnect', async () => {
    const events = [];
    brandService.attachWebBle(
      { id: 'ycy:disconnect', name: 'YCY-FJB-03', type: 'YCY_CUP', brand: 'ycy', connectionType: 'brandBle' },
      async (message) => { events.push(message); return { ok: true }; },
    );
    await brandService.detachWebBle('ycy:disconnect');
    expect(events[0]).toMatchObject({ op: 'write' });
    expect(events[0].value).toEqual(Array.from(ycy.buildFjb03({ stroke: 0, vibe: 0, axis: 0 })));
    expect(events[1]).toEqual({ method: 'disconnect' });
  });
});
