const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, shell, webContents } = require('electron');
const { autoUpdater } = require('electron-updater');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const { fileURLToPath, pathToFileURL } = require('url');
const { BRIDGE_INTERNAL_HEADER } = require('../backend/constants/bridgeAccess.js');
const externalGameAccessService = require('../backend/services/externalGameAccessService.js');
const gameHost = require('./gameHost.js');
const { createLocalAppWindowController } = require('./localAppWindow.js');
const { createBleMainIntegration } = require('./ble/mainIntegration.js');
const { createQuitCoordinator } = require('./shutdownCoordinator.js');
const {
  UPDATE_FEEDS,
  parseLatestYmlVersion,
  pickUpdateFeed,
  isNewerVersion,
} = require('./updateFeed.js');

let server;
let frontendServer;
let backendApp;
let mainWindow;
let updateInitialized = false;
let browserDevicePreloadPath = '';
const browserWebviewOrigins = new Map();
let bleMainIntegration = null;
let localAppWindow = null;

function getUpdateSettingsPath() {
  return path.join(app.getPath('userData'), 'update-settings.json');
}

function getDefaultUpdateSettings() {
  let receiveTestUpdates = false;
  try {
    receiveTestUpdates = app.getVersion().includes('-');
  } catch {}
  return { receiveTestUpdates };
}

function normalizeUpdateSettings(settings = {}, defaults = getDefaultUpdateSettings()) {
  return {
    receiveTestUpdates:
      settings.receiveTestUpdates == null
        ? !!defaults.receiveTestUpdates
        : !!settings.receiveTestUpdates,
  };
}

function readUpdateSettings() {
  try {
    const raw = fs.readFileSync(getUpdateSettingsPath(), 'utf-8');
    return normalizeUpdateSettings(JSON.parse(raw));
  } catch {
    return getDefaultUpdateSettings();
  }
}

function writeUpdateSettings(settings) {
  const normalized = normalizeUpdateSettings(settings);
  fs.mkdirSync(path.dirname(getUpdateSettingsPath()), { recursive: true });
  fs.writeFileSync(
    getUpdateSettingsPath(),
    JSON.stringify(normalized, null, 2) + '\n',
    'utf-8',
  );
  return normalized;
}

function getUpdateChannel(settings = readUpdateSettings()) {
  return settings.receiveTestUpdates ? 'test' : 'stable';
}

function getUpdateStatus(settings = readUpdateSettings()) {
  const channel = getUpdateChannel(settings);
  return {
    settings,
    channel,
    feedUrl: UPDATE_FEEDS[channel],
  };
}

async function fetchFeedVersion(feedUrl) {
  try {
    const res = await fetch(new URL('latest.yml', feedUrl).toString(), {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return parseLatestYmlVersion(await res.text());
  } catch {
    return null;
  }
}

async function resolveUpdateStatus(settings = readUpdateSettings()) {
  const base = getUpdateStatus(settings);
  if (base.channel !== 'test') {
    return { ...base, recommendedChannel: 'stable' };
  }
  const [testVersion, stableVersion] = await Promise.all([
    fetchFeedVersion(UPDATE_FEEDS.test),
    fetchFeedVersion(UPDATE_FEEDS.stable),
  ]);
  const picked = pickUpdateFeed({ channel: 'test', testVersion, stableVersion });
  return {
    ...base,
    feedUrl: picked.feedUrl,
    recommendedChannel: picked.channel,
    testVersion,
    stableVersion,
    latestVersion: picked.version,
  };
}

async function configureAutoUpdate(settings = readUpdateSettings()) {
  if (!app.isPackaged) return getUpdateStatus(settings);
  const status = await resolveUpdateStatus(settings);

  autoUpdater.allowPrerelease = status.recommendedChannel === 'test';
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: status.feedUrl });
  } catch (error) {
    console.error('[electron] Failed to set update feed URL:', error);
  }
  return status;
}

