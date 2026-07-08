const { ipcRenderer } = require('electron');

const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:3000';

window.updateApi = {
  getSettings: () => ipcRenderer.invoke('update:get-settings'),
  setSettings: (settings) => ipcRenderer.invoke('update:set-settings', settings),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
};

window.pluginApi = {
  getRuntimeInfo: (pluginId) => ipcRenderer.invoke('plugin:get-runtime-info', pluginId),
  stopCurrent: () => ipcRenderer.invoke('plugin:stop-current'),
};

window.browserDeviceApi = {
  getGrantStatus: () => ipcRenderer.invoke('browser-device:get-grant-status'),
  getGrantStatusForWebview: (webContentsId) => ipcRenderer.invoke('browser-device:get-grant-status-for-webview', webContentsId),
  revokeAccess: () => ipcRenderer.invoke('browser-device:revoke-access'),
  revokeAccessForWebview: (webContentsId) => ipcRenderer.invoke('browser-device:revoke-access-for-webview', webContentsId),
  stopOrigin: () => ipcRenderer.invoke('browser-device:stop-origin'),
  stopOriginForWebview: (webContentsId) => ipcRenderer.invoke('browser-device:stop-origin-for-webview', webContentsId),
};

// 重写 fetch，将相对路径 /api/* 指向本机后端
const origFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  if (typeof input === 'string' && input.startsWith('/api/')) {
    return origFetch(`${BACKEND_URL}${input}`, init);
  }
  return origFetch(input, init);
};

// 重写 EventSource（SSE）到本机后端
const OrigEventSource = window.EventSource;
window.EventSource = function(url, config) {
  const full = (typeof url === 'string' && url.startsWith('/api/'))
    ? `${BACKEND_URL}${url}`
    : url;
  return new OrigEventSource(full, config);
};
