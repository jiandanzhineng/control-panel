const { ipcRenderer } = require('electron');
const { BleDeviceClient } = require('./ble/deviceClient');
const { BLE_UUIDS } = require('./ble/protocol');
const { BlufiProvisionClient } = require('./blufi/provisionClient');

const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:3000';
const bleClients = new Map();

function emitBleClientEvent(event, payload) {
  if (event === 'property') {
    ipcRenderer.send('ble:property', payload);
  } else if (event === 'message') {
    ipcRenderer.send('ble:message', payload);
  } else if (event === 'disconnected') {
    bleClients.delete(payload.id);
    ipcRenderer.send('ble:disconnected', payload);
  } else if (event === 'error') {
    ipcRenderer.send('ble:command-error', payload);
  }
}

async function disconnectAllBleClients() {
  await Promise.allSettled([...bleClients.values()].map((client) => client.disconnect()));
  bleClients.clear();
  return { ok: true };
}

ipcRenderer.on('ble:command', async (_event, request) => {
  const client = bleClients.get(request?.id);
  if (!client) {
    ipcRenderer.send('ble:command-result', {
      id: request?.id,
      requestId: request?.requestId,
      ok: false,
      code: 'BLE_DEVICE_NOT_CONNECTED',
      error: 'BLE device is not connected',
    });
    return;
  }
  try {
    await client.send(request.message);
    ipcRenderer.send('ble:command-result', {
      id: request.id,
      requestId: request.requestId,
      ok: true,
    });
  } catch (error) {
    ipcRenderer.send('ble:command-result', {
      id: request.id,
      requestId: request.requestId,
      ok: false,
      code: error?.code || 'BLE_COMMAND_FAILED',
      error: error?.message || String(error),
      message: request.message,
    });
  }
});

ipcRenderer.on('ble:disconnect-all', async (_event, request) => {
  let ok = false;
  try {
    const result = await disconnectAllBleClients();
    ok = result.ok;
  } finally {
    ipcRenderer.send('ble:disconnect-all-complete', {
      requestId: request?.requestId,
      ok,
    });
  }
});

window.bleApi = {
  isSupported: () => !!navigator.bluetooth?.requestDevice,
  connect: async () => {
    if (!navigator.bluetooth?.requestDevice) {
      const error = new Error('This PC does not support Web Bluetooth');
      error.code = 'BLE_NOT_SUPPORTED';
      throw error;
    }
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BLUFI' }],
      optionalServices: [BLE_UUIDS.service],
    });
    const client = new BleDeviceClient(device, { onEvent: emitBleClientEvent });
    try {
      const metadata = await client.connect();
      bleClients.set(metadata.id, client);
      await ipcRenderer.invoke('ble:connected', metadata);
      return metadata;
    } catch (error) {
      bleClients.delete(client.id);
      try { await client.disconnect(); } catch (_) {}
      throw error;
    }
  },
  disconnect: async (id) => {
    const client = bleClients.get(id);
    if (!client) return { ok: true, alreadyDisconnected: true };
    await client.disconnect();
    bleClients.delete(id);
    return { ok: true };
  },
  disconnectAll: disconnectAllBleClients,
  connectedDeviceIds: () => [...bleClients.keys()],
  selectDevice: (deviceId) => ipcRenderer.invoke('ble:select-device', deviceId),
  cancelSelection: () => ipcRenderer.invoke('ble:cancel-selection'),
  onScanResults: (callback) => {
    const listener = (_event, devices) => {
      try { callback(devices); } catch (_) {}
    };
    ipcRenderer.on('ble:scan-results', listener);
    return () => ipcRenderer.removeListener('ble:scan-results', listener);
  },
};

window.provisionApi = {
  isSupported: () => !!navigator.bluetooth?.requestDevice,
  provision: (credentials, onStatus) => {
    const client = new BlufiProvisionClient({
      bluetooth: navigator.bluetooth,
      onStatus,
    });
    return client.provision(credentials);
  },
  selectDevice: (deviceId) => ipcRenderer.invoke('ble:select-device', deviceId),
  cancelSelection: () => ipcRenderer.invoke('ble:cancel-selection'),
  onScanResults: (callback) => {
    const listener = (_event, devices) => {
      try { callback(devices); } catch (_) {}
    };
    ipcRenderer.on('ble:scan-results', listener);
    return () => ipcRenderer.removeListener('ble:scan-results', listener);
  },
};

window.updateApi = {
  getSettings: () => ipcRenderer.invoke('update:get-settings'),
  setSettings: (settings) => ipcRenderer.invoke('update:set-settings', settings),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
};

window.pluginApi = {
  getRuntimeInfo: (pluginId) => ipcRenderer.invoke('plugin:get-runtime-info', pluginId),
  stopCurrent: () => ipcRenderer.invoke('plugin:stop-current'),
};

window.localAppWindowApi = {
  open: (payload) => ipcRenderer.invoke('local-app:open-window', payload),
  close: () => ipcRenderer.invoke('local-app:close-window'),
  focus: () => ipcRenderer.invoke('local-app:focus-window'),
  onClosed: (cb) => {
    const listener = (_event, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('local-app:window-closed', listener);
    return () => ipcRenderer.removeListener('local-app:window-closed', listener);
  },
};

window.browserDeviceApi = {
  getGrantStatus: () => ipcRenderer.invoke('browser-device:get-grant-status'),
  getGrantStatusForWebview: (webContentsId) => ipcRenderer.invoke('browser-device:get-grant-status-for-webview', webContentsId),
  revokeAccess: () => ipcRenderer.invoke('browser-device:revoke-access'),
  revokeAccessForWebview: (webContentsId) => ipcRenderer.invoke('browser-device:revoke-access-for-webview', webContentsId),
  stopOrigin: () => ipcRenderer.invoke('browser-device:stop-origin'),
  stopOriginForWebview: (webContentsId) => ipcRenderer.invoke('browser-device:stop-origin-for-webview', webContentsId),
};

// GameHost 启动导航：主进程在 launch 时 send('game-host:navigate', { path })，
// 前端（App.vue）监听后 router.push 到原生配置页。
window.gameHostNav = {
  onNavigate: (cb) => {
    const listener = (_event, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('game-host:navigate', listener);
    return () => ipcRenderer.removeListener('game-host:navigate', listener);
  },
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
