const { contextBridge, ipcRenderer } = require('electron');

function unwrap(response) {
  if (!response || response.ok !== true) {
    const error = new Error(response?.error || 'DeviceAPI call failed');
    error.code = response?.code || 'DEVICE_API_ERROR';
    error.origin = response?.origin;
    throw error;
  }
  return response;
}

async function requestAccess() {
  return unwrap(await ipcRenderer.invoke('browser-device:request-access'));
}

async function getGrantStatus() {
  return unwrap(await ipcRenderer.invoke('browser-device:get-grant-status'));
}

async function revokeAccess() {
  return unwrap(await ipcRenderer.invoke('browser-device:revoke-access'));
}

async function stop() {
  return unwrap(await ipcRenderer.invoke('browser-device:stop-origin'));
}

async function command(action, payload) {
  const response = unwrap(await ipcRenderer.invoke('browser-device:command', action, payload || {}));
  return response.result;
}

function device(deviceId) {
  return {
    invoke(capability, actionName, params) {
      return command('invoke', { deviceId, capability, actionName, params: params || {} });
    },
    operate(operationKey, params) {
      return command('operate', { deviceId, operationKey, params: params || {} });
    },
    writeProps(props) {
      return command('writeProps', { deviceId, props: props || {} });
    },
    sendMessage(msg) {
      return command('sendMessage', { deviceId, msg });
    },
    read(property) {
      return command('read', { deviceId, property });
    },
    async isMapped() {
      const map = await command('getDeviceMap', {});
      const ids = map?.[deviceId];
      return Array.isArray(ids) ? ids.length > 0 : !!ids;
    },
  };
}

contextBridge.exposeInMainWorld('DeviceAPI', {
  requestAccess,
  getGrantStatus,
  revokeAccess,
  stop,
  device,
  getDevices: () => command('getDevices', {}),
  getDeviceMap: () => command('getDeviceMap', {}),
  params: {},
});

// GameHost：与 DeviceAPI 分离的跨端统一游戏启动契约。
// 仅转发到主进程，所有 origin / v / gameId 校验都在主进程按宿主侧记录的
// origin 完成——不信任网页传入内容。
async function gameHostInvoke(channel, req) {
  return unwrap(await ipcRenderer.invoke(channel, req));
}

contextBridge.exposeInMainWorld('GameHost', {
  cache: (req) => gameHostInvoke('game-host:cache', req),
  launch: (req) => gameHostInvoke('game-host:launch', req),
});