function registerUpdateIpcHandlers() {
  ipcMain.handle('update:get-settings', () => getUpdateStatus());

  ipcMain.handle('update:set-settings', (_event, settings = {}) => {
    const saved = writeUpdateSettings(settings);
    return configureAutoUpdate(saved);
  });

  ipcMain.handle('update:check', async () => {
    const currentVersion = app.getVersion();
    if (!app.isPackaged) {
      return { skipped: true, reason: 'not-packaged', currentVersion, ...getUpdateStatus() };
    }

    const status = await configureAutoUpdate();
    try {
      const result = await autoUpdater.checkForUpdates();
      const latestVersion = result?.updateInfo?.version || status.latestVersion || null;
      return {
        ...status,
        skipped: false,
        available: isNewerVersion(latestVersion, currentVersion),
        currentVersion,
        latestVersion,
      };
    } catch (error) {
      return {
        ...status,
        skipped: false,
        available: false,
        currentVersion,
        error: error?.message || String(error),
      };
    }
  });
}

function registerPluginIpcHandlers() {
  ipcMain.handle('plugin:get-runtime-info', (_event, pluginId) => {
    const pluginService = getPluginService();
    const plugin = pluginService.getPluginById(pluginId);
    if (!plugin) {
      const error = new Error('插件不存在');
      error.code = 'PLUGIN_NOT_FOUND';
      throw error;
    }
    return {
      id: plugin.id,
      homeUrl: plugin.homeUrl,
      matchUrls: plugin.matchUrls || [],
      detectorPath: plugin.detectorPath,
      detectorUrl: pathToFileURL(plugin.detectorPath).toString(),
      activePluginPath: pluginService.getActivePluginPath(),
      bridgeUrl: pluginService.getBridgeUrl(),
    };
  });

  ipcMain.handle('plugin:stop-current', () => stopActiveBridgeSession());
}

// 判断两个 URL 是否同源（用于区分应用内导航与外部链接）
function isSameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// 获取资源路径，兼容开发和打包环境
function getResourcePath(relativePath) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, relativePath);
  }
  return path.join(__dirname, '..', relativePath);
}

function getAppRoot() {
  return app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
}

function getBackendModule(modulePath) {
  return require(path.join(getAppRoot(), 'backend', modulePath));
}

function getDeviceService() {
  return getBackendModule(path.join('services', 'deviceService.js'));
}

function normalizePreloadPath(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    if (value.startsWith('file:')) return path.resolve(fileURLToPath(value));
  } catch {}
  return path.resolve(value);
}

function urlMatchesPattern(url, pattern) {
  if (!url || !pattern) return false;
  const escaped = String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(url);
}

function pluginMatchesUrl(plugin, url) {
  const patterns = Array.isArray(plugin?.matchUrls) ? plugin.matchUrls : [];
  if (patterns.some((pattern) => urlMatchesPattern(url, pattern))) return true;
  return !!plugin?.homeUrl && urlMatchesPattern(url, plugin.homeUrl);
}

function getPluginService() {
  return getBackendModule(path.join('services', 'pluginService.js'));
}

function getBridgeService() {
  return getBackendModule(path.join('services', 'bridgeService.js'));
}

function getBrowserDeviceGrantService() {
  return getBackendModule(path.join('services', 'browserDeviceGrantService.js'));
}

function stopActiveBridgeSession() {
  try {
    return getBridgeService().exitCurrent();
  } catch (error) {
    console.error('[electron] Failed to stop active bridge session:', error);
    return { ok: false, error: error?.message || String(error) };
  }
}

function getWebviewOrigin(webContents) {
  try {
    return getBrowserDeviceGrantService().normalizeOrigin(webContents.getURL());
  } catch (error) {
    error.code = error.code || 'INVALID_ORIGIN';
    throw error;
  }
}

