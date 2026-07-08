const fs = require('fs');
const os = require('os');
const path = require('path');

describe('browserDeviceGrantService', () => {
  let tempDir;
  let grantPath;
  let service;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-device-grants-'));
    grantPath = path.join(tempDir, 'grants.json');
    process.env.BROWSER_DEVICE_GRANTS_PATH = grantPath;
    service = require('../services/browserDeviceGrantService');
  });

  afterEach(() => {
    delete process.env.BROWSER_DEVICE_GRANTS_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('normalizes grants to http/https origin only', () => {
    expect(service.normalizeOrigin('https://example.com/path?q=1')).toBe('https://example.com');
    expect(service.normalizeOrigin('http://localhost:5277/browser')).toBe('http://localhost:5277');
    expect(() => service.normalizeOrigin('file:///tmp/a.html')).toThrow(/http\/https/);
  });

  it('grants access until the end of the local day', () => {
    const now = new Date(2026, 6, 8, 12, 30, 0, 0);
    const grant = service.grantToday('https://example.com/page', now);

    expect(grant).toEqual({
      origin: 'https://example.com',
      grantedAt: now.getTime(),
      expiresAt: new Date(2026, 6, 8, 23, 59, 59, 999).getTime(),
    });
    expect(service.isGranted('https://example.com/other', new Date(2026, 6, 8, 20))).toBe(true);
    expect(service.isGranted('https://example.com/other', new Date(2026, 6, 9, 0))).toBe(false);
  });

  it('does not share grants across origins', () => {
    service.grantToday('https://example.com/a', new Date(2026, 6, 8, 9));

    expect(service.isGranted('https://example.com/b', new Date(2026, 6, 8, 10))).toBe(true);
    expect(service.isGranted('https://sub.example.com/b', new Date(2026, 6, 8, 10))).toBe(false);
    expect(service.isGranted('http://example.com/b', new Date(2026, 6, 8, 10))).toBe(false);
  });

  it('revokes grants', () => {
    service.grantToday('https://example.com', new Date(2026, 6, 8, 9));
    service.revoke('https://example.com/path');

    expect(service.isGranted('https://example.com', new Date(2026, 6, 8, 10))).toBe(false);
  });
});
