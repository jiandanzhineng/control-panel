const deviceConnections = require('./deviceConnectionService');
const logService = require('./logService');
const manifestService = require('./firmwareManifestService');

const {
  createServiceError,
  fetchLatestManifest,
  toFirmwareInfo,
  findAppFirmware,
  isUpdateAvailable,
  compareVersions,
} = manifestService;

const otaStatusMap = new Map();
const statusHandlers = new Map();

async function getLatestFirmwareForDevice(device) {
  const manifest = await fetchLatestManifest();
  return getLatestFirmwareFromManifest(device, manifest);
}

async function getLatestFirmwareForDevices(devices = []) {
  const manifest = await fetchLatestManifest();
  return devices.map((device) => getLatestFirmwareFromManifest(device, manifest));
}

function getLatestFirmwareFromManifest(device, manifest) {
  const currentVersion = getCurrentVersion(device);
  const firmwareEntry = findAppFirmware(manifest, device.type);
  const firmware = toFirmwareInfo(firmwareEntry);
  const latestVersion = manifest.latest_version || null;

  return {
    supported: !!firmware,
    currentVersion,
    latestVersion,
    updateAvailable: !!firmware && isUpdateAvailable(currentVersion, latestVersion),
    manifestGeneratedAt: manifest.generated_at || null,
    commit: manifest.commit || null,
    firmware,
  };
}

