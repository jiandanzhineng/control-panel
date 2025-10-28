const networkService = require('../services/networkService');

function isIpv4(ip) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip);
}

describe('networkService.getIps', () => {
  it('should return a non-empty array of valid IPv4 items', async () => {
    const rows = await networkService.getIps();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);

    for (const r of rows) {
      expect(typeof r.ip).toBe('string');
      expect(isIpv4(r.ip)).toBe(true);
      expect(r.ip).not.toBe('127.0.0.1');
      expect(typeof r.cidr).toBe('number');
      expect(r.cidr).toBeGreaterThanOrEqual(1);
      expect(r.cidr).toBeLessThanOrEqual(32);
      expect(typeof r.interface).toBe('string');
      expect(r.interface.length).toBeGreaterThan(0);
    }
  });
});