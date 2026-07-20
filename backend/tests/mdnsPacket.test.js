const {
  inspectQuery,
  legacyUnicastResponse,
  multicastResponse,
} = require('../services/mdnsPacket');

function query(name, type = 1, { id = 0, queryClass = 1, response = false } = {}) {
  const labels = [];
  for (const label of name.split('.').filter(Boolean)) {
    const bytes = Buffer.from(label);
    labels.push(Buffer.from([bytes.length]), bytes);
  }
  labels.push(Buffer.from([0]));

  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  if (response) header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(queryClass, 2);
  return Buffer.concat([header, ...labels, tail]);
}

describe('mdnsPacket', () => {
  it('preserves legacy query ID and question while returning one A record', () => {
    const request = query('easysmart.local', 1, { id: 0x1234 });
    const parsed = inspectQuery(request);
    const response = legacyUnicastResponse(parsed, '192.168.5.39');

    expect(response.readUInt16BE(0)).toBe(0x1234);
    expect(response.readUInt16BE(4)).toBe(1);
    expect(response.readUInt16BE(6)).toBe(1);
    expect(response.subarray(12, request.length)).toEqual(request.subarray(12));

    const answerOffset = request.length;
    expect([...response.subarray(answerOffset, answerOffset + 6)]).toEqual([
      0xc0, 0x0c, 0, 1, 0, 1,
    ]);
    expect([...response.subarray(-4)]).toEqual([192, 168, 5, 39]);
  });

  it('recognizes A and ANY queries including the unicast-response bit', () => {
    expect(inspectQuery(query('EASYSMART.local', 1))).toMatchObject({
      unicastRequested: false,
    });
    expect(inspectQuery(query('easysmart.local', 255, { queryClass: 0x8001 }))).toMatchObject({
      unicastRequested: true,
    });
  });

  it('ignores unrelated, response, non-IN, and malformed packets', () => {
    expect(inspectQuery(query('other.local'))).toBeNull();
    expect(inspectQuery(query('easysmart.local', 1, { response: true }))).toBeNull();
    expect(inspectQuery(query('easysmart.local', 1, { queryClass: 3 }))).toBeNull();
    expect(inspectQuery(Buffer.alloc(11))).toBeNull();
  });

  it('creates a cache-flushed multicast A announcement', () => {
    const response = multicastResponse('10.0.0.8');

    expect(response.readUInt16BE(0)).toBe(0);
    expect(response.readUInt16BE(4)).toBe(0);
    expect(response.readUInt16BE(6)).toBe(1);
    expect([...response.subarray(-4)]).toEqual([10, 0, 0, 8]);
  });

  it('rejects invalid response addresses', () => {
    expect(() => multicastResponse('172.20.1.999')).toThrow('Invalid IPv4 address');
  });
});
