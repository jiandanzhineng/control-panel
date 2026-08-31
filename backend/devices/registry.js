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
    // buttonInput：锁体按键上报 key_clicked，作为玩法「设备按键开始」的触发源
    capabilities: ['lock', 'buttonInput'],
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

  // 郊狼：shock=双通道同强度；estim=分通道+波形预设。
  new BaseDeviceType({
    type: 'DGLAB',
    name: '蓝牙体感设备',
    capabilities: {
      shock: {
        actions: {
          start: (ctx, params) => ctx.sendMessage({
            brand: 'dglab', cmd: 'setPattern',
            pattern: '经典',
            intensity: Math.max(0, Math.min(100, Math.round(Number(params.voltage) || 0))),
            ticks: -1,
          }),
          stop: (ctx) => ctx.sendMessage({ brand: 'dglab', cmd: 'stopPattern' }),
        },
      },
      estim: {
        actions: {
          set: (ctx, params) => ctx.sendMessage({
            brand: 'dglab', cmd: 'setEstim',
            channel: params.channel || 'ab',
            intensity: Math.max(0, Math.min(255, Math.round(Number(params.intensity) || 0))),
            wave: params.wave,
          }),
          stop: (ctx) => ctx.sendMessage({ brand: 'dglab', cmd: 'stopPattern' }),
        },
      },
    },
    operations: [
      { key: 'start', name: '启动', capability: 'shock', action: 'start', input: { voltage: 60 } },
      { key: 'stop', name: '停止', capability: 'shock', action: 'stop', input: {} },
    ],
    close: (ctx) => ctx.sendMessage({ brand: 'dglab', cmd: 'stopPattern' }),
  }),

  // YCY 电击：shock=AB 同强度；estim=分通道+预设波。
  new BaseDeviceType({
    type: 'YCY_EMS',
    name: '电击型设备',
    capabilities: {
      shock: {
        actions: {
          start: (ctx, params) => ctx.sendMessage({
            brand: 'ycy', cmd: 'setStrength', channel: 'AB',
            value: Math.max(0, Math.min(100, Math.round(Number(params.voltage) || 0))),
          }),
          stop: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopAll' }),
        },
      },
      estim: {
        actions: {
          set: (ctx, params) => ctx.sendMessage({
            brand: 'ycy', cmd: 'setEstim',
            channel: String(params.channel || 'a').toUpperCase(),
            intensity: Math.max(0, Math.min(255, Math.round(Number(params.intensity) || 0))),
            wave: params.wave,
          }),
          stop: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopAll' }),
        },
      },
    },
    operations: [
      { key: 'start', name: '启动', capability: 'shock', action: 'start', input: { voltage: 40 } },
      { key: 'stop', name: '停止', capability: 'shock', action: 'stop', input: {} },
    ],
    close: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopAll' }),
  }),

  // 玩具：strength / motors.a 都映射主电机 0–255 → 0–20。
  new BaseDeviceType({
    type: 'YCY_TOY',
    name: '电机型设备',
    capabilities: {
      strength: {
        actions: {
          set: (ctx, params) => ctx.sendMessage({
            brand: 'ycy', cmd: 'setMotors',
            channels: { a: { value: params.value, direction: 1 } },
          }),
          stop: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopToy' }),
        },
      },
      motors: {
        actions: {
          set: (ctx, params) => ctx.sendMessage({
            brand: 'ycy', cmd: 'setMotors', channels: params.channels || {},
          }),
          stop: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopToy' }),
        },
      },
    },
    operations: [
      { key: 'start', name: '启动', capability: 'strength', action: 'set', input: { value: 204 } },
      { key: 'stop', name: '停止', capability: 'strength', action: 'stop', input: {} },
    ],
    close: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopToy' }),
  }),

  // 杯：strength 同时改旋转（只正转）和震动；motors 三路，未写的保持。
  new BaseDeviceType({
    type: 'YCY_CUP',
    name: '杯型设备',
    capabilities: {
      strength: {
        actions: {
          set: (ctx, params) => ctx.sendMessage({
            brand: 'ycy', cmd: 'setMotors',
            channels: {
              stroke: { value: params.value, direction: 1 },
              vibe: { value: params.value },
            },
          }),
          stop: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopFjb' }),
        },
      },
      motors: {
        actions: {
          set: (ctx, params) => ctx.sendMessage({
            brand: 'ycy', cmd: 'setMotors', channels: params.channels || {},
          }),
          stop: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopFjb' }),
        },
      },
    },
    operations: [
      { key: 'start', name: '启动旋转', capability: 'strength', action: 'set', input: { value: 191 } },
      { key: 'stop', name: '停止', capability: 'strength', action: 'stop', input: {} },
      {
        key: 'trigger', name: '触发指令(桥接兜底)',
        invoke: (ctx, params) => {
          if (!params || !params.commandId) throw new Error('缺少指令 ID (commandId)');
          return ctx.sendMessage({ brand: 'ycy', cmd: 'triggerInstruction', commandId: params.commandId });
        },
      },
    ],
    close: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopFjb' }),
  }),

  // 灌肠：只挂 pump，不冒充 strength。
  new BaseDeviceType({
    type: 'YCY_ENEMA',
    name: '灌肠型设备',
    capabilities: {
      pump: {
        actions: {
          start: (ctx, params) => ctx.sendMessage({
            brand: 'ycy', cmd: 'pump',
            protocol: params?.protocol || 'v1',
            scene: params?.scene || 'guan',
            rate: params?.rate, ss: params?.ss,
          }),
          stop: (ctx, params) => ctx.sendMessage({
            brand: 'ycy', cmd: 'pump',
            protocol: params?.protocol || 'v1', scene: 'stop',
          }),
        },
      },
    },
    operations: [
      {
        key: 'pumpStart', name: '启动泵(注水)',
        invoke: (ctx, params) => ctx.sendMessage({
          brand: 'ycy', cmd: 'pump',
          protocol: params?.protocol || 'v1',
          scene: params?.scene || 'guan',
          rate: params?.rate, ss: params?.ss,
        }),
      },
      {
        key: 'pumpStop', name: '停止泵',
        invoke: (ctx, params) => ctx.sendMessage({
          brand: 'ycy', cmd: 'pump', protocol: params?.protocol || 'v1', scene: 'stop',
        }),
      },
      {
        key: 'trigger', name: '触发指令(桥接兜底)',
        invoke: (ctx, params) => {
          if (!params || !params.commandId) throw new Error('缺少指令 ID (commandId)');
          return ctx.sendMessage({ brand: 'ycy', cmd: 'triggerInstruction', commandId: params.commandId });
        },
      },
      {
        key: 'stop', name: '全部停止',
        invoke: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopAll' }),
      },
    ],
    // 灌肠机的输出通道是泵；stopAll 仅是电刺激帧，不能保证泵停止。
    close: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'stop' }),
  }),

  // 繁野啵啵贝（广播名 SOSEXY PID 0004）：strength 同时映射震动与吸吮；shock 映射微电流通道。
  new BaseDeviceType({
    type: 'SOSEXY_PID0004',
    name: '啵啵贝',
    capabilities: {
      strength: {
        actions: {
          set: (ctx, params) => ctx.sendMessage({ brand: 'sosexy', cmd: 'setStrength', value: params.value }),
          stop: (ctx) => ctx.sendMessage({ brand: 'sosexy', cmd: 'setStrength', value: 0 }),
        },
      },
      vibration: {
        actions: {
          set: (ctx, params) => ctx.sendMessage({ brand: 'sosexy', cmd: 'setVibration', value: params.value, mode: params.mode }),
          stop: (ctx) => ctx.sendMessage({ brand: 'sosexy', cmd: 'setVibration', value: 0 }),
        },
      },
      suction: {
        actions: {
          set: (ctx, params) => ctx.sendMessage({ brand: 'sosexy', cmd: 'setSuction', value: params.value, mode: params.mode }),
          stop: (ctx) => ctx.sendMessage({ brand: 'sosexy', cmd: 'setSuction', value: 0 }),
        },
      },
      shock: {
        actions: {
          start: (ctx, params) => ctx.sendMessage({ brand: 'sosexy', cmd: 'setShock', voltage: params.voltage, mode: params.mode }),
          stop: (ctx) => ctx.sendMessage({ brand: 'sosexy', cmd: 'setShock', voltage: 0 }),
        },
      },
    },
    operations: [
      { key: 'start', name: '启动强度', capability: 'strength', action: 'set', input: { value: 128 } },
      { key: 'stop', name: '全部停止', invoke: (ctx) => ctx.sendMessage({ brand: 'sosexy', cmd: 'stopAll' }) },
      { key: 'queryStatus', name: '查询状态', invoke: (ctx) => ctx.sendMessage({ brand: 'sosexy', cmd: 'queryStatus' }) },
    ],
    close: (ctx) => ctx.sendMessage({ brand: 'sosexy', cmd: 'stopAll' }),
  }),

  // GXP 艾萝机娘二代：strength 映射往复电机 0–255→0–100。震动强度字段未确认。
  new BaseDeviceType({
    type: 'GXP_XA9935',
    name: 'gxp艾萝机娘二代',
    capabilities: {
      strength: {
        actions: {
          set: (ctx, params) => ctx.sendMessage({ brand: 'gxp', cmd: 'setStrength', value: params.value }),
          stop: (ctx) => ctx.sendMessage({ brand: 'gxp', cmd: 'stopAll' }),
        },
      },
    },
    operations: [
      { key: 'start', name: '启动强度', capability: 'strength', action: 'set', input: { value: 128 } },
      { key: 'stop', name: '全部停止', invoke: (ctx) => ctx.sendMessage({ brand: 'gxp', cmd: 'stopAll' }) },
      {
        key: 'setMode', name: '电机+震动模式',
        invoke: (ctx, params) => ctx.sendMessage({
          brand: 'gxp', cmd: 'setMotorAndMode',
          value: params.value, percent: params.percent, mode: params.mode,
        }),
      },
      {
        key: 'stopVibration', name: '停止震动',
        invoke: (ctx) => ctx.sendMessage({ brand: 'gxp', cmd: 'stopVibration' }),
      },
    ],
    close: (ctx) => ctx.sendMessage({ brand: 'gxp', cmd: 'stopAll' }),
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