function ensureBrowserDeviceGrant(webContents) {
  const origin = getWebviewOrigin(webContents);
  const grantService = getBrowserDeviceGrantService();
  if (!grantService.isGranted(origin)) {
    const error = new Error('当前网站未获得设备控制授权');
    error.code = 'BROWSER_DEVICE_NOT_GRANTED';
    error.origin = origin;
    throw error;
  }
  return origin;
}

function getTargetWebviewContents(webContentsId) {
  const id = Number(webContentsId);
  const target = Number.isFinite(id) ? webContents.fromId(id) : null;
  if (!target || (target.getType && target.getType() !== 'webview')) {
    const error = new Error('目标 webview 不存在');
    error.code = 'WEBVIEW_NOT_FOUND';
    throw error;
  }
  return target;
}

async function browserDeviceResult(handler) {
  try {
    return await handler();
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      code: error?.code || 'BROWSER_DEVICE_ERROR',
      origin: error?.origin,
    };
  }
}

function registerBrowserDeviceIpcHandlers() {
  ipcMain.handle('browser-device:get-grant-status', (event) => browserDeviceResult(() => {
    const origin = getWebviewOrigin(event.sender);
    return { ok: true, ...getBrowserDeviceGrantService().getStatus(origin) };
  }));

  ipcMain.handle('browser-device:get-grant-status-for-webview', (_event, webContentsId) => browserDeviceResult(() => {
    const target = getTargetWebviewContents(webContentsId);
    const origin = getWebviewOrigin(target);
    return { ok: true, ...getBrowserDeviceGrantService().getStatus(origin) };
  }));

  ipcMain.handle('browser-device:request-access', async (event) => browserDeviceResult(async () => {
    const origin = getWebviewOrigin(event.sender);
    const grantService = getBrowserDeviceGrantService();
    const existing = grantService.getGrant(origin);
    if (existing) return { ok: true, granted: true, origin, expiresAt: existing.expiresAt };

    const result = await dialog.showMessageBox(mainWindow || BrowserWindow.fromWebContents(event.sender) || undefined, {
      type: 'warning',
      title: '设备控制授权',
      message: `${origin} 请求访问设备控制能力`,
      detail: '允许后，该网站今天内可以通过 DeviceAPI 控制当前客户端已接入的全部设备和能力。\n\n请确认你信任该网站。恶意网页可能导致设备误触发或持续输出。',
      buttons: ['允许今天访问', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });

    if (result.response !== 0) {
      const error = new Error('用户拒绝设备控制授权');
      error.code = 'BROWSER_DEVICE_DENIED';
      error.origin = origin;
      throw error;
    }

    const grant = grantService.grantToday(origin);
    return { ok: true, granted: true, origin, expiresAt: grant.expiresAt };
  }));

  ipcMain.handle('browser-device:revoke-access', (event) => browserDeviceResult(() => {
    const origin = getWebviewOrigin(event.sender);
    getBrowserDeviceGrantService().revoke(origin);
    getBridgeService().exitBrowserOrigin(origin);
    return { ok: true, origin, granted: false };
  }));

  ipcMain.handle('browser-device:revoke-access-for-webview', (_event, webContentsId) => browserDeviceResult(() => {
    const target = getTargetWebviewContents(webContentsId);
    const origin = getWebviewOrigin(target);
    getBrowserDeviceGrantService().revoke(origin);
    getBridgeService().exitBrowserOrigin(origin);
    return { ok: true, origin, granted: false };
  }));

  ipcMain.handle('browser-device:stop-origin', (event) => browserDeviceResult(() => {
    const origin = getWebviewOrigin(event.sender);
    getBridgeService().exitBrowserOrigin(origin);
    return { ok: true, origin };
  }));

  ipcMain.handle('browser-device:stop-origin-for-webview', (_event, webContentsId) => browserDeviceResult(() => {
    const target = getTargetWebviewContents(webContentsId);
    const origin = getWebviewOrigin(target);
    getBridgeService().exitBrowserOrigin(origin);
    return { ok: true, origin };
  }));

  ipcMain.handle('browser-device:command', (event, action, payload = {}) => browserDeviceResult(() => {
    const origin = ensureBrowserDeviceGrant(event.sender);
    const result = getBridgeService().runBrowserCommand(origin, action, payload || {});
    return { ok: true, result };
  }));
}

function getBackendBaseUrl() {
  return process.env.BACKEND_URL || 'http://127.0.0.1:5278';
}

function parseAuthorizedGameHostRequest(event, req) {
  const origin = getWebviewOrigin(event.sender);
  const { enabled: developerModeEnabled } = externalGameAccessService.getStatus();
  gameHost.assertAllowedOrigin(origin, { developerModeEnabled });
  const { gameId } = gameHost.parseGameHostRequest(req);
  return { origin, gameId };
}

// GameHost 契约：官方网站在内置浏览器 <webview> 里通过 window.GameHost
// 调 cache/launch。origin 用宿主侧记录的 event.sender URL 校验，不信任消息内容。
function registerGameHostIpcHandlers() {
  ipcMain.handle('game-host:cache', (event, req) => browserDeviceResult(async () => {
    const { origin, gameId } = parseAuthorizedGameHostRequest(event, req);

    const url = gameHost.buildInstallUrl(getBackendBaseUrl(), gameId);
    const response = await fetch(url, { method: 'POST' });
    let body = null;
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = new Error(body?.message || `缓存安装失败(${response.status})`);
      error.code = body?.code || 'GAME_HOST_CACHE_FAILED';
      error.origin = origin;
      throw error;
    }
    return { ok: true, gameId, origin, status: body };
  }));

  ipcMain.handle('game-host:launch', (event, req) => browserDeviceResult(async () => {
    const { origin, gameId } = parseAuthorizedGameHostRequest(event, req);

    // 启动前停掉当前浏览器 origin 的设备会话，避免与原生配置页/运行态串扰。
    try { getBridgeService().exitBrowserOrigin(origin); } catch (_) {}

    const path = gameHost.buildLaunchPath(gameId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('game-host:navigate', { path });
      try { mainWindow.show(); mainWindow.focus(); } catch (_) {}
    }
    return { ok: true, gameId, origin, path };
  }));
}

