const BaseDeviceType = require('./baseDeviceType');
const {
  getAllCapabilityDefinitions,
  getCapabilityDefinition,
} = require('./capabilities');

const registeredTypes = [
  new BaseDeviceType({
    type: 'PJ01',
    name: '往复电机控制器',
    capabilities: ['strength'],
    operations: [
      { key: 'start', name: '启动', capability: 'strength', action: 'set', input: { value: 255 } },
      { key: 'stop', name: '关闭', capability: 'strength', action: 'set', input: { value: 0 } },
    ],
    close: (ctx) => ctx.writeProps({ power: 0 }),
  }),

  new BaseDeviceType({
    type: 'TD01',
    name: '偏轴电机控制器',
    capabilities: ['strength'],
    operations: [
      { key: 'start', name: '启动', capability: 'strength', action: 'set', input: { value: 255 } },
      { key: 'stop', name: '关闭', capability: 'strength', action: 'set', input: { value: 0 } },
    ],
    close: (ctx) => ctx.writeProps({ power: 0 }),
  }),

  new BaseDeviceType({
    type: 'OSR6',
    name: 'OSR6控制器',
    capabilities: ['strength'],
    operations: [
      { key: 'start', name: '启动', capability: 'strength', action: 'set', input: { value: 255 } },
      { key: 'stop', name: '关闭', capability: 'strength', action: 'set', input: { value: 0 } },
    ],
    close: (ctx) => ctx.writeProps({ power: 0 }),
  }),

  new BaseDeviceType({
    type: 'QIYA',
    name: '气压传感器',
    capabilities: ['sphincterPressure', 'reporting'],
    close: (ctx) => ctx.writeProps({ report_delay_ms: 5000 }),
  }),

  new BaseDeviceType({
    type: 'DIANJI',
    name: '电脉冲设备',
    capabilities: ['shock'],
    operations: [
      { key: 'start', name: '启动', capability: 'shock', action: 'start', input: { voltage: 24 } },
      { key: 'stop', name: '停止', capability: 'shock', action: 'stop', input: {} },
    ],
    close: (ctx) => ctx.writeProps({ shock: 0, voltage: 0 }),
  }),

  new BaseDeviceType({
    type: 'ZIDONGSUO',
    name: '自动锁',
    capabilities: ['lock'],
    operations: [
      { key: 'lock', name: '加锁', capability: 'lock', action: 'setOpen', input: { open: false } },
      { key: 'unlock', name: '解锁', capability: 'lock', action: 'setOpen', input: { open: true } },
    ],
    close: (ctx) => ctx.writeProps({ open: 1 }),
  }),

  new BaseDeviceType({
    type: 'QTZ',
    name: '测距及脚踏传感器',
    capabilities: {
      distance: 'distance',
      buttonInput: 'buttonInput',
      reporting: 'reporting',
      tiptoePressure: {
        value: {
          source: {
            op: 'anyEquals',
            keys: ['button0', 'button1'],
            equals: 1,
            on: 200,
            off: 0,
          },
          watch: ['button0', 'button1'],
        },
      },
    },
    close: (ctx) => ctx.writeProps({ report_delay_ms: 10000 }),
  }),

  new BaseDeviceType({
    type: 'DZC01',
    name: '电子秤',
    capabilities: ['weight', 'reporting'],
    close: (ctx) => ctx.writeProps({ report_delay_ms: 5000 }),
  }),

  new BaseDeviceType({
    type: 'CUNZHI01',
    name: '寸止玩法设备',
    capabilities: ['sphincterPressure', 'tiptoePressure', 'strength', 'shock', 'reporting'],
    operations: [
      {
        key: 'start', name: '启动',
        invoke: (ctx) => { ctx.writeProps({ shock: 1, voltage: 24, power: 255 }); },
      },
      {
        key: 'stop', name: '停止',
        invoke: (ctx) => { ctx.writeProps({ shock: 0, voltage: 0, power: 0 }); },
      },
    ],
    close: (ctx) => ctx.writeProps({ shock: 0, voltage: 0, power: 0 }),
  }),
];

const registry = new Map(registeredTypes.map((dt) => [dt.type, dt]));

function getDeviceType(type) {
  const t = typeof type === 'string' && type.length > 0 ? type : 'base';
  if (registry.has(t)) return registry.get(t);
  return new BaseDeviceType({ type: t, name: t });
}

function getAllDeviceTypes() {
  return Array.from(registry.keys());
}

function getDeviceTypeName(type) {
  return getDeviceType(type).name;
}

function isValidDeviceType(type) {
  return registry.has(type);
}

function getDeviceTypeMap() {
  return Object.fromEntries(Array.from(registry.values()).map((dt) => [dt.type, dt.name]));
}

function getDeviceTypeConfig(type) {
  return getDeviceType(type).toConfig();
}

function getAllDeviceTypeConfigs() {
  return Object.fromEntries(Array.from(registry.values()).map((dt) => [dt.type, dt.toConfig()]));
}

function getDeviceCapabilities(type) {
  return getDeviceType(type).getCapabilityKeys();
}

function hasCapability(type, capabilityKey) {
  return getDeviceType(type).hasCapability(capabilityKey);
}

function hasCapabilities(type, capabilityKeys = []) {
  const required = Array.isArray(capabilityKeys) ? capabilityKeys : [capabilityKeys].filter(Boolean);
  return required.every((key) => hasCapability(type, key));
}

function getTypesByCapability(capabilityKey) {
  return Array.from(registry.values())
    .filter((dt) => dt.hasCapability(capabilityKey))
    .map((dt) => dt.type);
}

function getTypeCapabilityMap() {
  return Object.fromEntries(
    Array.from(registry.values()).map((dt) => [dt.type, dt.getCapabilityKeys()])
  );
}

function getCapabilityName(capabilityKey) {
  const def = getCapabilityDefinition(capabilityKey);
  return def ? def.name : capabilityKey;
}

function getAllCapabilities() {
  return Object.keys(getAllCapabilityDefinitions());
}

function getDeviceOperations(type) {
  return getDeviceType(type).getPublicOperations();
}

module.exports = {
  getDeviceType,
  getAllDeviceTypes,
  getDeviceTypeName,
  isValidDeviceType,
  getDeviceTypeMap,
  getDeviceTypeConfig,
  getAllDeviceTypeConfigs,
  getDeviceCapabilities,
  hasCapability,
  hasCapabilities,
  getTypesByCapability,
  getTypeCapabilityMap,
  getCapabilityName,
  getAllCapabilities,
  getAllCapabilityDefinitions,
  getCapabilityDefinition,
  getDeviceOperations,
};
