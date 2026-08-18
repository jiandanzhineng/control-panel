const {
  isLocalAppUrl,
  withTitleHint,
  handleLocalAppHotkey,
  createLocalAppWindowController,
} = require('../../electron/localAppWindow');

function createFakeWindow() {
  const handlers = {};
  const win = {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: jest.fn(),
    show: jest.fn(),
    focus: jest.fn(),
    close: jest.fn(() => { handlers.closed && handlers.closed(); }),
    removeAllListeners: jest.fn((ev) => { delete handlers[ev]; }),
    on: jest.fn((ev, cb) => { handlers[ev] = cb; }),
    loadURL: jest.fn(),
    setTitle: jest.fn(),
    setFullScreen: jest.fn(),
    isFullScreen: jest.fn(() => false),
    webContents: {
      id: 7,
      getURL: () => 'http://127.0.0.1:8020/',
      send: jest.fn(),
      on: jest.fn(),
      session: { setPermissionRequestHandler: jest.fn() },
      setWindowOpenHandler: jest.fn(),
    },
  };
  return win;
}

describe('electron/localAppWindow', () => {
  it('accepts only loopback http urls', () => {
    expect(isLocalAppUrl('http://127.0.0.1:8020/')).toBe(true);
    expect(isLocalAppUrl('http://localhost:8021/')).toBe(true);
    expect(isLocalAppUrl('https://127.0.0.1:8020/')).toBe(false);
    expect(isLocalAppUrl('http://example.com/')).toBe(false);
    expect(isLocalAppUrl('file:///tmp/x')).toBe(false);
  });

  it('opens a window and rejects non-local urls', () => {
    const BrowserWindow = jest.fn(() => createFakeWindow());
    const ipcMain = { handle: jest.fn() };
    const onClosed = jest.fn();
    const ctrl = createLocalAppWindowController({
      BrowserWindow, ipcMain, getMainWindow: () => null, onClosed,
    });
    expect(ctrl.openWindow({ url: 'http://evil.test/', id: 'digital-human' }).ok).toBe(false);
    const opened = ctrl.openWindow({
      url: 'http://127.0.0.1:8020/', id: 'digital-human', title: '小雅',
    });
    expect(opened).toEqual({ ok: true, id: 'digital-human', url: 'http://127.0.0.1:8020/' });
    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    expect(BrowserWindow.mock.calls[0][0].title).toBe(withTitleHint('小雅'));
  });

  it('user close notifies; silent close does not', () => {
    let win;
    const BrowserWindow = jest.fn(() => { win = createFakeWindow(); return win; });
    const onClosed = jest.fn();
    const ctrl = createLocalAppWindowController({
      BrowserWindow, ipcMain: { handle: jest.fn() }, getMainWindow: () => null, onClosed,
    });
    ctrl.openWindow({ url: 'http://127.0.0.1:8020/', id: 'digital-human' });
    win.on.mock.calls.find(([name]) => name === 'closed')[1]();
    expect(onClosed).toHaveBeenCalledWith({
      id: 'digital-human', url: 'http://127.0.0.1:8020/', title: '小雅',
    });
    onClosed.mockClear();
    ctrl.openWindow({ url: 'http://127.0.0.1:8020/', id: 'digital-human' });
    ctrl.closeWindow({ silent: true });
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('appends fullscreen hint and toggles F11 / ESC', () => {
    expect(withTitleHint('数字人')).toBe('数字人  按F11全屏 ESC退出全屏');
    const win = { isDestroyed: () => false, isFullScreen: jest.fn(() => false), setFullScreen: jest.fn() };
    expect(handleLocalAppHotkey(win, { type: 'keyDown', key: 'F11' })).toBe(true);
    expect(win.setFullScreen).toHaveBeenCalledWith(true);
    win.isFullScreen.mockReturnValue(true);
    expect(handleLocalAppHotkey(win, { type: 'keyDown', key: 'Escape' })).toBe(true);
    expect(win.setFullScreen).toHaveBeenCalledWith(false);
  });
});
