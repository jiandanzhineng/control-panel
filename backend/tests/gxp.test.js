const gxp = require('../brands/protocols/gxp');
const registry = require('../devices/registry');
const { GxpWebBleConnection } = require('../brands/gxpWebBleConnection');
const brandService = require('../brands/brandService');
const deviceService = require('../services/deviceService');

const hex = (value) => Buffer.from(value).toString('hex').toUpperCase();
const DEVICE_ID = 'gxp:test-device';

describe('GXP 艾萝机娘二代协议', () => {
  afterEach(() => {
    try { brandService.detachWebBle(DEVICE_ID); } catch (_) {}
  });

  test('CRC 自检 B1 00 00 00', () => {
    expect(gxp.crc16Ccitt(Buffer.from([0xb1, 0x00, 0x00, 0x00])).toString(16).toUpperCase())
      .toBe('3A5');
    const packed = Buffer.alloc(2);
    packed.writeUInt16BE(gxp.crc16Ccitt(Buffer.from([0xb1, 0x00, 0x00, 0x00])));
    expect(hex(packed)).toBe('03A5');
  });

  test('组包对照文档例帧', () => {
    expect(hex(gxp.buildMotorAndMode(0, 0, 1)))
      .toBe('02A55A55AAF001B10300180100000000000000110005000500000087DA16EB7710B6C603C38F');
    expect(hex(gxp.buildMotorAndMode(0, 1, 1)))
      .toBe('02A55A55AAF001B103001801000000000000651100050005000000E8CCE0E5C62AFB22038609');
    expect(hex(gxp.buildMotorAndMode(50, 1, 1)))
      .toBe('02A55A55AAF001B10300180100000000000065110005000500003257F875565E0BB797034E84');
    expect(hex(gxp.buildMotorAndMode(100, 12, 1)))
      .toBe('02A55A55AAF001B103001801000000000000701100050005000064AA8667E9FFA6D49903FEFB');
    expect(hex(gxp.buildMotorAndMode(50, 0, 1)))
      .toBe('02A55A55AAF001B103001801000000000000001100050005000032EC80DD963885520403FE89');
    expect(hex(gxp.buildStopVibration(1)))
      .toBe('02A55A55AAF001B10300180100070000000000D310A40483F9399DD7ED1712E0FDD70203B2CD');
  });

  test('MQTT power 0-255 换成电机百分比', () => {
    expect(gxp.strengthToPercent(0)).toBe(0);
    expect(gxp.strengthToPercent(128)).toBe(50);
    expect(gxp.strengthToPercent(255)).toBe(100);
    expect(hex(gxp.toBleFrame({ cmd: 'setStrength', value: 128, mode: 1 }, 1)))
      .toBe(hex(gxp.buildMotorAndMode(50, 1, 1)));
  });

  test('设备类型只有 strength，不暴露未确认震动强度', () => {
    expect(registry.getDeviceType('GXP_XA9935').name).toBe('gxp艾萝机娘二代');
    expect(registry.getDeviceCapabilities('GXP_XA9935')).toEqual(['strength']);
  });

  test('连接适配器写 FF03 单帧并记住模式', async () => {
    const sent = [];
    const connection = new GxpWebBleConnection({
      deviceId: 'gxp:test',
      send: (msg) => { sent.push(msg); return Promise.resolve(); },
    });
    await connection.send({ cmd: 'setMotorAndMode', percent: 50, mode: 1 });
    expect(sent[0].write).toBe(gxp.WRITE_UUID);
    expect(hex(sent[0].value)).toBe(hex(gxp.buildMotorAndMode(50, 1, 1)));
    sent.length = 0;
    await connection.send({ cmd: 'setStrength', value: 255 });
    expect(hex(sent[0].value)).toBe(hex(gxp.buildMotorAndMode(100, 1, 2)));
  });

  test('停止震动后再次发电机强制模式 0', async () => {
    const sent = [];
    const connection = new GxpWebBleConnection({
      deviceId: 'gxp:test',
      send: (msg) => { sent.push(msg); return Promise.resolve(); },
    });
    await connection.send({ cmd: 'setMotorAndMode', percent: 50, mode: 2 });
    await connection.send({ cmd: 'stopVibration' });
    sent.length = 0;
    await connection.send({ cmd: 'setStrength', value: 128 });
    expect(hex(sent[0].value)).toBe(hex(gxp.buildMotorAndMode(50, 0, 3)));
  });

  test('brandService 接入后 strength 写入 GXP 帧', async () => {
    const sent = [];
    brandService.attachWebBle({
      id: DEVICE_ID,
      name: 'Xa9935',
      brand: 'gxp',
      type: 'GXP_XA9935',
      connectionType: 'brandBle',
    }, (message) => { sent.push(message); return Promise.resolve(); });
    await deviceService.invokeDeviceCapabilityAndWait(DEVICE_ID, 'strength', 'set', { value: 128 });
    expect(hex(sent[0].value)).toBe(hex(gxp.buildMotorAndMode(50, 0, 1)));
    expect(brandService.list().find((d) => d.deviceId === DEVICE_ID).brand).toBe('gxp');
  });
});