function getCurrentVersion(device) {
  const value = device?.data?.ver;
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

async function updateDeviceToLatest(device, options = {}) {
  if (!device.connected) {
    throw createServiceError('DEVICE_OFFLINE', '设备离线，无法下发 OTA 指令', 409);
  }

  const manifest = await fetchLatestManifest();
  return updateDeviceToLatestFromManifest(device, manifest, options);
}

async function updateDevicesToLatest(devices = [], options = {}) {
  const manifest = await fetchLatestManifest();
  const results = devices.map((device) => {
    try {
      const result = updateDeviceToLatestFromManifest(device, manifest, options);
      return {
        deviceId: device.id,
        ok: true,
        skipped: false,
        failed: false,
        status: result.status,
        firmware: result.firmware,
        topic: result.topic,
        message: result.message,
      };
    } catch (error) {
      return {
        deviceId: device.id,
        ok: false,
        skipped: isSkippableUpdateError(error),
        failed: !isSkippableUpdateError(error),
        error: {
          code: error.code || 'FIRMWARE_UPDATE_FAILED',
          message: error.message || String(error),
          status: error.status || 500,
        },
      };
    }
  });

  return {
    ok: true,
    requestedCount: results.filter((item) => item.ok).length,
    skippedCount: results.filter((item) => item.skipped).length,
    failedCount: results.filter((item) => item.failed).length,
    results,
  };
}

async function blinkLatestDevices(devices = [], publisher) {
  const manifest = await fetchLatestManifest();
  const results = devices.map((device) => {
    const latest = getLatestFirmwareFromManifest(device, manifest);

    if (!device.connected) {
      return makeBlinkSkippedResult(device.id, 'DEVICE_OFFLINE', '设备离线，无法下发指示灯闪烁');
    }
    if (!latest.supported) {
      return makeBlinkSkippedResult(device.id, 'FIRMWARE_NOT_SUPPORTED', `设备类型 ${device.type} 暂无 OTA 应用固件`);
    }
    if (!latest.currentVersion) {
      return makeBlinkSkippedResult(device.id, 'FIRMWARE_VERSION_UNKNOWN', '当前固件版本未知，无法确认是否最新');
    }
    if (latest.updateAvailable) {
      return makeBlinkSkippedResult(device.id, 'FIRMWARE_UPDATE_AVAILABLE', '当前设备不是最新固件版本');
    }

    try {
      const publishResult = publisher(device.id, 'blink');
      return {
        deviceId: device.id,
        ok: true,
        skipped: false,
        failed: false,
        firmware: latest,
        topic: publishResult?.topic || `/drecv/${device.id}`,
        message: publishResult?.message || { method: 'action', action: 'blink' },
      };
    } catch (error) {
      return {
        deviceId: device.id,
        ok: false,
        skipped: false,
        failed: true,
        firmware: latest,
        error: {
          code: 'DEVICE_ACTION_PUBLISH_FAILED',
          message: error?.message || '指示灯闪烁指令下发失败',
          status: 500,
        },
      };
    }
  });

  return {
    ok: true,
    requestedCount: results.filter((item) => item.ok).length,
    skippedCount: results.filter((item) => item.skipped).length,
    failedCount: results.filter((item) => item.failed).length,
    results,
  };
}

function makeBlinkSkippedResult(deviceId, code, message) {
  return {
    deviceId,
    ok: false,
    skipped: true,
    failed: false,
    error: {
      code,
      message,
      status: 409,
    },
  };
}

function updateDeviceToLatestFromManifest(device, manifest, options = {}) {
  if (!device.connected) {
    throw createServiceError('DEVICE_OFFLINE', '设备离线，无法下发 OTA 指令', 409);
  }
  const controlConnection = deviceConnections.getDeviceConnections(device.id).controlConnection
    || device.controlConnection
    || device.connectionType;
  if (controlConnection === 'ble') {
    throw createServiceError(
      'FIRMWARE_TRANSPORT_UNSUPPORTED',
      'BLE 模式下 WiFi 已停止，无法执行网络 OTA',
      409,
    );
  }

  const latest = getLatestFirmwareFromManifest(device, manifest);
  if (!latest.supported || !latest.firmware) {
    throw createServiceError('FIRMWARE_NOT_SUPPORTED', `设备类型 ${device.type} 暂无 OTA 应用固件`, 404);
  }

  if (!options.force && latest.currentVersion && !latest.updateAvailable) {
    throw createServiceError('ALREADY_LATEST', '当前设备已是最新固件版本', 409);
  }

  const message = {
    method: 'ota_update',
    url: latest.firmware.url,
  };

  try {
    deviceConnections.send(device.id, message);
  } catch (error) {
    throw createServiceError('OTA_PUBLISH_FAILED', error?.message || 'OTA 指令下发失败', 500);
  }

  const status = recordOtaStatus(device.id, {
    status: 'requested',
    progress: 0,
    msg: 'OTA 指令已下发',
  }, {
    firmwareVersion: latest.latestVersion,
    filename: latest.firmware.filename,
    url: latest.firmware.url,
  });

  return {
    ok: true,
    ...(controlConnection === 'mqtt' ? { topic: `/drecv/${device.id}` } : {}),
    connectionType: controlConnection,
    message,
    firmware: latest.firmware,
    status,
  };
}

function isSkippableUpdateError(error) {
  return [
    'DEVICE_OFFLINE',
    'FIRMWARE_NOT_SUPPORTED',
    'FIRMWARE_TRANSPORT_UNSUPPORTED',
    'ALREADY_LATEST',
  ].includes(error?.code);
}

function recordOtaStatus(deviceId, payload = {}, context = {}) {
  const previous = otaStatusMap.get(deviceId) || {};
  const status = normalizeStatus(payload.status);
  const progress = normalizeProgress(payload.progress, status);

  const next = {
    deviceId,
    status,
    progress,
    msg: typeof payload.msg === 'string' ? payload.msg : '',
    updatedAt: new Date().toISOString(),
    firmwareVersion: context.firmwareVersion || previous.firmwareVersion || null,
    filename: context.filename || previous.filename || null,
    url: context.url || previous.url || null,
  };

  otaStatusMap.set(deviceId, next);
  emitOtaStatus(deviceId, next);
  return next;
}

function normalizeStatus(value) {
  const status = typeof value === 'string' ? value : '';
  if (['requested', 'start', 'downloading', 'success', 'failed'].includes(status)) return status;
  return status || 'unknown';
}

function normalizeProgress(value, status) {
  if (status === 'success') return 100;
  if (status === 'start' || status === 'requested') return 0;

  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function getOtaStatus(deviceId) {
  return otaStatusMap.get(deviceId) || {
    deviceId,
    status: 'idle',
    progress: null,
    msg: '暂无升级任务',
    updatedAt: null,
    firmwareVersion: null,
    filename: null,
    url: null,
  };
}

function onOtaStatus(deviceId, handler) {
  if (!statusHandlers.has(deviceId)) statusHandlers.set(deviceId, new Set());
  const handlers = statusHandlers.get(deviceId);
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) statusHandlers.delete(deviceId);
  };
}

function emitOtaStatus(deviceId, status) {
  const handlers = statusHandlers.get(deviceId);
  if (!handlers) return;
  for (const handler of handlers) {
    try {
      handler(status);
    } catch (error) {
      logService.warn('FirmwareOTA', `OTA 状态推送失败: ${error?.message || error}`);
    }
  }
}

function setManifestFetcher(fetcher) {
  manifestService.setManifestFetcher(fetcher);
}

function resetForTests() {
  otaStatusMap.clear();
  statusHandlers.clear();
  manifestService.resetForTests();
}

module.exports = {
  getLatestFirmwareForDevice,
  getLatestFirmwareForDevices,
  updateDeviceToLatest,
  updateDevicesToLatest,
  blinkLatestDevices,
  recordOtaStatus,
  getOtaStatus,
  onOtaStatus,
  isUpdateAvailable,
  compareVersions,
  setManifestFetcher,
  resetForTests,
};
