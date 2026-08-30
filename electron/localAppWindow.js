const { formatElectronText } = require('./locale');

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
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    const media = permission === 'media' || permission === 'microphone';
    if (win && !win.isDestroyed() && wc.id === win.webContents.id) {
      callback(media && isLocalAppUrl(wc.getURL() || fallbackUrl));
      return;
    }
    callback(true);
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
  createLocalAppWindowController,
};
