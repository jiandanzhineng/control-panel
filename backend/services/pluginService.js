const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { withPlayI18n } = require('../utils/playI18n');

const backendRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(backendRoot, '..');

function uniqExistingDirs(dirs) {
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (fs.existsSync(resolved)) out.push(resolved);
  }
  return out;
}

function getBuiltinPluginDirs() {
  if (process.env.BUILTIN_PLUGINS_DIR) {
    return uniqExistingDirs([process.env.BUILTIN_PLUGINS_DIR]);
  }
  const resourcePlugins = process.resourcesPath ? path.join(process.resourcesPath, 'plugins') : '';
  if (resourcePlugins && fs.existsSync(resourcePlugins)) {
    return uniqExistingDirs([resourcePlugins]);
  }
  return uniqExistingDirs([path.join(backendRoot, 'plugins')]);
}

function getUserPluginsDir() {
  if (process.env.PLUGIN_USER_DIR) return path.resolve(process.env.PLUGIN_USER_DIR);
  if (process.env.BACKEND_DATA_DIR) return path.join(path.dirname(path.resolve(process.env.BACKEND_DATA_DIR)), 'plugins');
  return path.join(projectRoot, 'userData', 'plugins');
}

function getPluginRoots() {
  return [
    ...getBuiltinPluginDirs(),
    getUserPluginsDir(),
  ];
}

function readManifest(pluginDir) {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  const raw = fs.readFileSync(manifestPath, 'utf-8');
  const manifest = JSON.parse(raw);
  const id = String(manifest.id || path.basename(pluginDir)).trim();
  if (!id) return null;

  const detectorPath = path.join(pluginDir, 'detector.js');
  return withPlayI18n({
    id,
    title: manifest.title || manifest.name || id,
    name: manifest.name || manifest.title || id,
    description: manifest.description || '',
    version: manifest.version || '1.0.0',
    homeUrl: manifest.homeUrl || '',
    matchUrls: Array.isArray(manifest.matchUrls) ? manifest.matchUrls : [],
    devices: Array.isArray(manifest.devices) ? manifest.devices : [],
    params: Array.isArray(manifest.params) ? manifest.params : [],
    detectorPath,
    folder: path.basename(pluginDir),
    pluginDir,
    source: pluginDir.startsWith(path.resolve(getUserPluginsDir())) ? 'user' : 'builtin',
  }, manifest);
}

function scanPluginRoot(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const plugins = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(rootDir, entry.name);
    try {
      const plugin = readManifest(pluginDir);
      if (plugin) plugins.push(plugin);
    } catch (error) {
      logger.warn('Scan plugin failed', { dir: pluginDir, err: error?.message || String(error) });
    }
  }
  return plugins;
}

function listPlugins() {
  const byId = new Map();
  for (const root of getPluginRoots()) {
    for (const plugin of scanPluginRoot(root)) {
      byId.set(plugin.id, plugin);
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
}

function getPluginById(id) {
  const key = String(id || '');
  return listPlugins().find((plugin) => plugin.id === key) || null;
}

function normalizeDeviceMap(deviceMap = {}) {
  const normalized = {};
  for (const [logicalId, value] of Object.entries(deviceMap || {})) {
    normalized[logicalId] = Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);
  }
  return normalized;
}

function defaultsFromParams(params = []) {
  const defaults = {};
  for (const param of params || []) {
    if (param?.key && Object.prototype.hasOwnProperty.call(param, 'default')) {
      defaults[param.key] = param.default;
    }
  }
  return defaults;
}

function getActivePluginPath() {
  if (process.env.ACTIVE_PLUGIN_PATH) return path.resolve(process.env.ACTIVE_PLUGIN_PATH);
  if (process.env.BACKEND_DATA_DIR) return path.join(path.resolve(process.env.BACKEND_DATA_DIR), 'active-plugin.json');
  return path.join(backendRoot, 'data', 'active-plugin.json');
}

function backendUrlToBridgeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    parsed.pathname = '/bridge';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

function getBridgeUrl() {
  if (process.env.PLUGIN_BRIDGE_URL) return process.env.PLUGIN_BRIDGE_URL;
  if (process.env.FRONTEND_URL) return backendUrlToBridgeUrl(process.env.FRONTEND_URL);
  if (process.env.BACKEND_URL) return backendUrlToBridgeUrl(process.env.BACKEND_URL);
  const port = process.env.PORT || '3000';
  return `ws://127.0.0.1:${port}/bridge`;
}

function activate(id, payload = {}) {
  const plugin = getPluginById(id);
  if (!plugin) {
    const error = new Error('插件不存在');
    error.code = 'PLUGIN_NOT_FOUND';
    throw error;
  }

  const activeConfig = {
    pluginId: plugin.id,
    deviceMap: normalizeDeviceMap(payload.deviceMap || payload.deviceMapping || {}),
    params: {
      ...defaultsFromParams(plugin.params),
      ...(payload.params || payload.parameters || {}),
    },
    locale: payload.locale === 'en' ? 'en' : 'zh',
    localeTag: payload.localeTag || (payload.locale === 'en' ? 'en-US' : 'zh-CN'),
    homeUrl: plugin.homeUrl,
    matchUrls: plugin.matchUrls,
    bridgeUrl: getBridgeUrl(),
    startedAt: Date.now(),
  };

  const activePath = getActivePluginPath();
  fs.mkdirSync(path.dirname(activePath), { recursive: true });
  fs.writeFileSync(activePath, JSON.stringify(activeConfig, null, 2) + '\n', 'utf-8');
  return {
    ok: true,
    pluginId: plugin.id,
    homeUrl: plugin.homeUrl,
    activePluginPath: activePath,
  };
}

module.exports = {
  listPlugins,
  getPluginById,
  activate,
  getActivePluginPath,
  getBridgeUrl,
  getPluginRoots,
};
