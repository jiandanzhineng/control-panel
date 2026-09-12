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

function addConnectedDevice({ id, name, type }) {
  return deviceService.connectTransportDevice(
    { id, name, type, connectionType: 'mqtt' },
    {
      kind: 'mqtt',
      send: (message) => mqttClient.publish(`/drecv/${id}`, message),
    },
  );
}

describe('batchExecuteOperation', () => {
  beforeEach(async () => {
    mqttClient.publish.mockReset();
    await deviceService.clearAllDevices();
  });

  it('unlocks all online locks of the type', () => {
    for (let i = 0; i < 10; i += 1) {
      addConnectedDevice({ id: `lock-${i}`, name: `lock-${i}`, type: 'ZIDONGSUO' });
    }
    const result = deviceService.batchExecuteOperation({
      type: 'ZIDONGSUO',
      operationKey: 'unlock',
    });
    expect(result).toMatchObject({ total: 10, ok: 10, failed: 0, skipped: 0 });
    expect(mqttClient.publish).toHaveBeenCalledTimes(10);
    expect(mqttClient.publish).toHaveBeenCalledWith('/drecv/lock-0', { method: 'update', open: 1 });
  });

  it('skips offline devices and still controls online ones', () => {
    addConnectedDevice({ id: 'lock-on', name: 'on', type: 'ZIDONGSUO' });
    deviceService.addDevice({ id: 'lock-off', name: 'off', type: 'ZIDONGSUO' });
    const result = deviceService.batchExecuteOperation({
      type: 'ZIDONGSUO',
      operationKey: 'lock',
    });
    expect(result).toMatchObject({ total: 1, ok: 1, failed: 0, skipped: 0 });
    expect(mqttClient.publish).toHaveBeenCalledTimes(1);
    expect(mqttClient.publish).toHaveBeenCalledWith('/drecv/lock-on', { method: 'update', open: 0 });
  });

  it('marks requested offline devices as skipped', () => {
    addConnectedDevice({ id: 'lock-on', name: 'on', type: 'ZIDONGSUO' });
    deviceService.addDevice({ id: 'lock-off', name: 'off', type: 'ZIDONGSUO' });
    const result = deviceService.batchExecuteOperation({
      type: 'ZIDONGSUO',
      operationKey: 'unlock',
      deviceIds: ['lock-on', 'lock-off'],
    });
    expect(result).toMatchObject({ total: 2, ok: 1, failed: 0, skipped: 1 });
    expect(result.results.find((row) => row.id === 'lock-off')).toMatchObject({ skipped: true });
  });

  it('keeps going when one requested id is missing', () => {
    addConnectedDevice({ id: 'lock-on', name: 'on', type: 'ZIDONGSUO' });
    const result = deviceService.batchExecuteOperation({
      type: 'ZIDONGSUO',
      operationKey: 'unlock',
      deviceIds: ['lock-on', 'lock-missing'],
    });
    expect(result).toMatchObject({ total: 2, ok: 1, failed: 1, skipped: 0 });
    expect(result.results.find((row) => row.id === 'lock-missing').error.code).toBe('DEVICE_NOT_FOUND');
  });

  it('rejects unsupported operations and type mismatch', () => {
    addConnectedDevice({ id: 'lock-1', name: 'lock', type: 'ZIDONGSUO' });
    addConnectedDevice({ id: 'shock-1', name: 'shock', type: 'DIANJI' });
    expect(() => deviceService.batchExecuteOperation({ type: 'ZIDONGSUO', operationKey: 'start' }))
      .toThrow(/不支持操作/);
    expect(() => deviceService.batchExecuteOperation({
      type: 'ZIDONGSUO',
      operationKey: 'unlock',
      deviceIds: ['shock-1'],
    })).toThrow(/不是类型/);
  });
});

