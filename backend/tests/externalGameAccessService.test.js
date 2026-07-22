const fs = require('fs');
const os = require('os');
const path = require('path');

describe('externalGameAccessService', () => {
  let tempDir;
  let statePath;
  let service;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-game-access-'));
    statePath = path.join(tempDir, 'external-game-access.json');
    process.env.EXTERNAL_GAME_ACCESS_PATH = statePath;
    service = require('../services/externalGameAccessService');
  });

  afterEach(() => {
    delete process.env.EXTERNAL_GAME_ACCESS_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults to disabled with empty origins', () => {
    expect(service.getStatus()).toEqual({ enabled: false, origins: [] });
    expect(service.isTrustedDevOrigin('http://localhost:8080')).toBe(false);
  });

  it('trusts any local loopback port when enabled', () => {
    service.setStatus({ enabled: true });
    expect(service.isTrustedDevOrigin('http://localhost:8080')).toBe(true);
    expect(service.isTrustedDevOrigin('http://127.0.0.1:9999')).toBe(true);
    expect(service.isTrustedDevOrigin('http://127.0.0.5:3000')).toBe(true);
    // 非回环地址不因开关自动放行
    expect(service.isTrustedDevOrigin('http://192.168.1.10:8080')).toBe(false);
  });

  it('trusts explicitly listed origins when enabled', () => {
    service.setStatus({ enabled: true, origins: ['http://192.168.1.10:8080'] });
    expect(service.isTrustedDevOrigin('http://192.168.1.10:8080')).toBe(true);
    expect(service.isTrustedDevOrigin('http://192.168.1.11:8080')).toBe(false);
  });

  it('never trusts anything while disabled', () => {
    service.setStatus({ enabled: false, origins: ['http://192.168.1.10:8080'] });
    expect(service.isTrustedDevOrigin('http://localhost:8080')).toBe(false);
    expect(service.isTrustedDevOrigin('http://192.168.1.10:8080')).toBe(false);
  });

  it('drops invalid origins and dedupes', () => {
    const next = service.setStatus({
      enabled: true,
      origins: ['http://a.test:1', 'not-a-url', 'ftp://x', 'http://a.test:1'],
    });
    expect(next.origins).toEqual(['http://a.test:1']);
  });

  it('persists state to disk', () => {
    service.setStatus({ enabled: true, origins: ['http://a.test:1'] });
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(raw.enabled).toBe(true);
    expect(raw.origins).toEqual(['http://a.test:1']);
  });
});
