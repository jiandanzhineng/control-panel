const guard = require('../services/agentOutputGuard');

const LIMITS = {
  default: 60,
  capabilities: {
    strength: 80,
    shock: 10,
    vibration: 100,
    suction: 100,
    estim: 50,
    motors: 50,
    pump: 25,
  },
};

function sanitize(type, message, limits = LIMITS) {
  return guard.sanitizeDeviceMessage({ device: { type }, message, limits });
}

describe('agent output conversion table', () => {
  it('converts capability percentages into floored per-field caps', () => {
    expect(guard.describeLimits(LIMITS)).toMatchObject({
      default: 60,
      capabilities: {
        strength: 80, shock: 10, vibration: 100, suction: 100, estim: 50, motors: 50, pump: 25,
      },
      fieldCaps: {
        voltage: 10,   // shock 10% × 100
        power: 204,    // strength 80% × 255
        intensity: 10, // min(shock 10, vibration 100, suction 100, estim 50)% × 100
        motorLevel: 10, // motors 50% × 20
        stroke: 20,    // motors 50% × 40
        rate: 63,      // pump 25% × 255
        seconds: 15,   // pump 25% × 60
        ticks: 10,     // shock 10% × 100
        pump: 63,      // pump 25% × 255
      },
    });
  });

  it('defaults every capability to the default percentage', () => {
    const described = guard.describeLimits({ default: 50 });
    expect(described.capabilities).toEqual({
      strength: 50, shock: 50, vibration: 50, suction: 50, estim: 50, motors: 50, pump: 50,
    });
    expect(described.fieldCaps.power).toBe(127); // floor(50% × 255)
    expect(described.fieldCaps.seconds).toBe(30);
  });

  it('fails closed with 0% when limits are missing', () => {
    expect(guard.describeLimits({}).fieldCaps).toEqual({
      voltage: 0, power: 0, intensity: 0, motorLevel: 0, stroke: 0,
      rate: 0, seconds: 0, ticks: 0, pump: 0,
    });
  });
});

