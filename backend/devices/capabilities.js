function defineCapability(definition) {
  if (!definition || typeof definition.key !== 'string' || !definition.key) {
    throw new Error('Capability definition requires a key');
  }
  return {
    name: definition.key,
    actions: {},
    properties: [],
    ...definition,
  };
}

const capabilityDefinitions = {
  strength: defineCapability({
    key: 'strength',
    name: '强度控制',
    actions: {
      set: {
        input: {
          value: { type: 'number', required: true, min: 0, max: 255 },
        },
      },
    },
  }),

  reporting: defineCapability({
    key: 'reporting',
    name: '上报频率控制',
    actions: {
      setReportDelay: {
        input: {
          ms: { type: 'number', required: true, min: 0, max: 99999 },
        },
      },
    },
  }),

  pressure: defineCapability({
    key: 'pressure',
    name: '压力上报',
    properties: [
      { key: 'pressure', name: '压力', unit: 'kPa' },
    ],
  }),

  shock: defineCapability({
    key: 'shock',
    name: '电击控制',
    actions: {
      start: {
        input: {
          voltage: { type: 'number', required: false, min: 0, max: 100 },
        },
      },
      stop: {
        input: {},
      },
    },
  }),

  lock: defineCapability({
    key: 'lock',
    name: '锁控制',
    actions: {
      setOpen: {
        input: {
          open: { type: 'boolean', required: true },
        },
      },
    },
  }),

  weight: defineCapability({
    key: 'weight',
    name: '重量上报',
    properties: [
      { key: 'weight', name: '重量', unit: 'g' },
    ],
  }),

  buttonInput: defineCapability({
    key: 'buttonInput',
    name: '按钮输入',
    properties: [
      { key: 'button0', name: '按钮1', unit: '状态' },
      { key: 'button1', name: '按钮2', unit: '状态' },
    ],
  }),

  distance: defineCapability({
    key: 'distance',
    name: '距离检测',
    properties: [
      { key: 'distance', name: '距离', unit: 'mm' },
    ],
    actions: {
      configure: {
        input: {
          lowBand: { type: 'number', required: false, min: 0 },
          highBand: { type: 'number', required: false, min: 0 },
          reportDelayMs: { type: 'number', required: false, min: 0, max: 99999 },
        },
      },
    },
  }),
};

function getCapabilityDefinition(key) {
  return capabilityDefinitions[key] || null;
}

function getAllCapabilityDefinitions() {
  return Object.fromEntries(
    Object.entries(capabilityDefinitions).map(([key, definition]) => [key, { ...definition }])
  );
}

function validateActionInput(capabilityKey, actionName, input = {}) {
  const capability = getCapabilityDefinition(capabilityKey);
  if (!capability) {
    const err = new Error(`未知能力: ${capabilityKey}`);
    err.code = 'CAPABILITY_NOT_FOUND';
    throw err;
  }

  const action = capability.actions?.[actionName];
  if (!action) {
    const err = new Error(`能力动作不存在: ${capabilityKey}.${actionName}`);
    err.code = 'CAPABILITY_ACTION_NOT_FOUND';
    throw err;
  }

  const schema = action.input || {};
  for (const [key, rule] of Object.entries(schema)) {
    const value = input?.[key];
    if (rule.required && (value === undefined || value === null || value === '')) {
      const err = new Error(`能力动作参数缺失: ${capabilityKey}.${actionName}.${key}`);
      err.code = 'CAPABILITY_INPUT_INVALID';
      throw err;
    }
    if (value === undefined || value === null || value === '') continue;
    if (rule.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        const err = new Error(`能力动作参数必须为数字: ${capabilityKey}.${actionName}.${key}`);
        err.code = 'CAPABILITY_INPUT_INVALID';
        throw err;
      }
    }
    if (rule.type === 'boolean' && typeof value !== 'boolean') {
      const err = new Error(`能力动作参数必须为布尔值: ${capabilityKey}.${actionName}.${key}`);
      err.code = 'CAPABILITY_INPUT_INVALID';
      throw err;
    }
  }

  return true;
}

module.exports = {
  defineCapability,
  capabilityDefinitions,
  getCapabilityDefinition,
  getAllCapabilityDefinitions,
  validateActionInput,
};
