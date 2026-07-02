const fs = require('fs');
const os = require('os');
const path = require('path');

describe('pluginService', () => {
  let tempDir;
  let dataDir;
  let pluginRoot;
  let previousBuiltinDir;
  let previousUserDir;
  let previousDataDir;
  let previousActivePath;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-panel-plugins-'));
    dataDir = path.join(tempDir, 'data');
    pluginRoot = path.join(tempDir, 'builtin');
    fs.mkdirSync(path.join(pluginRoot, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'demo', 'detector.js'), '// demo\n', 'utf-8');
    fs.writeFileSync(path.join(pluginRoot, 'demo', 'manifest.json'), JSON.stringify({
      id: 'demo',
      title: 'Demo Plugin',
      description: 'test',
      homeUrl: 'https://example.test/',
      matchUrls: ['*://example.test/*'],
      devices: [{ id: 'shock', capabilities: ['shock'], required: true }],
      params: [{ key: 'shockVoltage', type: 'number', default: 12 }],
    }), 'utf-8');

    previousBuiltinDir = process.env.BUILTIN_PLUGINS_DIR;
    previousUserDir = process.env.PLUGIN_USER_DIR;
    previousDataDir = process.env.BACKEND_DATA_DIR;
    previousActivePath = process.env.ACTIVE_PLUGIN_PATH;
    process.env.BUILTIN_PLUGINS_DIR = pluginRoot;
    process.env.PLUGIN_USER_DIR = path.join(tempDir, 'user-plugins');
    process.env.BACKEND_DATA_DIR = dataDir;
    process.env.ACTIVE_PLUGIN_PATH = path.join(dataDir, 'active-plugin.json');
  });

  afterEach(() => {
    restoreEnv('BUILTIN_PLUGINS_DIR', previousBuiltinDir);
    restoreEnv('PLUGIN_USER_DIR', previousUserDir);
    restoreEnv('BACKEND_DATA_DIR', previousDataDir);
    restoreEnv('ACTIVE_PLUGIN_PATH', previousActivePath);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists manifest plugins and attaches detector paths', () => {
    const pluginService = require('../services/pluginService');
    const plugins = pluginService.listPlugins();
    const demo = plugins.find((plugin) => plugin.id === 'demo');

    expect(demo).toMatchObject({
      id: 'demo',
      title: 'Demo Plugin',
      homeUrl: 'https://example.test/',
      devices: [{ id: 'shock', capabilities: ['shock'], required: true }],
    });
    expect(demo.detectorPath).toBe(path.join(pluginRoot, 'demo', 'detector.js'));
  });

  it('writes active plugin mailbox with normalized device map and defaults', () => {
    const pluginService = require('../services/pluginService');

    const result = pluginService.activate('demo', {
      deviceMap: { shock: 'dev-1' },
      params: { cooldownMs: 3000 },
    });

    expect(result).toMatchObject({ ok: true, pluginId: 'demo', homeUrl: 'https://example.test/' });
    const active = JSON.parse(fs.readFileSync(path.join(dataDir, 'active-plugin.json'), 'utf-8'));
    expect(active).toMatchObject({
      pluginId: 'demo',
      deviceMap: { shock: ['dev-1'] },
      params: { shockVoltage: 12, cooldownMs: 3000 },
      homeUrl: 'https://example.test/',
      matchUrls: ['*://example.test/*'],
    });
  });
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