function stopLocalAppProcess(id) {
  const base = process.env.BACKEND_URL || 'http://127.0.0.1:5278';
  if (!id) return;
  fetch(`${base}/api/local-apps/${encodeURIComponent(id)}/stop`, { method: 'POST' }).catch(() => {});
}

function registerLocalAppWindowHandlers() {
  localAppWindow = createLocalAppWindowController({
    BrowserWindow,
    ipcMain,
    getMainWindow: () => mainWindow,
    onClosed: (payload) => stopLocalAppProcess(payload && payload.id),
  });
  localAppWindow.registerHandlers();
}

function stopBrowserDeviceSessionForContents(webviewContents) {
  try {
    const origin = browserWebviewOrigins.get(webviewContents.id)
      || getBrowserDeviceGrantService().normalizeOrigin(webviewContents.getURL());
    getBridgeService().exitBrowserOrigin(origin);
    browserWebviewOrigins.delete(webviewContents.id);
  } catch (_) {}
}

function updateBrowserWebviewOrigin(webviewContents) {
  try {
    const origin = getBrowserDeviceGrantService().normalizeOrigin(webviewContents.getURL());
    browserWebviewOrigins.set(webviewContents.id, origin);
    return origin;
  } catch (_) {
    browserWebviewOrigins.delete(webviewContents.id);
    return '';
  }
}

