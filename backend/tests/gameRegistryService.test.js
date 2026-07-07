const fs = require('fs');
const os = require('os');
const path = require('path');

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('gameRegistryService', () => {
  let tempDir;
  let previousDataDir;
  let previousSource;
  let previousFetch;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-registry-service-'));
    previousDataDir = process.env.BACKEND_DATA_DIR;
    previousSource = process.env.GAME_REGISTRY_URL;
    previousFetch = global.fetch;
    process.env.BACKEND_DATA_DIR = path.join(tempDir, 'data');
    process.env.GAME_REGISTRY_URL = 'https://game.example.test/registry.json';
  });

  afterEach(() => {
    restoreEnv('BACKEND_DATA_DIR', previousDataDir);
    restoreEnv('GAME_REGISTRY_URL', previousSource);
    global.fetch = previousFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function mockRegistry(data) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => data,
    });
  }

  it('loads schema v2 registry entries without warning and preserves v2 fields', async () => {
    mockRegistry({
      schemaVersion: 2,
      games: [{
        id: 'demo-game',
        title: 'Demo Game',
        description: 'Demo',
        version: '1.2.3',
        path: 'games/demo-game/index.html',
        sha256: 'b'.repeat(64),
        size: 32,
        packageUrl: 'packages/demo-game-1.2.3-abcd1234.zip',
        packageSha256: 'a'.repeat(64),
        packageSize: 512,
        cacheable: true,
        allowedOrigins: ['https://api.example.test'],
        files: [
          { path: 'index.html', sha256: 'c'.repeat(64), size: 20 },
          { path: 'game.js', sha256: 'd'.repeat(64), size: 12 },
        ],
      }],
    });

    const service = require('../services/gameRegistryService');
    const list = await service.listForClient({ force: true });
    expect(list.schemaWarning).toBeNull();
    expect(list.games[0]).toMatchObject({
      id: 'demo-game',
      gamePath: '/games/proxy/https/game.example.test/games/demo-game/index.html',
      externalUrl: 'https://game.example.test/games/demo-game/index.html',
      allowedOrigins: ['https://api.example.test'],
      files: [
        { path: 'index.html', sha256: 'c'.repeat(64), size: 20 },
        { path: 'game.js', sha256: 'd'.repeat(64), size: 12 },
      ],
    });

    const detail = await service.getGameById('demo-game');
    expect(detail).toMatchObject({
      id: 'demo-game',
      external: true,
      allowedOrigins: ['https://api.example.test'],
      files: [
        { path: 'index.html', sha256: 'c'.repeat(64), size: 20 },
        { path: 'game.js', sha256: 'd'.repeat(64), size: 12 },
      ],
    });
  });
});
