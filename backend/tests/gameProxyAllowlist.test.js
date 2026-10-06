const allowlist = require('../services/gameProxyAllowlist');

describe('gameProxyAllowlist', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  test('allows the registry source host by default', () => {
    delete process.env.GAME_REGISTRY_URL;
    expect(allowlist.isAllowedHost('game.undersilicon.cn')).toBe(true);
    expect(allowlist.isAllowedHost('GAME.UNDERSILICON.CN')).toBe(true);
  });

  test('rejects arbitrary third-party hosts', () => {
    expect(allowlist.isAllowedHost('evil.example.com')).toBe(false);
    expect(allowlist.isAllowedHost('')).toBe(false);
    expect(allowlist.isEmbeddableHost('evil.example.com')).toBe(false);
  });

  test('allows loopback hosts for local development', () => {
    expect(allowlist.isAllowedHost('127.0.0.1:4178')).toBe(true);
    expect(allowlist.isAllowedHost('localhost:8080')).toBe(true);
    expect(allowlist.isAllowedHost('::1')).toBe(true);
  });

  test('honours GAME_PROXY_ALLOWED_HOSTS and GAME_REGISTRY_URL', () => {
    process.env.GAME_REGISTRY_URL = 'https://registry.example.test/registry.json';
    process.env.GAME_PROXY_ALLOWED_HOSTS = 'cdn.example.test, extra.example.test ';
    expect(allowlist.isAllowedHost('registry.example.test')).toBe(true);
    expect(allowlist.isAllowedHost('cdn.example.test')).toBe(true);
    expect(allowlist.isAllowedHost('extra.example.test')).toBe(true);
    expect(allowlist.isAllowedHost('game.undersilicon.cn')).toBe(false);
  });
});