function stopIfWebviewLeavesOrigin(webviewContents, nextUrl) {
  try {
    const currentOrigin = browserWebviewOrigins.get(webviewContents.id)
      || getBrowserDeviceGrantService().normalizeOrigin(webviewContents.getURL());
    const nextOrigin = getBrowserDeviceGrantService().normalizeOrigin(nextUrl);
    if (currentOrigin && nextOrigin && currentOrigin !== nextOrigin) {
      getBridgeService().exitBrowserOrigin(currentOrigin);
    }
  } catch (_) {
    stopBrowserDeviceSessionForContents(webviewContents);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // 默认收起原生菜单栏（File/Edit/View/...），按 Alt 可临时唤出；
    // 菜单本身保留，故 Ctrl+Shift+I 等默认快捷键仍可用
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  mainWindow = win;
  bleMainIntegration.attachWindow(win);
  win.on('close', (event) => quitCoordinator.handleWindowClose(event));

  // 外部链接（target="_blank" 或 window.open）使用系统默认浏览器打开，而非 Electron 新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 拦截当前页面内导航到外部地址的情况，改用系统浏览器
  win.webContents.on('will-navigate', (event, url) => {
    const currentUrl = win.webContents.getURL();
    if (/^https?:\/\//i.test(url) && !isSameOrigin(url, currentUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const frontendUrl = process.env.FRONTEND_URL;
  
  if (devUrl) {
    win.loadURL(devUrl);
  } else if (frontendUrl) {
    win.loadURL(frontendUrl);
  } else {
    const appPath = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
    const indexPath = path.join(appPath, 'frontend', 'dist', 'index.html');
    
    console.log(`[electron] Loading index.html from: ${indexPath}`);
    if (fs.existsSync(indexPath)) {
      win.loadFile(indexPath);
    } else {
      console.error(`[electron] Index file not found: ${indexPath}`);
      win.loadURL('data:text/html,<h1>Frontend files not found</h1>');
    }
  }
}

// 内置浏览器 <webview> 的导航与安全处理。
// - webview 内部浏览全部放行（不像顶层窗口那样把外链踢到系统浏览器）。
// - 收紧 webview 安全：去掉 preload、关 nodeIntegration、开 contextIsolation，
//   避免被浏览的任意外站获得壳的能力。
function setupWebviewHandling() {
  browserDevicePreloadPath = path.resolve(path.join(__dirname, 'browser-device-preload.js'));
  app.on('web-contents-created', (_e, contents) => {
    const pendingPluginWebviews = new Map();

    if (contents.getType && contents.getType() === 'webview') {
      contents.on('will-navigate', (_event, url) => {
        stopIfWebviewLeavesOrigin(contents, url);
      });
      contents.on('did-navigate', () => {
        updateBrowserWebviewOrigin(contents);
      });
      contents.on('did-navigate-in-page', () => {
        updateBrowserWebviewOrigin(contents);
      });
      contents.on('destroyed', () => {
        stopBrowserDeviceSessionForContents(contents);
      });
      // webview 内的弹窗/新窗口：留在 webview 内导航，不踢系统浏览器。
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
          try { contents.loadURL(url); } catch {}
        }
        return { action: 'deny' };
      });
      // webview 内浏览全部放行（这才是"内置浏览器"该有的行为）。
    }

    // 附加 webview 前收紧其 webPreferences。
    contents.on('will-attach-webview', (_evt, webPreferences, params) => {
      const requestedPreload = normalizePreloadPath(webPreferences.preload || webPreferences.preloadURL || params?.preload || '');
      const src = String(params?.src || '');
      let pluginForWebview = null;
      const isBrowserDevicePreload = requestedPreload && requestedPreload === browserDevicePreloadPath;

      if (requestedPreload) {
        try {
          pluginForWebview = getPluginService()
            .listPlugins()
            .find((plugin) => path.resolve(plugin.detectorPath) === requestedPreload && pluginMatchesUrl(plugin, src));
        } catch (error) {
          console.error('[electron] Plugin preload validation failed:', error);
        }
      }

      delete webPreferences.preload;
      delete webPreferences.preloadURL;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;

      if (pluginForWebview) {
        webPreferences.preload = pluginForWebview.detectorPath;
        webPreferences.sandbox = false;
        pendingPluginWebviews.set(contents.id, pluginForWebview.id);
      } else if (isBrowserDevicePreload || !requestedPreload) {
        webPreferences.preload = browserDevicePreloadPath;
      }
    });

    contents.on('did-attach-webview', (_evt, webviewContents) => {
      const pluginId = pendingPluginWebviews.get(contents.id);
      pendingPluginWebviews.delete(contents.id);
      if (!pluginId || !webviewContents) return;
      webviewContents.once('destroyed', () => {
        stopActiveBridgeSession();
      });
    });
  });
}

async function initAutoUpdate() {
  if (!app.isPackaged) return;

  if (updateInitialized) {
    await configureAutoUpdate();
    return;
  }
  updateInitialized = true;

  await configureAutoUpdate();

  autoUpdater.on('update-available', () => {});

  autoUpdater.on('update-downloaded', () => {
    // 下载完成，询问是否重启安装
    try {
      dialog
        .showMessageBox(mainWindow || undefined, {
          type: 'question',
          title: '更新已准备就绪',
          message: '更新已下载，是否立即重启并安装？',
          buttons: ['立即安装', '稍后'],
          defaultId: 0,
        })
        .then(({ response }) => {
          if (response === 0) autoUpdater.quitAndInstall();
        });
    } catch {
      autoUpdater.quitAndInstall();
    }
  });

  try { autoUpdater.checkForUpdates(); } catch {}
}

function startFrontendServer(callback) {
  const frontendApp = express();
  const appPath = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
  const distPath = path.join(appPath, 'frontend', 'dist');
  
  console.log(`[electron] Frontend dist path: ${distPath}`);
  
  if (!fs.existsSync(distPath)) {
    console.error(`[electron] Frontend dist directory not found: ${distPath}`);
    callback();
    return;
  }
  
  // API转发中间件：将/api/*请求转发到后端
  frontendApp.use('/api', createProxyMiddleware({
    target: process.env.BACKEND_URL || 'http://127.0.0.1:5278',
    changeOrigin: true,
    logLevel: 'debug',
    pathRewrite: {
      '^/': '/api/'  // 将剩余路径重新添加/api前缀
    }
  }));

  // 游戏静态/第三方代理/Bridge 脚本 转发到后端（保持原路径），使游戏 iframe 与控制台同源。
  // 注意：http-proxy-middleware v3 在 app.use('/前缀', ...) 时会被 Express 剥掉挂载前缀，
  // 转发到后端的 req.url 不含该前缀，因此必须用 pathRewrite 把前缀补回，否则后端 404。
  const backendTarget = process.env.BACKEND_URL || 'http://127.0.0.1:5278';
  frontendApp.use('/games', createProxyMiddleware({
    target: backendTarget,
    changeOrigin: true,
    pathRewrite: { '^/': '/games/' },
  }));
  frontendApp.use('/bridge-api', createProxyMiddleware({
    target: backendTarget,
    changeOrigin: true,
    pathRewrite: { '^/': '/bridge-api/' },
    on: {
      proxyReq(proxyReq) {
        proxyReq.setHeader(BRIDGE_INTERNAL_HEADER, '1');
      },
    },
  }));
  // Bridge WebSocket 转发。
  // WS 升级请求走下方 frontendServer.on('upgrade') 直接调用 .upgrade()，
  // 此时 req.url 是未被 Express 剥离的完整 /bridge/... 路径，故不能加 pathRewrite，
  // 否则会变成 /bridge/bridge/...。
  const bridgeWsProxy = createProxyMiddleware({
    target: backendTarget,
    changeOrigin: true,
    ws: true,
    on: {
      proxyReqWs(proxyReq) {
        proxyReq.setHeader(BRIDGE_INTERNAL_HEADER, '1');
      },
    },
  });
  frontendApp.use('/bridge', bridgeWsProxy);
  
  frontendApp.use(express.static(distPath));
  frontendApp.get('/*path', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
  
  const FRONTEND_PORT = 5277;
  frontendServer = frontendApp.listen(FRONTEND_PORT, () => {
    process.env.FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
    console.log(`[electron] frontend server started: ${process.env.FRONTEND_URL}`);
    callback();
  });
  // 将 /bridge 的 WebSocket 升级请求转发到后端
  frontendServer.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/bridge')) {
      bridgeWsProxy.upgrade(req, socket, head);
    }
  });
}

