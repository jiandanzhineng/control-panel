const { formatElectronText } = require('./locale');

// 应用图标；单测里 electron 是精简 mock，取不到时不设图标
function appIconPath() {
  try {
    return require('./tray').getTrayIconPath();
  } catch {
    return undefined;
  }
}

function withTitleHint(title, locale = 'zh') {
  const hint = formatElectronText(locale, 'titleHint');
  const fallback = locale === 'en' ? 'Xiaoya' : '小雅';
  const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const base = String(title || fallback).replace(new RegExp(`\\s*${escaped}\\s*$`), '').trim() || fallback;
  return `${base}  ${hint}`;
}

function handleLocalAppHotkey(win, input) {
  if (!win || win.isDestroyed() || input.type !== 'keyDown') return false;
  if (input.key === 'F11') {
    win.setFullScreen(!win.isFullScreen());
    return true;
  }
  if (input.key === 'Escape' && win.isFullScreen()) {
    win.setFullScreen(false);
    return true;
  }
  return false;
}

function isLocalAppUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname;
    const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    return parsed.protocol === 'http:' && local;
  } catch (_) {
    return false;
  }
}

function attachMediaPermission(win, fallbackUrl) {
  // 与小雅窗口共用默认 session 的还有主窗口：媒体权限统一按「本机来源」判定，
  // 后安装的处理器不会把游戏页的麦克风放开或收紧成另一套规则。
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== 'media' && permission !== 'microphone') return callback(true);
    callback(isTrustedMediaUrl(details?.requestingUrl || wc?.getURL?.() || fallbackUrl));
  });
}

// 主窗口的媒体权限：游戏页 iframe 与面板自身都要用麦克风（语音开始、游戏内语音识别），
// 只放开本机来源，其他权限维持 Electron 默认行为。
// iframe 请求按 details.requestingUrl / securityOrigin 判定（顶层是 file: 面板，不能只看 webContents.getURL）。
function isTrustedMediaUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol === 'file:') return true; // 打包后的面板自身
    return parsed.protocol === 'http:' && isLocalAppUrl(url);
  } catch {
    return false;
  }
}

function attachGameMediaPermissions(session) {
  if (!session) return;
  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== 'media' && permission !== 'microphone') return callback(true);
    callback(isTrustedMediaUrl(details?.requestingUrl || wc?.getURL?.()));
  });
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (permission !== 'media' && permission !== 'microphone') return true;
    return isTrustedMediaUrl(details?.requestingUrl || requestingOrigin);
  });
}

function createLocalAppWindowController({
  BrowserWindow,
  ipcMain,
  getMainWindow,
  onClosed = () => {},
}) {
  let win = null;
  let current = null;

  function notifyClosed(payload) {
    const main = getMainWindow && getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send('local-app:window-closed', payload || {});
    }
    try { onClosed(payload || {}); } catch (_) {}
  }

  function closeWindow({ silent = false } = {}) {
    const payload = current;
    if (win && !win.isDestroyed()) {
      win.removeAllListeners('closed');
      win.close();
    }
    win = null;
    current = null;
    if (!silent && payload) notifyClosed(payload);
    return { ok: true };
  }

  function openWindow(input = {}) {
    const url = String(input.url || '');
    const id = String(input.id || '');
    const locale = input.locale === 'en' ? 'en' : 'zh';
    const title = String(input.title || (locale === 'en' ? 'Xiaoya' : '小雅'));
    if (!isLocalAppUrl(url) || !id) {
      return { ok: false, error: 'invalid local app window' };
    }
    closeWindow({ silent: true });
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      icon: appIconPath(),
      title: withTitleHint(title, locale),
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    current = { id, url, title, locale };
    win.on('page-title-updated', (event, next) => {
      event.preventDefault();
      if (win && !win.isDestroyed()) win.setTitle(withTitleHint(next, locale));
    });
    win.webContents.on('before-input-event', (event, input) => {
      if (handleLocalAppHotkey(win, input)) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(({ url: next }) => (
      isLocalAppUrl(next) ? { action: 'allow' } : { action: 'deny' }
    ));
    attachMediaPermission(win, url);
    win.on('closed', () => {
      const payload = current;
      win = null;
      current = null;
      if (payload) notifyClosed(payload);
    });
    win.loadURL(url);
    return { ok: true, id, url };
  }

  function focusWindow() {
    if (!win || win.isDestroyed()) return { ok: false };
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return { ok: true };
  }

  function registerHandlers() {
    ipcMain.handle('local-app:open-window', (_e, payload) => openWindow(payload || {}));
    ipcMain.handle('local-app:close-window', () => closeWindow({ silent: true }));
    ipcMain.handle('local-app:focus-window', () => focusWindow());
  }

  return {
    registerHandlers,
    openWindow,
    closeWindow,
    focusWindow,
    destroyForQuit: () => closeWindow({ silent: true }),
  };
}

module.exports = {
  get TITLE_HINT() {
    return formatElectronText('zh', 'titleHint');
  },
  withTitleHint,
  handleLocalAppHotkey,
  isLocalAppUrl,
  isTrustedMediaUrl,
  attachGameMediaPermissions,
  createLocalAppWindowController,
};
