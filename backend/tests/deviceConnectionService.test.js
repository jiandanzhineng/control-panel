const connections = require('../services/deviceConnectionService');

describe('deviceConnectionService', () => {
  beforeEach(() => connections.clear());

  it('merges transports, preserves first control connection, switches explicitly and falls back', () => {
    const mqtt = { send: jest.fn() };
    const serial = { send: jest.fn() };
    const ble = { send: jest.fn() };
    connections.registerConnection('aabbccddeeff', 'mqtt', mqtt);
    connections.registerConnection('aabbccddeeff', 'serial', serial, {
      firmwareVersion: 'v1.2.3', metadata: { portPath: 'COM5' },
    });
    connections.registerConnection('aabbccddeeff', 'ble', ble);

    expect(connections.getDeviceConnections('aabbccddeeff')).toMatchObject({
      controlConnection: 'mqtt',
      connections: [
        { type: 'mqtt', connected: true },
        { type: 'serial', firmwareVersion: 'v1.2.3', portPath: 'COM5' },
        { type: 'ble' },
      ],
    });

    connections.setControlConnection('aabbccddeeff', 'serial');
    connections.send('aabbccddeeff', { method: 'action', action: 'blink' });
    expect(serial.send).toHaveBeenCalledTimes(1);
    expect(mqtt.send).not.toHaveBeenCalled();
    expect(ble.send).not.toHaveBeenCalled();

    connections.unregisterConnection('aabbccddeeff', 'serial');
    expect(connections.getDeviceConnections('aabbccddeeff').controlConnection).toBe('mqtt');
  });

  it('does not retry a failed command on another transport', () => {
    const failure = new Error('write failed');
    const serial = { send: jest.fn(() => { throw failure; }) };
    const mqtt = { send: jest.fn() };
    connections.registerConnection('aabbccddeeff', 'serial', serial);
    connections.registerConnection('aabbccddeeff', 'mqtt', mqtt);

    expect(() => connections.send('aabbccddeeff', { method: 'stop' })).toThrow(failure);
    expect(serial.send).toHaveBeenCalledTimes(1);
    expect(mqtt.send).not.toHaveBeenCalled();
    expect(connections.getDeviceConnections('aabbccddeeff').controlConnection).toBe('serial');
  });

  it('rejects unavailable control connections and ignores a stale adapter disconnect', () => {
    const oldBle = { send() {} };
    const newBle = { send() {} };
    connections.registerConnection('aabbccddeeff', 'ble', oldBle);
    connections.registerConnection('aabbccddeeff', 'ble', newBle);

    expect(connections.unregisterConnection('aabbccddeeff', 'ble', oldBle)).toBe(false);
    expect(connections.hasConnection('aabbccddeeff', 'ble')).toBe(true);
    try {
      connections.setControlConnection('aabbccddeeff', 'serial');
    } catch (error) {
      expect(error.code).toBe('CONNECTION_NOT_AVAILABLE');
    }
  });

  it('does not let transport metadata override public connection invariants', () => {
    connections.registerConnection('aabbccddeeff', 'serial', { send() {} }, {
      metadata: { type: 'ble', connected: false, portPath: 'COM8' },
    });
    expect(connections.getDeviceConnections('aabbccddeeff').connections[0]).toMatchObject({
      type: 'serial', connected: true, portPath: 'COM8',
    });
  });
});
