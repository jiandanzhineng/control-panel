const shock = {
  key: 'shock',
  name: '电击控制',
  actions: {
    start: (ctx, params) => ctx.writeProps({ voltage: params.voltage || 24, shock: 1 }),
    stop: (ctx) => ctx.writeProps({ shock: 0 }),
  },
  events: {},
  test: {
    start: null,
    loop: [
      (ctx) => ctx.writeProps({ shock: 1, voltage: 24 }),
      (ctx) => ctx.writeProps({ shock: 0, voltage: 24 }),
    ],
    stop: (ctx) => ctx.writeProps({ shock: 0, voltage: 0 }),
  },
};

const strength = {
  key: 'strength',
  name: '强度控制',
  actions: {
    set: (ctx, params) => ctx.writeProps({ power: Math.round(Math.max(0, Math.min(255, Number(params.value) || 0))) }),
    stop: (ctx) => ctx.writeProps({ power: 0 }),
  },
  events: {},
  test: {
    start: null,
    loop: [
      (ctx) => ctx.writeProps({ power: 255 }),
      (ctx) => ctx.writeProps({ power: 0 }),
    ],
    stop: (ctx) => ctx.writeProps({ power: 0 }),
  },
};

const lock = {
  key: 'lock',
  name: '锁控制',
  actions: {
    setOpen: (ctx, params) => ctx.writeProps({ open: params.open ? 1 : 0 }),
  },
  events: {},
  test: {
    start: null,
    loop: [
      (ctx) => ctx.writeProps({ open: 0 }),
      (ctx) => ctx.writeProps({ open: 1 }),
    ],
    stop: (ctx) => ctx.writeProps({ open: 1 }),
  },
};

const sphincterPressure = {
  key: 'sphincterPressure',
  name: '括约压力',
  actions: {},
  events: {
    pressureChange: {
      watch: [{ type: 'prop', key: 'pressure' }],
      trigger: () => true,
    },
  },
};

const tiptoePressure = {
  key: 'tiptoePressure',
  name: '踮脚压力',
  actions: {},
  events: {
    pressureChange: {
      watch: [{ type: 'prop', key: 'pressure1' }],
      trigger: () => true,
    },
  },
};

const distance = {
  key: 'distance',
  name: '距离检测',
  actions: {
    configure: (ctx, params) => {
      const payload = {};
      if (params.lowBand !== undefined) payload.low_band = Math.round(Math.max(0, Math.min(999999, Number(params.lowBand) || 0)));
      if (params.highBand !== undefined) payload.high_band = Math.round(Math.max(0, Math.min(999999, Number(params.highBand) || 0)));
      if (params.reportDelayMs !== undefined) payload.report_delay_ms = Math.round(Math.max(0, Math.min(99999, Number(params.reportDelayMs) || 0)));
      ctx.writeProps(payload);
    },
  },
  events: {
    enterLow: {
      watch: [{ type: 'msg', match: { method: 'low' } }],
      trigger: () => true,
    },
    enterHigh: {
      watch: [{ type: 'msg', match: { method: 'high' } }],
      trigger: () => true,
    },
  },
};

const buttonInput = {
  key: 'buttonInput',
  name: '按钮输入',
  actions: {},
  events: {
    pressed: {
      watch: [{ type: 'msg', match: { method: 'action', action: 'key_clicked' } }],
      trigger: () => true,
    },
    pushDown: {
      watch: [{ type: 'msg', match: { method: 'low' } }],
      trigger: () => true,
    },
    pushUp: {
      watch: [{ type: 'msg', match: { method: 'high' } }],
      trigger: () => true,
    },
  },
};

const weight = {
  key: 'weight',
  name: '重量检测',
  actions: {},
  events: {
    weightChange: {
      watch: [{ type: 'prop', key: 'weight' }],
      trigger: () => true,
    },
  },
};

const reporting = {
  key: 'reporting',
  name: '上报频率控制',
  actions: {
    setReportDelay: (ctx, params) => ctx.writeProps({ report_delay_ms: Math.round(Math.max(0, Math.min(99999, Number(params.ms) || 0))) }),
  },
  events: {},
  test: {
    start: (ctx) => ctx.writeProps({ report_delay_ms: 100 }),
    loop: [],
    stop: (ctx) => ctx.writeProps({ report_delay_ms: 5000 }),
  },
};

const capabilityDefinitions = {
  shock,
  strength,
  lock,
  sphincterPressure,
  tiptoePressure,
  distance,
  buttonInput,
  weight,
  reporting,
};

function getCapabilityDefinition(key) {
  return capabilityDefinitions[key] || null;
}

function getAllCapabilityDefinitions() {
  return { ...capabilityDefinitions };
}

function validateActionInput(capabilityKey, actionName, input = {}) {
  const cap = capabilityDefinitions[capabilityKey];
  if (!cap) {
    const err = new Error(`未知能力: ${capabilityKey}`);
    err.code = 'CAPABILITY_NOT_FOUND';
    throw err;
  }
  const action = cap.actions?.[actionName];
  if (typeof action !== 'function') {
    const err = new Error(`能力动作不存在: ${capabilityKey}.${actionName}`);
    err.code = 'CAPABILITY_ACTION_NOT_FOUND';
    throw err;
  }
  return true;
}

module.exports = {
  capabilityDefinitions,
  getCapabilityDefinition,
  getAllCapabilityDefinitions,
  validateActionInput,
  shock,
  strength,
  lock,
  sphincterPressure,
  tiptoePressure,
  distance,
  buttonInput,
  weight,
  reporting,
};