function startBackendThenWindow() {
  try {
    const appPath = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
    const backendPath = path.join(appPath, 'backend', 'index.js');
    const userDataDir = app.getPath('userData');
    process.env.BACKEND_DATA_DIR = path.join(userDataDir, 'data');
    process.env.ACTIVE_PLUGIN_PATH = path.join(process.env.BACKEND_DATA_DIR, 'active-plugin.json');
    
    console.log(`[electron] Backend path: ${backendPath}`);
    
    if (!fs.existsSync(backendPath)) {
      console.error(`[electron] Backend file not found: ${backendPath}`);
      createWindow(); // 即使后端启动失败也创建窗口
      return;
    }
    
    const logService = require(path.join(appPath, 'backend', 'services', 'logService.js'));
    logService.cleanOldLogs();
    backendApp = require(backendPath);
    const BACKEND_PORT = 5278;
    // 必须 listen 后端导出的 server（已挂 /bridge WS），不能对 app 重新 listen——
    // 否则会新建一个不带 WS 的 server，插件 bridge 握手 404。回退到 app 仅为兼容旧导出。
    const backendServer = backendApp.server || backendApp;
    server = backendServer.listen(BACKEND_PORT, () => {
      process.env.BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
      console.log(`[electron] backend started: ${process.env.BACKEND_URL}`);
      
      // 如果不是开发模式，启动前端服务器
      console.log(`[electron] VITE_DEV_SERVER_URL: ${process.env.VITE_DEV_SERVER_URL}`);
      if (!process.env.VITE_DEV_SERVER_URL) {
        console.log('[electron] starting frontend server...');
        startFrontendServer(createWindow);
      } else {
        console.log('[electron] using dev server, skipping frontend server');
        createWindow();
      }
    });
    
    server.on('error', (err) => {
      console.error('[electron] Backend server error:', err);
      createWindow(); // 后端启动失败时仍然创建窗口
    });
  } catch (error) {
    console.error('[electron] Error starting backend:', error);
    createWindow(); // 出现异常时仍然创建窗口
  }
}

