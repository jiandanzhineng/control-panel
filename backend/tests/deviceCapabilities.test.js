const registry = require('../devices/registry');
const { validateActionInput } = require('../devices/capabilities');
const express = require('express');
const request = require('supertest');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/device-capabilities', require('../routes/deviceCapabilities'));
  app.use('/api/device-types', require('../routes/deviceTypes'));
  return app;
}

describe('device capability registry', () => {
  it('maps device types to capability sets', () => {
    expect(registry.hasCapability('TD01', 'strength')).toBe(true);
    expect(registry.hasCapability('ZIDONGSUO', 'lock')).toBe(true);
    expect(registry.hasCapability('ZIDONGSUO', 'buttonInput')).toBe(true);
    expect(registry.hasCapabilities('CUNZHI01', ['strength', 'sphincterPressure', 'shock'])).toBe(true);
    expect(registry.hasCapabilities('QIYA', ['sphincterPressure', 'reporting'])).toBe(true);
    expect(registry.hasCapabilities('DAN01', ['attitude', 'buttonInput', 'reporting'])).toBe(true);
    expect(registry.getTypesByCapability('strength')).toEqual(expect.arrayContaining(['TD01', 'PJ01', 'CUNZHI01']));
  });

  it('exposes DAN01 attitude monitoring and calibration operations', () => {
    const dan01 = registry.getDeviceType('DAN01');
    expect(dan01.getMonitorData()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'quat', visualization: 'attitude' }),
      expect.objectContaining({ key: 'accel' }),
      expect.objectContaining({ key: 'button0', name: '板载按键' }),
    ]));
    expect(dan01.getMonitorData().some((item) => item.key === 'button1')).toBe(false);

    const sent = [];
    dan01.invokeOperation('dan01', 'magCalStart', {}, (_id, message) => sent.push(message));
    dan01.invokeOperation('dan01', 'magCalEnd', {}, (_id, message) => sent.push(message));
    expect(sent).toEqual([
      { method: 'action', action: 'mag_cal_start' },
      { method: 'action', action: 'mag_cal_end' },
    ]);
  });

  it('resolves tiptoe pressure through each device value contract', () => {
    const qtz = registry.getDeviceType('QTZ');
    const cunzhi = registry.getDeviceType('CUNZHI01');

    expect(qtz.hasCapability('tiptoePressure')).toBe(true);
    expect(qtz.getCapabilityValueWatch('tiptoePressure')).toEqual(['button0', 'button1']);
    expect(qtz.resolveCapabilityValue('tiptoePressure', { button0: 0, button1: '1' })).toBe(200);
    expect(qtz.resolveCapabilityValue('tiptoePressure', { button0: 0, button1: 0 })).toBe(0);
    expect(cunzhi.getCapabilityValueWatch('tiptoePressure')).toEqual(['pressure1']);
    expect(cunzhi.resolveCapabilityValue('tiptoePressure', { pressure1: 37.5 })).toBe(37.5);
  });

  it('builds default strength update messages through bindings', () => {
    const td01 = registry.getDeviceType('TD01');
    const sent = [];
    const publishFn = (deviceId, msg) => sent.push(msg);
    td01.invokeCapability('dev01', 'strength', 'set', { value: 128.6 }, publishFn);
    td01.invokeCapability('dev01', 'strength', 'set', { value: -10 }, publishFn);
    td01.invokeCapability('dev01', 'strength', 'set', { value: 999 }, publishFn);
    expect(sent).toEqual([
      { method: 'update', power: 129 },
      { method: 'update', power: 0 },
      { method: 'update', power: 255 },
    ]);
  });

  it('validates capability action input', () => {
    expect(() => validateActionInput('shock', 'unknown', {})).toThrow(/能力动作不存在/);
    expect(() => validateActionInput('nope', 'set', {})).toThrow(/未知能力/);
    expect(validateActionInput('strength', 'set', { value: 1 })).toBe(true);
  });

  it('exposes public config without mqtt implementation details in capability config', () => {
    const config = registry.getDeviceTypeConfig('TD01');
    expect(config.capabilities).toEqual(['strength']);
    expect(config.capabilityConfig.strength.spec).toBeUndefined();
    expect(config.capabilityConfig.strength).toMatchObject({ key: 'strength', name: '强度控制' });
    expect(config.operations[0]).toMatchObject({ key: 'start', capability: 'strength', action: 'set' });
  });

  it('uses a base device config for unknown types instead of publishing Other as a type', () => {
    expect(registry.getAllDeviceTypes()).not.toContain('other');
    expect(registry.getDeviceTypeConfig('UNKNOWN_SENSOR')).toEqual({
      name: 'UNKNOWN_SENSOR',
      capabilities: [],
      capabilityConfig: {},
      monitorData: [],
      operations: [],
    });
  });
});

describe('device capability routes', () => {
  it('returns capability catalog and device type capability map', async () => {
    const res = await request(createApp()).get('/api/device-capabilities');

    expect(res.status).toBe(200);
    expect(res.body.capabilities).toEqual(expect.arrayContaining(['strength', 'sphincterPressure', 'shock']));
    expect(res.body.typeCapabilityMap.CUNZHI01).toEqual(expect.arrayContaining(['strength', 'sphincterPressure', 'tiptoePressure', 'shock']));
    expect(res.body.typeCapabilityMap.ZIDONGSUO).toEqual(expect.arrayContaining(['lock', 'buttonInput']));
    expect(res.body.typeCapabilityMap.other).toBeUndefined();
  });

  it('returns base config for unknown device types', async () => {
    const res = await request(createApp()).get('/api/device-types/NEW_DEVICE/config');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'NEW_DEVICE',
      capabilities: [],
      capabilityConfig: {},
    });
  });
});
