function clamp(value, min, max) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  return Math.max(min, Math.min(max, safe));
}

function roundClamp(value, min, max) {
  return Math.round(clamp(value, min, max));
}

function strengthBinding(options = {}) {
  const mqttKey = options.mqttKey || 'power';
  const range = options.range || [0, 255];
  const buildSetMessage = options.buildSetMessage;

  return {
    key: 'strength',
    spec: [{ mqttKey, range }],
    actions: {
      set(ctx, input = {}) {
        const value = roundClamp(input.value, range[0], range[1]);
        if (typeof buildSetMessage === 'function') {
          return buildSetMessage(ctx, value, input);
        }
        return ctx.update({ [mqttKey]: value });
      },
    },
  };
}

function reportingBinding(options = {}) {
  const mqttKey = options.mqttKey || 'report_delay_ms';
  const range = options.range || [0, 99999];

  return {
    key: 'reporting',
    spec: [{ mqttKey, range }],
    actions: {
      setReportDelay(ctx, input = {}) {
        return ctx.update({ [mqttKey]: roundClamp(input.ms, range[0], range[1]) });
      },
    },
  };
}

function pressureBinding(options = {}) {
  return {
    key: 'pressure',
    monitorData: options.fields || [
      { key: 'pressure', name: '压力', unit: 'kPa' },
    ],
  };
}

function shockBinding(options = {}) {
  const shockKey = options.shockKey || 'shock';
  const voltageKey = options.voltageKey || 'voltage';
  const defaultVoltage = options.defaultVoltage || 24;
  const voltageRange = options.voltageRange || [0, 100];

  return {
    key: 'shock',
    spec: [
      { mqttKey: shockKey, range: [0, 1] },
      { mqttKey: voltageKey, range: voltageRange },
    ],
    actions: {
      start(ctx, input = {}) {
        const voltage = roundClamp(
          input.voltage === undefined ? defaultVoltage : input.voltage,
          voltageRange[0],
          voltageRange[1]
        );
        return ctx.update({ [voltageKey]: voltage, [shockKey]: 1 });
      },
      stop(ctx) {
        return ctx.update({ [shockKey]: 0 });
      },
    },
  };
}

function lockBinding(options = {}) {
  const openKey = options.openKey || 'open';

  return {
    key: 'lock',
    spec: [{ mqttKey: openKey, range: [0, 1] }],
    actions: {
      setOpen(ctx, input = {}) {
        return ctx.update({ [openKey]: input.open ? 1 : 0 });
      },
    },
  };
}

function weightBinding(options = {}) {
  return {
    key: 'weight',
    monitorData: options.fields || [
      { key: 'weight', name: '重量', unit: 'g' },
    ],
  };
}

function buttonInputBinding(options = {}) {
  return {
    key: 'buttonInput',
    monitorData: options.fields || [
      { key: 'button0', name: '脚踏1', unit: '状态' },
      { key: 'button1', name: '脚踏2', unit: '状态' },
    ],
  };
}

function distanceBinding(options = {}) {
  return {
    key: 'distance',
    monitorData: options.fields || [
      { key: 'distance', name: '距离', unit: 'mm' },
    ],
    actions: {
      configure(ctx, input = {}) {
        const payload = {};
        const low = input.lowBand ?? input.low_band;
        const high = input.highBand ?? input.high_band;
        const delay = input.reportDelayMs ?? input.report_delay_ms;
        if (low !== undefined) payload.low_band = roundClamp(low, 0, 999999);
        if (high !== undefined) payload.high_band = roundClamp(high, 0, 999999);
        if (delay !== undefined) payload.report_delay_ms = roundClamp(delay, 0, 99999);
        return ctx.update(payload);
      },
    },
  };
}

module.exports = {
  clamp,
  roundClamp,
  strengthBinding,
  reportingBinding,
  pressureBinding,
  shockBinding,
  lockBinding,
  weightBinding,
  buttonInputBinding,
  distanceBinding,
};
