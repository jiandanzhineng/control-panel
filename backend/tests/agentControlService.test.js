jest.mock('../game-runtime/gameHostService', () => ({
  stopAgentPlay: jest.fn(() => true),
}));

jest.mock('../services/bridgeService', () => ({
  stopAgentSession: jest.fn(() => true),
}));

const eventBus = require('../services/eventBus');
const agentControl = require('../services/agentControlService');
const gameHost = require('../game-runtime/gameHostService');
const bridgeService = require('../services/bridgeService');

const LIMITS = {
  default: 60,
  capabilities: { strength: 50, shock: 20 },
};

describe('agent control leases', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    eventBus._resetForTests();
    agentControl._resetForTests();
    gameHost.stopAgentPlay.mockClear();
    bridgeService.stopAgentSession.mockClear();
  });

  afterEach(() => {
    agentControl._resetForTests();
    jest.useRealTimers();
  });

  it('creates a 30 second lease and reports conversion caps', () => {
    const result = agentControl.createLease({ clientId: 'dsh-1', limits: LIMITS });
    expect(result).toMatchObject({
      ok: true,
      clientId: 'dsh-1',
      ttlSec: 30,
      expiresAt: '2026-11-09T12:00:30.000Z',
      limits: { default: 60, capabilities: { strength: 50, shock: 20 } },
    });
    expect(result.fieldCaps).toMatchObject({ power: 127, voltage: 20 });
    expect(agentControl.getStatus()).toMatchObject({
      active: true,
      leases: [expect.objectContaining({ clientId: 'dsh-1', ttlRemainingSec: 30 })],
    });
  });

  it('publishes created / updated / released events', () => {
    const events = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'agent.lease') events.push(event.action);
    });
    try {
      agentControl.createLease({ clientId: 'dsh-1', limits: LIMITS });
      agentControl.createLease({ clientId: 'dsh-1', ttlSec: 10, limits: { default: 30 } });
      agentControl.releaseLease('dsh-1');
      expect(events).toEqual(['created', 'updated', 'released']);
    } finally {
      unsubscribe();
    }
  });

  it('expires the lease, publishes expired, and stops agent plays', async () => {
    const events = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'agent.lease') events.push(event.action);
    });
    try {
      agentControl.createLease({ clientId: 'dsh-1', limits: LIMITS });
      await Promise.resolve();
      jest.advanceTimersByTime(30000);
      await Promise.resolve();
      expect(events).toEqual(['created', 'expired']);
      expect(agentControl.getStatus().leases).toEqual([]);
      expect(gameHost.stopAgentPlay).toHaveBeenCalledWith('dsh-1');
      expect(bridgeService.stopAgentSession).toHaveBeenCalledWith('dsh-1');
    } finally {
      unsubscribe();
    }
  });

  it('releases and stops agent plays immediately', () => {
    agentControl.createLease({ clientId: 'dsh-1', limits: LIMITS });
    const result = agentControl.releaseLease('dsh-1');
    expect(result).toMatchObject({ ok: true, released: true });
    expect(gameHost.stopAgentPlay).toHaveBeenCalledWith('dsh-1');
    expect(bridgeService.stopAgentSession).toHaveBeenCalledWith('dsh-1');
  });

  it('rejects invalid limits / ttl / clientId', () => {
    expect(() => agentControl.createLease({ clientId: 'bad id' })).toThrow(/clientId/);
    expect(() => agentControl.createLease({ clientId: 'dsh-1', ttlSec: 4 })).toThrow(/ttlSec/);
  });
});

describe('agent output gate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    agentControl._resetForTests();
  });

  afterEach(() => {
    agentControl._resetForTests();
    jest.useRealTimers();
  });

  it('clamps agent-sourced writes with an active lease', () => {
    agentControl.createLease({ clientId: 'dsh-1', limits: LIMITS });
    const result = agentControl.guardDeviceMessage({
      clientId: 'dsh-1',
      device: { type: 'TD01' },
      message: { method: 'update', power: 255 },
    });
    expect(result.message.power).toBe(127);
  });

  it('passes manual writes through untouched', () => {
    const message = { method: 'update', power: 255 };
    expect(agentControl.guardDeviceMessage({ device: { type: 'TD01' }, message }).message)
      .toBe(message);
  });

  it('throws 428 for non-stop writes without a lease', () => {
    let thrown = null;
    try {
      agentControl.guardDeviceMessage({
        clientId: 'dsh-1',
        device: { type: 'TD01' },
        message: { method: 'update', power: 10 },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'AGENT_LEASE_REQUIRED', status: 428 });
  });

  it('still allows stop / zeroing writes after expiry', () => {
    agentControl.createLease({ clientId: 'dsh-1', limits: LIMITS });
    jest.advanceTimersByTime(30000);
    expect(agentControl.guardDeviceMessage({
      clientId: 'dsh-1',
      device: { type: 'YCY_EMS' },
      message: { brand: 'ycy', cmd: 'stopAll' },
    }).message).toEqual({ brand: 'ycy', cmd: 'stopAll' });
    expect(agentControl.guardDeviceMessage({
      clientId: 'dsh-1',
      device: { type: 'TD01' },
      message: { method: 'update', power: 0 },
    }).message).toEqual({ method: 'update', power: 0 });
    // 「归零」不能夹带未知字段
    expect(() => agentControl.guardDeviceMessage({
      clientId: 'dsh-1',
      device: { type: 'TD01' },
      message: { method: 'update', power: 0, turbo: 1 },
    })).toThrow(/turbo/);
  });

  it('guards virtual bridge commands (invoke / writeProps / sendMessage)', () => {
    agentControl.createLease({ clientId: 'dsh-1', limits: LIMITS });
    expect(agentControl.guardVirtualCommand({
      clientId: 'dsh-1',
      device: { type: 'CUNZHI01' },
      cmd: { action: 'invoke', capability: 'strength', actionName: 'set', params: { value: 255 } },
    })).toMatchObject({ params: { value: 127 } });
    expect(agentControl.guardVirtualCommand({
      clientId: 'dsh-1',
      device: { type: 'TD01' },
      cmd: { action: 'writeProps', props: { power: 255 } },
    })).toMatchObject({ props: { power: 127 } });
    expect(agentControl.guardVirtualCommand({
      clientId: 'dsh-1',
      device: { type: 'YCY_EMS' },
      cmd: { action: 'sendMessage', msg: { brand: 'ycy', cmd: 'setStrength', value: 100 } },
    })).toMatchObject({ msg: { value: 20 } });
  });
});
