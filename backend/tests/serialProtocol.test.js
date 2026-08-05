const {
  SerialLineParser,
  parseLine,
  encodeCommand,
} = require('../transports/serialProtocol');

describe('serialProtocol', () => {
  it('parses split and joined lines while ignoring logs', () => {
    const parser = new SerialLineParser();
    expect(parser.push('boot log\r\n@DEBUG REA')).toEqual([
      { type: 'log', line: 'boot log' },
    ]);
    expect(parser.push('DY {"device_id":"aabbccddeeff","firmware_version":"v1.2.3"}\r\n@MSG {"method":"report","power":1}\n'))
      .toEqual([
        { type: 'ready', deviceId: 'aabbccddeeff', firmwareVersion: 'v1.2.3' },
        { type: 'message', message: { method: 'report', power: 1 } },
      ]);
  });

  it('strictly rejects legacy or malformed identities', () => {
    expect(parseLine('@DEBUG READY')).toMatchObject({ type: 'invalid-ready', reason: 'legacy-ready' });
    expect(parseLine('@DEBUG READY {"device_id":"AABBCCDDEEFF","firmware_version":"v1"}').type)
      .toBe('invalid-ready');
    expect(parseLine('@DEBUG READY {"device_id":"aabbccddeeff","firmware_version":"1.2.3"}').type)
      .toBe('invalid-ready');
    expect(parseLine('@DEBUG READY {"device_id":"aabbccddeeff","firmware_version":"vbad version"}').type)
      .toBe('invalid-ready');
  });

  it('rejects invalid messages and recovers after an overlong line', () => {
    expect(parseLine('@MSG []').type).toBe('invalid-message');
    expect(parseLine('@MSG nope').type).toBe('invalid-message');
    const parser = new SerialLineParser({ maxLineLength: 8 });
    expect(parser.push('0123456789')).toEqual([{ type: 'invalid', reason: 'line-too-long' }]);
    expect(parser.push('discard\nlog\n')).toEqual([{ type: 'log', line: 'log' }]);
  });

  it('encodes commands with the exact transport prefix and CRLF', () => {
    expect(encodeCommand({ method: 'stop' })).toBe('@CMD {"method":"stop"}\r\n');
  });
});
