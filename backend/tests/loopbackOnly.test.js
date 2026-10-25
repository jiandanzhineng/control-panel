const { isLoopbackAddress, isLoopbackRequest, loopbackOnly } = require('../middleware/loopbackOnly');

describe('loopbackOnly', () => {
  test('accepts loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.5.5.5')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  test('rejects LAN and public addresses', () => {
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
    expect(isLoopbackAddress('10.0.0.7')).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.1.20')).toBe(false);
  });

  test('middleware blocks non-loopback requests with 403', () => {
    const req = { socket: { remoteAddress: '192.168.1.20' } };
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    const next = jest.fn();
    loopbackOnly(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'REMOTE_LOCAL_ONLY' }),
    }));
  });

  test('middleware lets loopback requests through', () => {
    const req = { socket: { remoteAddress: '127.0.0.1' } };
    const next = jest.fn();
    loopbackOnly(req, {}, next);
    expect(next).toHaveBeenCalled();
    expect(isLoopbackRequest(req)).toBe(true);
  });
});