app.whenReady().then(() => {
  bleMainIntegration = createBleMainIntegration({
    ipcMain,
    getDeviceService,
    logger: console,
  });
  bleMainIntegration.registerHandlers();
  registerUpdateIpcHandlers();
  registerPluginIpcHandlers();
  registerBrowserDeviceIpcHandlers();
  registerGameHostIpcHandlers();
  registerLocalAppWindowHandlers();
  setupWebviewHandling();
  startBackendThenWindow();
  initAutoUpdate().catch((error) => {
    console.error('[electron] Auto update init failed:', error);
  });
});

function closeServer(target) {
  if (!target || !target.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    target.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const quitCoordinator = createQuitCoordinator({
  app,
  timeoutMs: 5000,
  shutdown: async () => {
    if (typeof backendApp?.shutdownBackend === 'function') {
      await backendApp.shutdownBackend('electron-before-quit', {
        beforeTransportShutdown: () => bleMainIntegration?.requestDisconnectAll(
          mainWindow,
          { timeoutMs: 3000 },
        ),
      });
    } else {
      await bleMainIntegration?.requestDisconnectAll(mainWindow, { timeoutMs: 3000 });
      await closeServer(server);
    }
    localAppWindow?.destroyForQuit();
    await closeServer(frontendServer);
  },
  onError: (error) => {
    console.error('[electron] shutdown failed:', error?.message || error);
  },
});

app.on('before-quit', quitCoordinator.handleBeforeQuit);
app.on('window-all-closed', () => { app.quit(); });
