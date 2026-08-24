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

  // ---- 郊狼（DGLab）品牌设备 ----
  // 经由 App “娱乐模式”本地 WebSocket 控制（协议见 backend/brands/protocols/dglab.js）。
  // 娱乐模式为单活动波形模型；shock/strength 两个能力均映射为 set_pattern，
  // 设备类型层只负责发出“郊狼品牌命令”，真正翻译为 App 帧由品牌连接适配器完成。
  new BaseDeviceType({
    type: 'DGLAB',
    name: '郊狼 DGLab',
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
      strength: {
        actions: {
          set: (ctx, params) => ctx.sendMessage({
            brand: 'dglab', cmd: 'setPattern',
            pattern: '经典',
            intensity: Math.max(0, Math.min(100, Math.round(Number(params.value) || 0))),
            ticks: -1,
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

  // ---- 役次元（YCY / YOKONEX）电击器（YSKJ_EMS_BLE） ----
  // 通道 A/B 强度 0–100（BLE 直连时映射为 0–276 协议范围），全局停止为 stopAll。
  new BaseDeviceType({
    type: 'YCY_EMS',
    name: '役次元 电击器',
    capabilities: {
      shock: {
        actions: {
          start: (ctx, params) => ctx.sendMessage({
            brand: 'ycy', cmd: 'setStrength', channel: 'A',
            value: Math.max(0, Math.min(100, Math.round(Number(params.voltage) || 0))),
          }),
          stop: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopAll' }),
        },
      },
      strength: {
        actions: {
          set: (ctx, params) => ctx.sendMessage({
            brand: 'ycy', cmd: 'setStrength', channel: 'B',
            value: Math.max(0, Math.min(100, Math.round(Number(params.value) || 0))),
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

  // ---- 役次元（YCY / YOKONEX）玩具 / 电机（YSKJ_TOY_BLE） ----
  // 电机 A/B/C 速度 0–20；此处以 0–100 输入映射到 0–20 协议范围。
  new BaseDeviceType({
    type: 'YCY_TOY',
    name: '役次元 玩具/电机',
    capabilities: {
      strength: {
        actions: {
          set: (ctx, params) => {
            const v = Math.max(0, Math.min(100, Math.round(Number(params.value) || 0)));
            const speed = Math.round((v / 100) * 20);
            return ctx.sendMessage({ brand: 'ycy', cmd: 'setSpeed', motor: 'A', speed });
          },
          stop: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopToy' }),
        },
      },
    },
    operations: [
      { key: 'start', name: '启动', capability: 'strength', action: 'set', input: { value: 80 } },
      { key: 'stop', name: '停止', capability: 'strength', action: 'stop', input: {} },
    ],
    close: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopToy' }),
  }),

  // ---- 役次元（YCY / YOKONEX）杯 / 灌肠机（非电击，App 指令触发，桥接模式） ----
  // 这类设备不在本机直发强度/通道帧，而是由 YCY App 内已配置的指令驱动；
  // 通过 API-bridge 的 triggerInstruction（commandId）触发，全部停止复用 _stop_all。
  // 因其为「指令触发性」设备，无标准强度/通道能力；连接时由前端选择设备类型
  // （resolveDeviceType 支持显式 type 覆盖），控制统一走通用桥接控制区块。
  new BaseDeviceType({
    type: 'YCY_CUP',
    name: '役次元 杯',
    capabilities: {},
    operations: [
      {
        key: 'trigger', name: '触发指令',
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
    close: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopAll' }),
  }),

  new BaseDeviceType({
    type: 'YCY_ENEMA',
    name: '役次元 灌肠机',
    capabilities: {},
    operations: [
      {
        key: 'trigger', name: '触发指令',
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
    close: (ctx) => ctx.sendMessage({ brand: 'ycy', cmd: 'stopAll' }),
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
