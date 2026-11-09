jest.mock('../services/mqttClientService', () => ({
  publish: jest.fn(),
}));

jest.mock('../utils/fileStorage', () => ({
  getItem: jest.fn(() => null),
  setItem: jest.fn(),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/nicknameService', () => ({
  getNickname: jest.fn(() => null),
}));

jest.mock('../services/firmwareOtaService', () => ({}));

const mqttClient = require('../services/mqttClientService');
const deviceService = require('../services/deviceService');
const virtualDeviceService = require('../services/virtualDeviceService');
const agentControl = require('../services/agentControlService');
const gameHost = require('../game-runtime/gameHostService');

const LIMITS = {
  default: 60,
  capabilities: { strength: 50, shock: 20, pump: 25, motors: 50 },
};

function addConnectedDevice({ id, name, type }) {
  return deviceService.connectTransportDevice(
    { id, name, type, connectionType: 'mqtt' },
    { kind: 'mqtt', send: (message) => mqttClient.publish(`/drecv/${id}`, message) },
  );
}

function sentTo(deviceId) {
  return mqttClient.publish.mock.calls
    .filter(([topic]) => topic === `/drecv/${deviceId}`)
    .map(([, message]) => message);
}

describe('agent output limiting converges on every write path', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    mqttClient.publish.mockReset();
    agentControl._resetForTests();
    await deviceService.clearAllDevices();
    for (const device of virtualDeviceService.listDevices()) {
      virtualDeviceService.deleteDevice(device.id);
    }
    agentControl.createLease({ clientId: 'dsh-1', limits: LIMITS });
  });

  afterEach(async () => {
    try { gameHost.stop({ reason: 'test-cleanup' }); } catch (_) {}
    for (const device of virtualDeviceService.listDevices()) {
      virtualDeviceService.deleteDevice(device.id);
    }
    agentControl._resetForTests();
    jest.useRealTimers();
  });

  it('clamps a capability action', async () => {
    addConnectedDevice({ id: 'td01-1', name: 'TD01', type: 'TD01' });
    await agentControl.runWithClient('dsh-1', () => (
      deviceService.invokeDeviceCapabilityAndWait('td01-1', 'strength', 'set', { value: 255 })
    ));
    expect(sentTo('td01-1')).toContainEqual({ method: 'update', power: 127 });
  });

  it('clamps a preset operation with hardcoded power 255 (CUNZHI01 start)', async () => {
    addConnectedDevice({ id: 'cunzhi-1', name: 'CUNZHI01', type: 'CUNZHI01' });
    await agentControl.runWithClient('dsh-1', () => (
      deviceService.executeDeviceOperationAndWait('cunzhi-1', 'start', {})
    ));
    expect(sentTo('cunzhi-1')).toContainEqual({ method: 'update', shock: 1, voltage: 20, power: 127 });
  });

  it('clamps pump rate and the omitted ss default', async () => {
    addConnectedDevice({ id: 'enema-1', name: 'YCY_ENEMA', type: 'YCY_ENEMA' });
    await agentControl.runWithClient('dsh-1', () => (
      deviceService.invokeDeviceCapabilityAndWait('enema-1', 'pump', 'start', { rate: 200 })
    ));
    expect(sentTo('enema-1')).toContainEqual({
      brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'guan', rate: 63, ss: 15,
    });
  });

  it('rejects non-numeric output values before transport', async () => {
    addConnectedDevice({ id: 'dianji-1', name: 'DIANJI', type: 'DIANJI' });
    await expect(agentControl.runWithClient('dsh-1', () => (
      deviceService.invokeDeviceCapabilityAndWait('dianji-1', 'shock', 'start', { voltage: true })
    ))).rejects.toMatchObject({ code: 'AGENT_OUTPUT_REJECTED' });
    expect(sentTo('dianji-1')).toEqual([]);
  });

  it('rejects dotted motor channel names', async () => {
    addConnectedDevice({ id: 'toy-1', name: 'YCY_TOY', type: 'YCY_TOY' });
    await expect(agentControl.runWithClient('dsh-1', () => (
      deviceService.invokeDeviceCapabilityAndWait('toy-1', 'motors', 'set', {
        channels: { 'a.b': { value: 20 } },
      })
    ))).rejects.toMatchObject({ code: 'AGENT_OUTPUT_REJECTED' });
    expect(sentTo('toy-1')).toEqual([]);
  });

  it('does not touch user-initiated writes without an agent source', async () => {
    addConnectedDevice({ id: 'td01-2', name: 'TD01', type: 'TD01' });
    await deviceService.invokeDeviceCapabilityAndWait('td01-2', 'strength', 'set', { value: 255 });
    expect(sentTo('td01-2')).toContainEqual({ method: 'update', power: 255 });
  });

  it('clamps virtual device invoke / writeProps (bridge path)', async () => {
    virtualDeviceService.createDevice({ id: 'vtd01', type: 'TD01' });
    await agentControl.runWithClient('dsh-1', () => {
      virtualDeviceService.interceptCommand('vtd01', {
        action: 'invoke', capability: 'strength', actionName: 'set', params: { value: 255 },
      });
      virtualDeviceService.interceptCommand('vtd01', {
        action: 'writeProps', props: { power: 255 },
      });
    });
    const commands = virtualDeviceService.getCommands('vtd01');
    expect(commands.some((cmd) => cmd.action === 'invoke' && cmd.params?.value === 127)).toBe(true);
    expect(commands.some((cmd) => cmd.action === 'writeProps' && cmd.props?.power === 127)).toBe(true);
    expect(virtualDeviceService.getDevice('vtd01').properties.power).toBe(127);
  });

  it('delivers awaited preset operations to virtual devices (clamped)', async () => {
    virtualDeviceService.createDevice({ id: 'vtd01-op', type: 'TD01' });
    await agentControl.runWithClient('dsh-1', () => (
      deviceService.executeDeviceOperationAndWait('vtd01-op', 'start', {})
    ));
    const commands = virtualDeviceService.getCommands('vtd01-op');
    expect(commands.some((cmd) => cmd.action === 'writeProps' && cmd.props?.power === 127)).toBe(true);
    expect(mqttClient.publish).not.toHaveBeenCalled();
  });

  it('clamps HostRuntime shock intents (shockVoltage 50 → 20)', () => {
    addConnectedDevice({ id: 'dianji-host', name: 'DIANJI', type: 'DIANJI' });
    try {
      gameHost.start({
        gameId: 'pressure-edging-v2',
        deviceMap: { punish: ['dianji-host'] },
        params: { shockVoltage: 50, shockDuration: 3, duration: 20 },
        source: 'agent',
        agentClientId: 'dsh-1',
      });
      expect(gameHost.getStatus()).toMatchObject({ running: true, gameId: 'pressure-edging-v2' });
      mqttClient.publish.mockClear();
      gameHost.action('shockOnce', {});
      const voltages = sentTo('dianji-host')
        .filter((msg) => msg.voltage !== undefined && msg.shock === 1)
        .map((msg) => msg.voltage);
      expect(voltages.length).toBeGreaterThan(0);
      expect(Math.max(...voltages)).toBe(20);
    } finally {
      gameHost.stop({ reason: 'test' });
    }
  });
});
