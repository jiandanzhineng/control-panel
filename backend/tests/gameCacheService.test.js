const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

jest.mock('../services/gameRegistryService', () => ({
  getGameById: jest.fn(),
}));

const registry = require('../services/gameRegistryService');

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function createPackage(entries) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

function createTraversalPackage() {
  const zip = new AdmZip();
  zip.addFile('index.html', Buffer.from(indexHtml(), 'utf8'));
  zip.addFile('evil.js', Buffer.from('bad', 'utf8'));
  zip.getEntries().find((entry) => entry.entryName === 'evil.js').entryName = '../evil.js';
  return zip.toBuffer();
}

function indexHtml(id = 'demo-game', version = '1.0.0') {
  return `<!doctype html><html><head>
<script id="game-manifest" type="application/json">
{ "id": "${id}", "title": "Demo", "version": "${version}", "devices": [], "params": [] }
</script>
</head><body><script src="game.js"></script></body></html>`;
}

describe('gameCacheService', () => {
  let tempDir;
  let previousDataDir;
  let previousFetch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-cache-service-'));
    previousDataDir = process.env.BACKEND_DATA_DIR;
    previousFetch = global.fetch;
    process.env.BACKEND_DATA_DIR = path.join(tempDir, 'data');
    registry.getGameById.mockReset();
  });

  afterEach(() => {
    restoreEnv('BACKEND_DATA_DIR', previousDataDir);
    global.fetch = previousFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function mockRegistryWithPackage(buffer, overrides = {}) {
    const digest = sha256(buffer);
    registry.getGameById.mockResolvedValue({
      id: 'demo-game',
      title: 'Demo',
      version: '1.0.0',
      packageUrl: 'https://example.test/demo-game-1.0.0.zip',
      packageSha256: digest,
      source: 'remote',
      ...overrides,
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => buffer,
    });
    return digest;
  }

  it('installs a valid package and reports cache hit on second install', async () => {
    const buffer = createPackage({
      'index.html': indexHtml(),
      'game.js': 'window.demo = true;\n',
    });
    const digest = mockRegistryWithPackage(buffer);
    const service = require('../services/gameCacheService');

    const first = await service.installGame('demo-game');
    expect(first).toMatchObject({
      id: 'demo-game',
      cacheable: true,
      installed: true,
      version: '1.0.0',
      packageSha256: digest,
      localGamePath: '/games/cache/demo-game/1.0.0/index.html',
    });
    expect(fs.existsSync(path.join(process.env.BACKEND_DATA_DIR, 'game-cache', 'demo-game', '1.0.0', 'index.html'))).toBe(true);

    const second = await service.installGame('demo-game');
    expect(second.installed).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects packages with a sha256 mismatch', async () => {
    const buffer = createPackage({
      'index.html': indexHtml(),
      'game.js': 'window.demo = true;\n',
    });
    mockRegistryWithPackage(buffer, { packageSha256: '0'.repeat(64) });
    const service = require('../services/gameCacheService');

    await expect(service.installGame('demo-game')).rejects.toMatchObject({ code: 'GAME_CACHE_SHA_MISMATCH' });
    expect(fs.existsSync(path.join(process.env.BACKEND_DATA_DIR, 'game-cache', 'demo-game', '1.0.0'))).toBe(false);
  });

  it('rejects zip path traversal entries', async () => {
    const buffer = createTraversalPackage();
    mockRegistryWithPackage(buffer);
    const service = require('../services/gameCacheService');

    await expect(service.installGame('demo-game')).rejects.toMatchObject({ code: 'GAME_CACHE_UNSAFE_ZIP' });
  });

  it('rejects packages without index.html', async () => {
    const buffer = createPackage({ 'game.js': 'window.demo = true;\n' });
    mockRegistryWithPackage(buffer);
    const service = require('../services/gameCacheService');

    await expect(service.installGame('demo-game')).rejects.toMatchObject({ code: 'GAME_CACHE_INVALID_PACKAGE' });
  });

  it('rejects manifest id or version mismatches', async () => {
    const buffer = createPackage({
      'index.html': indexHtml('other-game', '1.0.0'),
      'game.js': 'window.demo = true;\n',
    });
    mockRegistryWithPackage(buffer);
    const service = require('../services/gameCacheService');

    await expect(service.installGame('demo-game')).rejects.toMatchObject({ code: 'GAME_CACHE_MANIFEST_MISMATCH' });
  });

  it('deletes installed cache and reports uninstalled status', async () => {
    const buffer = createPackage({
      'index.html': indexHtml(),
      'game.js': 'window.demo = true;\n',
    });
    mockRegistryWithPackage(buffer);
    const service = require('../services/gameCacheService');

    await service.installGame('demo-game');
    expect(service.deleteCache('demo-game', '1.0.0')).toEqual({ ok: true });
    const status = await service.getStatus('demo-game');
    expect(status).toMatchObject({ installed: false, cacheable: true, version: '1.0.0' });
  });
});
