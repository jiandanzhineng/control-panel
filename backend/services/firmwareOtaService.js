const mqttClient = require('./mqttClientService');
const logService = require('./logService');

const FIRMWARE_BASE_URL = (process.env.FIRMWARE_BASE_URL || 'https://firmware.undersilicon.cn').replace(/\/+$/, '');
const MANIFEST_URL = `${FIRMWARE_BASE_URL}/firmware/latest/version.json`;

const otaStatusMap = new Map();
const statusHandlers = new Map();

let manifestFetcher = defaultManifestFetcher;

function createServiceError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function defaultManifestFetcher(url) {
  if (typeof fetch !== 'function') {
    throw createServiceError('FIRMWARE_MANIFEST_FAILED', '当前 Node.js 运行环境不支持 fetch', 500);
  }

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    },
  });

  if (!res.ok) {
    throw createServiceError('FIRMWARE_MANIFEST_FAILED', `固件清单请求失败: HTTP ${res.status}`, 502);
  }

  return res.json();
}

async function fetchLatestManifest() {
  const url = `${MANIFEST_URL}?_=${Date.now()}_${Math.random().toString(16).slice(2)}`;

  try {
    const manifest = await manifestFetcher(url);
    validateManifest(manifest);
    return manifest;
  } catch (error) {
    if (error.code === 'FIRMWARE_MANIFEST_FAILED') throw error;
    logService.warn('FirmwareOTA', `固件清单获取失败: ${error?.message || error}`);
    throw createServiceError('FIRMWARE_MANIFEST_FAILED', error?.message || '固件清单获取失败', 502);
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw createServiceError('FIRMWARE_MANIFEST_FAILED', '固件清单格式错误', 502);
  }
  if (!Array.isArray(manifest.firmwares)) {
    throw createServiceError('FIRMWARE_MANIFEST_FAILED', '固件清单缺少 firmwares 列表', 502);
  }
}

function toFirmwareInfo(entry) {
  if (!entry) return null;
  return {
    device: entry.device,
    kind: entry.kind,
    filename: entry.filename,
    objectKey: entry.object_key,
    url: `${FIRMWARE_BASE_URL}/${String(entry.object_key || '').replace(/^\/+/, '')}`,
    sizeBytes: entry.size_bytes,
    sha256: entry.sha256,
  };
}

function findAppFirmware(manifest, deviceType) {
  return manifest.firmwares.find((item) => (
    item
    && item.device === deviceType
    && item.kind === 'app'
    && item.object_key
  ));
}

async function getLatestFirmwareForDevice(device) {
  const manifest = await fetchLatestManifest();
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

function isUpdateAvailable(currentVersion, latestVersion) {
  if (!latestVersion) return false;
  if (!currentVersion) return true;
  const compare = compareVersions(currentVersion, latestVersion);
  return compare < 0;
}

function compareVersions(a, b) {
  const left = tokenizeVersion(a);
  const right = tokenizeVersion(b);
  const len = Math.max(left.length, right.length);

  for (let i = 0; i < len; i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x === y) continue;

    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
  }

  return 0;
}

function tokenizeVersion(value) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

async function updateDeviceToLatest(device, options = {}) {
  if (!device.connected) {
    throw createServiceError('DEVICE_OFFLINE', '设备离线，无法下发 OTA 指令', 409);
  }

  const latest = await getLatestFirmwareForDevice(device);
  if (!latest.supported || !latest.firmware) {
    throw createServiceError('FIRMWARE_NOT_SUPPORTED', `设备类型 ${device.type} 暂无 OTA 应用固件`, 404);
  }

  if (!options.force && latest.currentVersion && !latest.updateAvailable) {
    throw createServiceError('ALREADY_LATEST', '当前设备已是最新固件版本', 409);
  }

  const topic = `/drecv/${device.id}`;
  const message = {
    method: 'ota_update',
    url: latest.firmware.url,
  };

  try {
    mqttClient.publish(topic, message);
  } catch (error) {
    throw createServiceError('OTA_MQTT_PUBLISH_FAILED', error?.message || 'OTA 指令下发失败', 500);
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
    topic,
    message,
    firmware: latest.firmware,
    status,
  };
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
  manifestFetcher = fetcher || defaultManifestFetcher;
}

function resetForTests() {
  otaStatusMap.clear();
  statusHandlers.clear();
  manifestFetcher = defaultManifestFetcher;
}

module.exports = {
  getLatestFirmwareForDevice,
  updateDeviceToLatest,
  recordOtaStatus,
  getOtaStatus,
  onOtaStatus,
  isUpdateAvailable,
  compareVersions,
  setManifestFetcher,
  resetForTests,
};
