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
    expect(registry.hasCapabilities('CUNZHI01', ['strength', 'pressure', 'shock'])).toBe(true);
    expect(registry.hasCapabilities('QIYA', ['pressure', 'reporting'])).toBe(true);
    expect(registry.getTypesByCapability('strength')).toEqual(expect.arrayContaining(['TD01', 'PJ01', 'CUNZHI01']));
  });

  it('builds default strength update messages through bindings', () => {
    const td01 = registry.getDeviceType('TD01');
    expect(td01.invokeCapability({ id: 'dev01', type: 'TD01' }, 'strength', 'set', { value: 128.6 }))
      .toEqual({ method: 'update', power: 129 });
    expect(td01.invokeCapability({ id: 'dev01', type: 'TD01' }, 'strength', 'set', { value: -10 }))
      .toEqual({ method: 'update', power: 0 });
    expect(td01.invokeCapability({ id: 'dev01', type: 'TD01' }, 'strength', 'set', { value: 999 }))
      .toEqual({ method: 'update', power: 255 });
  });

  it('validates capability action input', () => {
    expect(() => validateActionInput('strength', 'set', {})).toThrow(/参数缺失/);
    expect(() => validateActionInput('lock', 'setOpen', { open: 1 })).toThrow(/布尔值/);
    expect(() => validateActionInput('shock', 'unknown', {})).toThrow(/能力动作不存在/);
  });

  it('exposes public config without mqtt implementation details in capability config', () => {
    const config = registry.getDeviceTypeConfig('TD01');
    expect(config.capabilities).toEqual(['strength']);
    expect(config.capabilityConfig.strength.spec).toBeUndefined();
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
    expect(res.body.capabilities).toEqual(expect.arrayContaining(['strength', 'pressure', 'shock']));
    expect(res.body.typeCapabilityMap.CUNZHI01).toEqual(expect.arrayContaining(['strength', 'pressure', 'shock']));
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
