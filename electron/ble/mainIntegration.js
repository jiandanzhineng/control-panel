function createBleMainIntegration({ ipcMain, getDeviceService, logger = console }) {
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
    const error = new Error(result?.error || 'BLE command failed');
    error.code = result?.code || 'BLE_COMMAND_FAILED';
    pending.reject(error);
  }

  function sendCommand(sender, deviceId, message, { timeoutMs = 8000 } = {}) {
    if (sender.isDestroyed()) {
      return Promise.reject(new Error(`BLE renderer is unavailable: ${deviceId}`));
    }
    const requestId = `ble-command-${Date.now()}-${++commandRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finishCommandRequest(requestId, {
          ok: false,
          code: 'BLE_COMMAND_TIMEOUT',
          error: 'BLE command execution timed out',
        });
      }, timeoutMs);
      commandRequests.set(requestId, {
        ownerId: sender.id,
        deviceId,
        resolve,
        reject,
        timer,
      });
      sender.send('ble:command', { id: deviceId, message, requestId });
    });
  }

  function registerHandlers() {
    if (handlersRegistered) return;
    handlersRegistered = true;

    ipcMain.handle('ble:select-device', (event, deviceId) => {
      const selection = selectionFor(event.sender);
      if (!selection || !selection.candidates.has(deviceId)) {
        const error = new Error('BLE device is not an active scan candidate');
        error.code = 'BLE_DEVICE_NOT_AVAILABLE';
        throw error;
      }
      selection.callback(deviceId);
      selections.delete(event.sender.id);
      return { ok: true };
    });

    ipcMain.handle('ble:cancel-selection', (event) => {
      const selection = selectionFor(event.sender);
      if (selection) selection.callback('');
      selections.delete(event.sender.id);
      return { ok: true };
    });

    ipcMain.handle('ble:connected', (event, metadata) => {
      if (!metadata?.id || metadata.connectionType !== 'ble') {
        throw new TypeError('Invalid BLE device metadata');
      }
      const sender = event.sender;
      deviceOwners.set(metadata.id, sender.id);
      return getDeviceService().connectTransportDevice(metadata, {
        kind: 'ble',
        send(message) {
          return sendCommand(sender, metadata.id, message);
        },
      });
    });

    ipcMain.on('ble:property', (event, payload) => {
      if (!payload?.id || !payload?.key || !isOwner(event.sender, payload.id)) return;
      getDeviceService().handleTransportProperty(
        payload.id,
        payload.key,
        payload.value,
        'ble',
      );
    });

    ipcMain.on('ble:message', (event, payload) => {
      if (!payload?.id || !payload?.message || !isOwner(event.sender, payload.id)) return;
      getDeviceService().handleTransportMessage(payload.id, payload.message, 'ble');
    });

    ipcMain.on('ble:disconnected', (event, payload) => {
      if (!payload?.id || !isOwner(event.sender, payload.id)) return;
      deviceOwners.delete(payload.id);
      getDeviceService().disconnectTransportDevice(payload.id, 'ble');
    });

    ipcMain.on('ble:command-error', (event, payload) => {
      if (!payload?.id || !isOwner(event.sender, payload.id)) return;
      if (payload.requestId) finishCommandRequest(payload.requestId, {
        ok: false,
        code: payload.code,
        error: payload.error,
      });
      logger.warn?.('[electron] BLE command failed', payload);
    });

    ipcMain.on('ble:command-result', (event, payload) => {
      const pending = commandRequests.get(payload?.requestId);
      if (!pending || pending.ownerId !== event.sender.id
          || pending.deviceId !== payload?.id) return;
      if (payload.ok !== true) logger.warn?.('[electron] BLE command failed', payload);
      finishCommandRequest(payload.requestId, payload);
    });

    ipcMain.on('ble:disconnect-all-complete', (event, payload) => {
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

    const requestId = `ble-disconnect-${Date.now()}-${++disconnectRequestSequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        finishDisconnectRequest(requestId, { ok: false, timedOut: true });
      }, timeoutMs);
      disconnectRequests.set(requestId, { ownerId: contents.id, resolve, timer });
      contents.send('ble:disconnect-all', { requestId });
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

      for (const device of devices || []) {
        const name = String(device.deviceName || '');
        if (!name.toUpperCase().includes('BLUFI')) continue;
        selection.candidates.set(device.deviceId, {
          id: device.deviceId,
          name: name || 'BLUFI',
        });
      }
      contents.send('ble:scan-results', [...selection.candidates.values()]);
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
            code: 'BLE_RENDERER_DESTROYED',
            error: 'BLE renderer was destroyed',
          });
        }
      }
      for (const [deviceId, ownerId] of [...deviceOwners.entries()]) {
        if (ownerId !== contents.id) continue;
        deviceOwners.delete(deviceId);
        getDeviceService().disconnectTransportDevice(deviceId, 'ble');
      }
    });
  }

  return { registerHandlers, attachWindow, requestDisconnectAll };
}

module.exports = { createBleMainIntegration };
