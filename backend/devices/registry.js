const BaseDeviceType = require('./baseDeviceType');
const {
  strengthBinding,
  reportingBinding,
  pressureBinding,
  shockBinding,
  lockBinding,
  weightBinding,
  buttonInputBinding,
  distanceBinding,
} = require('./bindings');
const {
  getAllCapabilityDefinitions,
  getCapabilityDefinition,
} = require('./capabilities');

function strengthOperations() {
  return [
    { key: 'start', name: '启动', capability: 'strength', action: 'set', input: { value: 255 } },
    { key: 'stop', name: '关闭', capability: 'strength', action: 'set', input: { value: 0 } },
  ];
}

const registeredTypes = [
  new BaseDeviceType({
    type: 'PJ01',
    name: '往复电机控制器',
    capabilities: {
      strength: strengthBinding(),
    },
    operations: strengthOperations(),
    test_operations: {
      start: null,
      stop: null,
      loop: [
        { method: 'update', power: 255 },
        { method: 'update', power: 0 },
      ],
      loop_delay: 2000,
      display_keys: [],
    },
  }),

  new BaseDeviceType({
    type: 'TD01',
    name: '偏轴电机控制器',
    capabilities: {
      strength: strengthBinding(),
    },
    operations: strengthOperations(),
    test_operations: {
      start: null,
      stop: null,
      loop: [
        { method: 'update', power: 255 },
        { method: 'update', power: 0 },
      ],
      loop_delay: 2000,
      display_keys: [],
    },
  }),

  new BaseDeviceType({
    type: 'OSR6',
    name: 'OSR6控制器',
    capabilities: {
      strength: strengthBinding(),
    },
    operations: strengthOperations(),
    test_operations: {
      start: null,
      stop: null,
      loop: [
        { method: 'update', power: 255 },
        { method: 'update', power: 0 },
      ],
      loop_delay: 2000,
      display_keys: [],
    },
  }),

  new BaseDeviceType({
    type: 'QIYA',
    name: '气压传感器',
    capabilities: {
      pressure: pressureBinding({
        fields: [
          { key: 'pressure', name: '气压', unit: 'Pa' },
          { key: 'temperature', name: '温度', unit: '°C' },
        ],
      }),
      reporting: reportingBinding(),
    },
    test_operations: {
      start: { method: 'update', report_delay_ms: 100 },
      stop: { method: 'update', report_delay_ms: 5000 },
      loop: [],
      loop_delay: 2000,
    },
  }),

  new BaseDeviceType({
    type: 'DIANJI',
    name: '电脉冲设备',
    capabilities: {
      shock: shockBinding({ defaultVoltage: 24, voltageRange: [0, 100] }),
    },
    operations: [
      { key: 'start', name: '启动', capability: 'shock', action: 'start', input: { voltage: 24 } },
      { key: 'stop', name: '停止', capability: 'shock', action: 'stop', input: {} },
    ],
    test_operations: {
      start: null,
      stop: null,
      loop: [
        { method: 'update', shock: 1, voltage: 24 },
        { method: 'update', shock: 0, voltage: 24 },
      ],
      loop_delay: 2000,
      display_keys: [],
    },
  }),

  new BaseDeviceType({
    type: 'ZIDONGSUO',
    name: '自动锁',
    capabilities: {
      lock: lockBinding(),
    },
    operations: [
      { key: 'lock', name: '加锁', capability: 'lock', action: 'setOpen', input: { open: false } },
      { key: 'unlock', name: '解锁', capability: 'lock', action: 'setOpen', input: { open: true } },
    ],
  }),

  new BaseDeviceType({
    type: 'QTZ',
    name: '测距及脚踏传感器',
    capabilities: {
      distance: distanceBinding(),
      buttonInput: buttonInputBinding(),
      reporting: reportingBinding(),
    },
  }),

  new BaseDeviceType({
    type: 'DZC01',
    name: '电子秤',
    capabilities: {
      weight: weightBinding(),
      reporting: reportingBinding(),
    },
    test_operations: {
      start: { method: 'update', report_delay_ms: 100 },
      stop: { method: 'update', report_delay_ms: 5000 },
      loop: [],
      loop_delay: 2000,
      display_keys: ['weight'],
    },
  }),

  new BaseDeviceType({
    type: 'CUNZHI01',
    name: '寸止玩法设备',
    capabilities: {
      strength: strengthBinding(),
      pressure: pressureBinding({
        fields: [
          { key: 'pressure', name: '阔约压力', unit: 'kPa' },
          { key: 'pressure1', name: '踮脚压力1', unit: 'kPa' },
        ],
      }),
      reporting: reportingBinding(),
      shock: shockBinding({ defaultVoltage: 24, voltageRange: [0, 100] }),
    },
    operations: [
      {
        key: 'start',
        name: '启动',
        invoke: (ctx) => ctx.update({ shock: 1, voltage: 24, power: 255 }),
      },
      {
        key: 'stop',
        name: '停止',
        invoke: (ctx) => ctx.update({ shock: 0, voltage: 24, power: 0 }),
      },
    ],
    test_operations: {
      start: null,
      stop: null,
      loop: [
        { method: 'update', shock: 1, voltage: 24, power: 255 },
        { method: 'update', shock: 0, voltage: 24, power: 0 },
      ],
      loop_delay: 2000,
      display_keys: [],
    },
  }),
];

const registry = new Map(registeredTypes.map((deviceType) => [deviceType.type, deviceType]));

function getDeviceType(type) {
  const normalizedType = typeof type === 'string' && type.length > 0 ? type : 'base';
  if (registry.has(normalizedType)) return registry.get(normalizedType);
  return new BaseDeviceType({ type: normalizedType, name: normalizedType });
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
  return Object.fromEntries(Array.from(registry.values()).map((deviceType) => [deviceType.type, deviceType.name]));
}

function getDeviceTypeConfig(type) {
  return getDeviceType(type).toConfig();
}

function getAllDeviceTypeConfigs() {
  return Object.fromEntries(Array.from(registry.values()).map((deviceType) => [deviceType.type, deviceType.toConfig()]));
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
    .filter((deviceType) => deviceType.hasCapability(capabilityKey))
    .map((deviceType) => deviceType.type);
}

function getTypeCapabilityMap() {
  return Object.fromEntries(
    Array.from(registry.values()).map((deviceType) => [deviceType.type, deviceType.getCapabilityKeys()])
  );
}

function getCapabilityName(capabilityKey) {
  const definition = getCapabilityDefinition(capabilityKey);
  return definition ? definition.name : capabilityKey;
}

function getAllCapabilities() {
  return Object.keys(getAllCapabilityDefinitions());
}

function getDeviceMonitorData(type) {
  return getDeviceType(type).getMonitorData();
}

function getDeviceOperations(type) {
  return getDeviceType(type).getPublicOperations();
}

function hasMonitorData(type) {
  return getDeviceMonitorData(type).length > 0;
}

function hasOperations(type) {
  return getDeviceOperations(type).length > 0;
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
  getDeviceMonitorData,
  getDeviceOperations,
  hasMonitorData,
  hasOperations,
};
