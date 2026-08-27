/**
 * 主进程侧 DG-LAB V2（Web Bluetooth 直连）IPC 集成。
 * 结构与既有 BleMainIntegration（BLUFI）对齐，但通道前缀改为 brandBle:*，
 * 且 select-bluetooth-device 接纳郊狼 V2 与役次元（FJB/YCY 等）广播名。
 *
 * 设备注册复用既有 deviceService.connectTransportDevice，与 BLUFI 共用同一
 * deviceService 实例（Electron 主进程与后端同进程、同 require 缓存）。
 * 控制指令经 brandService.attachWebBle 注入的 send 闭包，由主进程经 IPC 转发到
 * 渲染进程 GATT 写队列。
 */
const { DGLAB_V2_NAMES } = require('../../backend/brands/protocols/dglabV2');

function createBrandBleMainIntegration({ ipcMain, getDeviceService, getBrandService, logger = console }) {
  const selections = new Map();
  const deviceOwners = new Map();
  const commandRequests = new Map();
  const disconnectRequests = new Map();
  let commandRequestSequence = 0;
  let disconnectRequestSequence = 0;
  let handlersRegistered = false;

  function selectionFor(sender) {
    return selections.get(sender.id);
  }

  function isOwner(sender, deviceId) {
    return deviceOwners.get(deviceId) === sender.id;
  }

  const YCY_NAMES = ['YCY', 'YYC', 'YOKO', 'YOKONEX', 'YISK', 'DJ-V2', 'FJB', 'ENEMA', 'GLJ', 'DJ'];
  function isBrandName(name) {
    const n = String(name || '').toUpperCase();
    return DGLAB_V2_NAMES.some((k) => n.includes(k.toUpperCase()))
      || n.includes('47L')
      || YCY_NAMES.some((k) => n.includes(k.toUpperCase()));
  }

  function finishDisconnectRequest(requestId, result) {
    const pending = disconnectRequests.get(requestId);
    if (!pending) return;
    disconnectRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  function finishCommandRequest(requestId, result) {
    const pending = commandRequests.get(requestId);
    if (!pending) return;
    commandRequests.delete(requestId);
    clearTimeout(pending.timer);
    if (result?.ok === true) {
      pending.resolve({ ok: true });
      return;
    }
    const error = new Error(result?.error || 'Brand BLE command failed');
    error.code = result?.code || 'BRAND_BLE_COMMAND_FAILED';
    pending.reject(error);
  }

  function sendCommand(sender, deviceId, message, { timeoutMs = 8000 } = {}) {
    if (sender.isDestroyed()) {
      return Promise.reject(new Error(`Brand BLE renderer is unavailable: ${deviceId}`));
    }
    const requestId = `brandBle-command-${Date.now()}-${++commandRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finishCommandRequest(requestId, {
          ok: false,
          code: 'BRAND_BLE_COMMAND_TIMEOUT',
          error: 'Brand BLE command execution timed out',
        });
      }, timeoutMs);
      commandRequests.set(requestId, {
        ownerId: sender.id,
        deviceId,
        resolve,
        reject,
        timer,
      });
      sender.send('brandBle:command', { id: deviceId, message, requestId });
    });
  }

  function registerHandlers() {
    if (handlersRegistered) return;
    handlersRegistered = true;

    ipcMain.handle('brandBle:select-device', (event, deviceId) => {
      const selection = selectionFor(event.sender);
      if (!selection || !selection.candidates.has(deviceId)) {
        const error = new Error('Brand BLE device is not an active scan candidate');
        error.code = 'BRAND_BLE_DEVICE_NOT_AVAILABLE';
        throw error;
      }
      selection.callback(deviceId);
      selections.delete(event.sender.id);
      return { ok: true };
    });

    ipcMain.handle('brandBle:cancel-selection', (event) => {
      const selection = selectionFor(event.sender);
      if (selection) selection.callback('');
      selections.delete(event.sender.id);
      return { ok: true };
    });

    ipcMain.handle('brandBle:begin-auto-select', (event) => {
      const brandService = getBrandService();
      const settings = brandService.getSettings?.() || { autoConnect: true, autoConnectAll: true };
      const saved = brandService.listSavedBleDevices?.() || [];
      const skipNames = saved
        .filter((d) => d.connected && d.name)
        .map((d) => String(d.name).trim().toUpperCase());
      const pending = saved
        .filter((d) => !d.connected && d.name && !skipNames.includes(String(d.name).trim().toUpperCase()))
        .map((d) => d.name);
      const existing = selectionFor(event.sender) || { callback: null, candidates: new Map() };
      existing.autoSelectAll = settings.autoConnectAll !== false;
      existing.autoSelect = existing.autoSelectAll || settings.autoConnect !== false;
      existing.autoNames = settings.autoConnect !== false ? pending : [];
      existing.skipNames = skipNames;
      selections.set(event.sender.id, existing);
      return { ok: true, names: existing.autoNames, all: existing.autoSelectAll };
    });

    ipcMain.handle('brandBle:connected', (event, metadata) => {
      if (!metadata?.id || metadata.connectionType !== 'brandBle') {
        throw new TypeError('Invalid brand BLE device metadata');
      }
      const sender = event.sender;
      deviceOwners.set(metadata.id, sender.id);
      const send = (message) => sendCommand(sender, metadata.id, message);
      const brandService = getBrandService();
      return brandService.attachWebBle(metadata, send);
    });

    ipcMain.on('brandBle:property', (event, payload) => {
      if (!payload?.id || !payload?.key || !isOwner(event.sender, payload.id)) return;
      getDeviceService().handleTransportProperty(payload.id, payload.key, payload.value, 'brandBle');
    });

    ipcMain.on('brandBle:message', (event, payload) => {
      if (!payload?.id || !payload?.message || !isOwner(event.sender, payload.id)) return;
      getDeviceService().handleTransportMessage(payload.id, payload.message, 'brandBle');
    });

    ipcMain.on('brandBle:disconnected', (event, payload) => {
      if (!payload?.id || !isOwner(event.sender, payload.id)) return;
      deviceOwners.delete(payload.id);
      const brandService = getBrandService();
      // 让 brandService 先发停止帧；其异步清理完成后再移除 transport。
      try { brandService.detachWebBle(payload.id); } catch (_) {}
      getDeviceService().disconnectTransportDevice(payload.id, 'brandBle');
    });

    ipcMain.on('brandBle:command-error', (event, payload) => {
      if (!payload?.id || !isOwner(event.sender, payload.id)) return;
      if (payload.requestId) finishCommandRequest(payload.requestId, {
        ok: false,
        code: payload.code,
        error: payload.error,
      });
      logger.warn?.('[electron] Brand BLE command failed', payload);
    });

    ipcMain.on('brandBle:command-result', (event, payload) => {
      const pending = commandRequests.get(payload?.requestId);
      if (!pending || pending.ownerId !== event.sender.id
          || pending.deviceId !== payload?.id) return;
      if (payload.ok !== true) logger.warn?.('[electron] Brand BLE command failed', payload);
      finishCommandRequest(payload.requestId, payload);
    });

    ipcMain.on('brandBle:disconnect-all-complete', (event, payload) => {
      const pending = disconnectRequests.get(payload?.requestId);
      if (!pending || pending.ownerId !== event.sender.id) return;
      finishDisconnectRequest(payload.requestId, { ok: payload.ok === true });
    });
  }

  function requestDisconnectAll(window, { timeoutMs = 3000 } = {}) {
    const contents = window?.webContents;
    if (!contents || contents.isDestroyed()) {
      return Promise.resolve({ ok: true, alreadyDisconnected: true });
    }
    const requestId = `brandBle-disconnect-${Date.now()}-${++disconnectRequestSequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        finishDisconnectRequest(requestId, { ok: false, timedOut: true });
      }, timeoutMs);
      disconnectRequests.set(requestId, { ownerId: contents.id, resolve, timer });
      contents.send('brandBle:disconnect-all', { requestId });
    });
  }

  function attachWindow(window) {
    const contents = window.webContents;
    contents.on('select-bluetooth-device', (event, devices, callback) => {
      event.preventDefault();
      let selection = selections.get(contents.id);
      if (!selection) {
        selection = { callback, candidates: new Map() };
        selections.set(contents.id, selection);
      } else {
        selection.callback = callback;
      }

      if (selection.autoSelect) {
        const wanted = (selection.autoNames || []).map((n) => String(n).trim().toUpperCase()).filter(Boolean);
        const skip = new Set(selection.skipNames || []);
        for (const device of devices || []) {
          const name = String(device.deviceName || '').trim().toUpperCase();
          if (!name || skip.has(name)) continue;
          const matchAll = selection.autoSelectAll && isBrandName(name);
          if (!matchAll && !wanted.includes(name)) continue;
          selections.delete(contents.id);
          callback(device.deviceId);
          return;
        }
        return;
      }

      for (const device of devices || []) {
        const name = String(device.deviceName || '');
        if (!isBrandName(name)) continue;
        selection.candidates.set(device.deviceId, {
          id: device.deviceId,
          name: name || '品牌设备',
        });
      }
      contents.send('brandBle:scan-results', [...selection.candidates.values()]);
    });

    contents.on('destroyed', () => {
      const selection = selections.get(contents.id);
      if (selection) selection.callback('');
      selections.delete(contents.id);
      for (const [requestId, pending] of [...disconnectRequests.entries()]) {
        if (pending.ownerId === contents.id) {
          finishDisconnectRequest(requestId, { ok: false, rendererDestroyed: true });
        }
      }
      for (const [requestId, pending] of [...commandRequests.entries()]) {
        if (pending.ownerId === contents.id) {
          finishCommandRequest(requestId, {
            ok: false,
            code: 'BRAND_BLE_RENDERER_DESTROYED',
            error: 'Brand BLE renderer was destroyed',
          });
        }
      }
      for (const [deviceId, ownerId] of [...deviceOwners.entries()]) {
        if (ownerId !== contents.id) continue;
        deviceOwners.delete(deviceId);
        const brandService = getBrandService();
        try { brandService.detachWebBle(deviceId); } catch (_) {}
        getDeviceService().disconnectTransportDevice(deviceId, 'brandBle');
      }
    });
  }

  return { registerHandlers, attachWindow, requestDisconnectAll };
}

module.exports = { createBrandBleMainIntegration };
