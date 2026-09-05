const {
  BLE_UUIDS,
  decodePropertyValue,
  encodePropertyValue,
  decodeMessage,
  encodeMessage,
  decodeIdentity,
} = require('../../electron/ble/protocol');

describe('BLE hardware protocol', () => {
  it('uses the firmware service and channel UUIDs', () => {
    expect(BLE_UUIDS).toEqual({
      service: '000000ff-0000-1000-8000-00805f9b34fb',
      message: '0000ff01-0000-1000-8000-00805f9b34fb',
      mode: '0000ff02-0000-1000-8000-00805f9b34fb',
      command: '0000ff03-0000-1000-8000-00805f9b34fb',
      identity: '0000ff04-0000-1000-8000-00805f9b34fb',
      userDescription: '00002901-0000-1000-8000-00805f9b34fb',
    });
  });

  it('encodes and decodes signed little-endian integer properties', () => {
    expect([...encodePropertyValue('power', -2)]).toEqual([254, 255, 255, 255]);
    expect(decodePropertyValue('power', Uint8Array.from([254, 255, 255, 255]))).toBe(-2);
  });

  it('decodes float notifications and writes firmware mantissa/exponent floats', () => {
    expect(decodePropertyValue('pressure', Uint8Array.from([0, 0, 192, 63]))).toBe(1.5);
    expect([...encodePropertyValue('pressure', 12.34)]).toEqual([210, 4, 0, 254]);
    expect([...encodePropertyValue('pressure', -12.5)]).toEqual([131, 255, 255, 255]);
  });

  it('handles string properties and JSON message channels', () => {
    expect(decodePropertyValue('device_type', new TextEncoder().encode('TD01'))).toBe('TD01');
    expect(new TextDecoder().decode(encodePropertyValue('line1_text', 'ready'))).toBe('ready');
    expect(decodePropertyValue('quat', new TextEncoder().encode('ff7f000000000000')))
      .toBe('ff7f000000000000');
    expect(decodePropertyValue('height', Uint8Array.from([0, 0, 72, 65]))).toBe(12.5);

    const message = { method: 'action', action: 'blink' };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('rejects messages larger than the firmware 256-byte buffer', () => {
    expect(() => encodeMessage({ method: 'action', value: 'x'.repeat(240) }))
      .toThrow(/256 bytes/);
  });

  it('decodes the shared physical-device identity contract', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      device_id: 'aabbccddeeff',
      firmware_version: 'v1.1.38',
    }));
    expect(decodeIdentity(bytes)).toEqual({
      deviceId: 'aabbccddeeff',
      firmwareVersion: 'v1.1.38',
    });
    expect(() => decodeIdentity(new TextEncoder().encode(JSON.stringify({
      device_id: 'AA:BB:CC:DD:EE:FF',
      firmware_version: '1.1.38',
    })))).toThrow(/device_id/);
  });
});
