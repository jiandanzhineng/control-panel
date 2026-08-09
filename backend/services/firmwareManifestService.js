const logService = require('./logService');

// 固件清单共用逻辑(从 firmwareOtaService 抽取,供 WiFi OTA 与插线烧录共用)。
// 清单地址: FIRMWARE_BASE_URL/firmware/latest/version.json
// 条目结构: { device, kind: 'app'|'merged', filename, object_key, size_bytes, sha256 }
const FIRMWARE_BASE_URL = (process.env.FIRMWARE_BASE_URL || 'http://firmware.undersilicon.cn').replace(/\/+$/, '');
const MANIFEST_URL = `${FIRMWARE_BASE_URL}/firmware/latest/version.json`;

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
    logService.warn('FirmwareManifest', `固件清单获取失败: ${error?.message || error}`);
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

function findFirmware(manifest, deviceType, kind) {
  return manifest.firmwares.find((item) => (
    item
    && item.device === deviceType
    && item.kind === kind
    && item.object_key
  ));
}

function findAppFirmware(manifest, deviceType) {
  return findFirmware(manifest, deviceType, 'app');
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

function setManifestFetcher(fetcher) {
  manifestFetcher = fetcher || defaultManifestFetcher;
}

function resetForTests() {
  manifestFetcher = defaultManifestFetcher;
}

module.exports = {
  FIRMWARE_BASE_URL,
  MANIFEST_URL,
  createServiceError,
  defaultManifestFetcher,
  fetchLatestManifest,
  validateManifest,
  toFirmwareInfo,
  findFirmware,
  findAppFirmware,
  isUpdateAvailable,
  compareVersions,
  setManifestFetcher,
  resetForTests,
};