describe('agent device message sanitizer', () => {
  it('clamps motor power and shock voltage per device type', () => {
    expect(sanitize('TD01', { method: 'update', power: 255 }).message)
      .toEqual({ method: 'update', power: 204 });
    expect(sanitize('DIANJI', { method: 'update', voltage: 80, shock: 1 }).message)
      .toEqual({ method: 'update', voltage: 10, shock: 1 });
    expect(sanitize('CUNZHI01', { method: 'update', shock: 1, voltage: 24, power: 255 }).message)
      .toEqual({ method: 'update', shock: 1, voltage: 10, power: 204 });
  });

  it('rejects non-numeric output values (voltage: true / "80")', () => {
    expect(sanitize('DIANJI', { method: 'update', voltage: true, shock: 1 }))
      .toMatchObject({ ok: false, code: 'AGENT_OUTPUT_REJECTED' });
    expect(sanitize('DIANJI', { method: 'update', voltage: '80', shock: 1 }))
      .toMatchObject({ ok: false, code: 'AGENT_OUTPUT_REJECTED' });
  });

  it('rejects unknown output fields and unknown device types', () => {
    expect(sanitize('TD01', { method: 'update', power: 10, turbo: 1 }))
      .toMatchObject({ ok: false, code: 'AGENT_OUTPUT_REJECTED' });
    expect(sanitize('UNKNOWN', { method: 'update', power: 10 }))
      .toMatchObject({ ok: false, code: 'AGENT_OUTPUT_REJECTED' });
  });

  it('clamps brand intensity/ticks and applies the command capability', () => {
    expect(sanitize('DGLAB', {
      brand: 'dglab', cmd: 'setPattern', pattern: '经典', intensity: 90, ticks: -1,
    }).message).toEqual({
      brand: 'dglab', cmd: 'setPattern', pattern: '经典', intensity: 10, ticks: 10,
    });
    expect(sanitize('YCY_EMS', {
      brand: 'ycy', cmd: 'setStrength', channel: 'AB', value: 80,
    }).message).toEqual({
      brand: 'ycy', cmd: 'setStrength', channel: 'AB', value: 10,
    });
    expect(sanitize('SOSEXY_PID0004', {
      brand: 'sosexy', cmd: 'setShock', voltage: 80, mode: 1,
    }).message).toEqual({
      brand: 'sosexy', cmd: 'setShock', voltage: 10, mode: 1,
    });
  });

  it('clamps pump rate/ss including the firmware default ss=60', () => {
    expect(sanitize('YCY_ENEMA', {
      brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'guan', rate: 200, ss: 60,
    }).message).toEqual({
      brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'guan', rate: 63, ss: 15,
    });
    // 虚拟设备 writeProps 会给品牌报文补 method:'update'：外壳字段不影响解析
    expect(sanitize('YCY_ENEMA', {
      method: 'update', brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'guan', rate: 200, ss: 60,
    }).message).toEqual({
      brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'guan', rate: 63, ss: 15,
    });
    // 省略 ss 时固件默认 60s：agent 报文层补上并按租约压到 15s
    expect(sanitize('YCY_ENEMA', { method: 'pump', rate: 200 }).message)
      .toEqual({ method: 'pump', protocol: 'v1', scene: 'guan', rate: 63, ss: 15 });
  });

  it('clamps YCY motor channels and rejects dotted/unknown channel names', () => {
    expect(sanitize('YCY_TOY', {
      brand: 'ycy', cmd: 'setMotors', channels: { a: { value: 20, direction: 1 } },
    }).message).toEqual({
      brand: 'ycy', cmd: 'setMotors', channels: { a: { value: 10, direction: 1 } },
    });
    expect(sanitize('YCY_TOY', {
      brand: 'ycy', cmd: 'setMotors', channels: { 'a.b': { value: 20 } },
    })).toMatchObject({ ok: false, code: 'AGENT_OUTPUT_REJECTED' });
  });

  it('always allows stop commands and zeroing writes', () => {
    expect(sanitize('YCY_EMPTY', { brand: 'nope', cmd: 'stopAll' }).ok).toBe(false);
    expect(sanitize('YCY_EMS', { brand: 'ycy', cmd: 'stopAll' }).message)
      .toEqual({ brand: 'ycy', cmd: 'stopAll' });
    expect(sanitize('YCY_ENEMA', { method: 'pump', scene: 'stop' }).message)
      .toEqual({ method: 'pump', protocol: 'v1', scene: 'stop' });
    expect(guard.isStopMessage({ brand: 'ycy', cmd: 'stopAll' })).toBe(true);
    expect(guard.isZeroOutputMessage({ method: 'update', power: 0, voltage: 0 })).toBe(true);
    expect(guard.isZeroOutputMessage({ method: 'update', power: 1 })).toBe(false);
  });

  it('rejects brand commands that cannot be bounded (triggerInstruction)', () => {
    expect(sanitize('YCY_CUP', {
      brand: 'ycy', cmd: 'triggerInstruction', commandId: 'player_hurt',
    })).toMatchObject({ ok: false, code: 'AGENT_OUTPUT_REJECTED' });
  });
});

describe('agent capability invoke sanitizer', () => {
  it('clamps semantic invoke params for virtual devices', () => {
    expect(guard.sanitizeCapabilityInvoke({
      device: { type: 'CUNZHI01' }, capability: 'strength', action: 'set', input: { value: 255 }, limits: LIMITS,
    })).toEqual({ ok: true, input: { value: 204 } });
    expect(guard.sanitizeCapabilityInvoke({
      device: { type: 'CUNZHI01' }, capability: 'shock', action: 'start', input: { voltage: 80 }, limits: LIMITS,
    })).toEqual({ ok: true, input: { voltage: 10 } });
    expect(guard.sanitizeCapabilityInvoke({
      device: { type: 'YCY_ENEMA' }, capability: 'pump', action: 'start', input: { rate: 200 }, limits: LIMITS,
    })).toEqual({ ok: true, input: { rate: 63 } });
    expect(guard.sanitizeCapabilityInvoke({
      device: { type: 'YCY_TOY' }, capability: 'motors', action: 'set',
      input: { channels: { a: { value: 20 } } }, limits: LIMITS,
    })).toEqual({ ok: true, input: { channels: { a: { value: 10 } } } });
  });

  it('leaves stop actions untouched', () => {
    expect(guard.sanitizeCapabilityInvoke({
      device: { type: 'TD01' }, capability: 'strength', action: 'stop', input: {}, limits: LIMITS,
    })).toEqual({ ok: true, input: {} });
  });
});
