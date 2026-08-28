const sosexy = require('../brands/protocols/sosexy');
const registry = require('../devices/registry');
const { SosexyWebBleConnection } = require('../brands/sosexyWebBleConnection');
const brandService = require('../brands/brandService');
const deviceService = require('../services/deviceService');

const hex = (value) => Buffer.from(value).toString('hex').toUpperCase();

describe('SOSEXY PID 0004 协议', () => {
  const DEVICE_ID = 'sosexy:test-device';

  afterEach(() => {
    try { brandService.detachWebBle(DEVICE_ID); } catch (_) {}
  });

  test('四个能力映射到正确属性', () => {
    expect(hex(sosexy.buildStrength({ value: 255 }))).toBe('0400011164000211010007116400081101');
    expect(hex(sosexy.buildVibration({ value: 128 }))).toBe('020001113200021101');
    expect(hex(sosexy.buildSuction({ value: 128 }))).toBe('020007113200081101');
    expect(hex(sosexy.buildShock({ voltage: 40 }))).toBe('020003112800041101');
    expect(hex(sosexy.buildStopAll())).toBe('03000111000003110000071100');
  });

  test('逻辑报文按 18 字节分包并带传输标记', () => {
    const frames = sosexy.toBleFrames({ cmd: 'setStrength', value: 255 }, 0x7a);
    expect(frames).toHaveLength(2);
    expect(hex(frames[0])).toBe('7A01000400011164000211010007116400081101');
    expect(hex(frames[1])).toBe('7A02');
  });

  test('设备类型四能力和下行命令', () => {
    expect(registry.getDeviceCapabilities('SOSEXY_PID0004')).toEqual(['strength', 'vibration', 'suction', 'shock']);
    const sent = [];
    const type = registry.getDeviceType('SOSEXY_PID0004');
    type.invokeCapability('sosexy', 'strength', 'set', { value: 20 }, (_id, msg) => sent.push(msg));
    type.invokeCapability('sosexy', 'vibration', 'set', { value: 30 }, (_id, msg) => sent.push(msg));
    type.invokeCapability('sosexy', 'suction', 'set', { value: 40 }, (_id, msg) => sent.push(msg));
    type.invokeCapability('sosexy', 'shock', 'start', { voltage: 5 }, (_id, msg) => sent.push(msg));
    expect(sent.map((item) => item.cmd)).toEqual(['setStrength', 'setVibration', 'setSuction', 'setShock']);
  });

  test('WebBLE 连接适配器发出 writeMany 帧', async () => {
    const sent = [];
    const connection = new SosexyWebBleConnection({ deviceId: 'sosexy:test', send: (msg) => { sent.push(msg); return Promise.resolve(); } });
    await connection.send({ cmd: 'stopAll' });
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe('writeMany');
    expect(hex(sent[0].values[0])).toBe('00010003000111000003110000071100');
  });

  test('brandService 接入后能力接口写入 SOSEXY 帧', async () => {
    const sent = [];
    brandService.attachWebBle({
      id: DEVICE_ID,
      name: 'SOSEXY',
      brand: 'sosexy',
      type: 'SOSEXY_PID0004',
      connectionType: 'brandBle',
    }, (message) => { sent.push(message); return Promise.resolve(); });
    await deviceService.invokeDeviceCapabilityAndWait(DEVICE_ID, 'shock', 'start', { voltage: 40 });
    expect(sent[0].op).toBe('writeMany');
    expect(hex(sent[0].values[0])).toBe('000100020003112800041101');
    expect(brandService.list().find((device) => device.deviceId === DEVICE_ID).brand).toBe('sosexy');
  });
});
