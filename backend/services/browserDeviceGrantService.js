const fs = require('fs');
const path = require('path');

function getGrantFilePath() {
  if (process.env.BROWSER_DEVICE_GRANTS_PATH) {
    return path.resolve(process.env.BROWSER_DEVICE_GRANTS_PATH);
  }
  if (process.env.BACKEND_DATA_DIR) {
    return path.join(path.resolve(process.env.BACKEND_DATA_DIR), 'browser-device-grants.json');
  }
  return path.join(path.resolve(__dirname, '..'), 'data', 'browser-device-grants.json');
}

function normalizeOrigin(input) {
  try {
    const parsed = new URL(String(input || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      const error = new Error('只允许 http/https 网页申请设备权限');
      error.code = 'UNSUPPORTED_ORIGIN';
      throw error;
    }
    if (!parsed.origin || parsed.origin === 'null') {
      const error = new Error('无效网页来源');
      error.code = 'INVALID_ORIGIN';
      throw error;
    }
    return parsed.origin;
  } catch (error) {
    if (error?.code) throw error;
    const wrapped = new Error('无效网页来源');
    wrapped.code = 'INVALID_ORIGIN';
    throw wrapped;
  }
}

function endOfToday(now = new Date()) {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  ).getTime();
}

function readAll() {
  const filePath = getGrantFilePath();
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeAll(grants) {
  const filePath = getGrantFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(grants || {}, null, 2) + '\n', 'utf-8');
}

function pruneExpired(grants, nowMs = Date.now()) {
  const next = {};
  for (const [origin, grant] of Object.entries(grants || {})) {
    if (!grant || Number(grant.expiresAt) <= nowMs) continue;
    next[origin] = grant;
  }
  return next;
}

function getGrant(origin, now = new Date()) {
  const normalized = normalizeOrigin(origin);
  const grants = pruneExpired(readAll(), now.getTime());
  const grant = grants[normalized] || null;
  return grant ? { ...grant } : null;
}

function isGranted(origin, now = new Date()) {
  return !!getGrant(origin, now);
}

function grantToday(origin, now = new Date()) {
  const normalized = normalizeOrigin(origin);
  const grants = pruneExpired(readAll(), now.getTime());
  const grant = {
    origin: normalized,
    grantedAt: now.getTime(),
    expiresAt: endOfToday(now),
  };
  grants[normalized] = grant;
  writeAll(grants);
  return { ...grant };
}

function revoke(origin) {
  const normalized = normalizeOrigin(origin);
  const grants = readAll();
  delete grants[normalized];
  writeAll(grants);
  return { ok: true };
}

function getStatus(origin, now = new Date()) {
  const normalized = normalizeOrigin(origin);
  const grant = getGrant(normalized, now);
  return grant
    ? { granted: true, origin: normalized, expiresAt: grant.expiresAt }
    : { granted: false, origin: normalized };
}

module.exports = {
  normalizeOrigin,
  endOfToday,
  getGrant,
  isGranted,
  grantToday,
  revoke,
  getStatus,
  readAll,
  writeAll,
  pruneExpired,
  getGrantFilePath,
};
