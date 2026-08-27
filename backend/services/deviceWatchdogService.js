const deviceService = require('./deviceService');
const logger = require('../utils/logger');

const DEFAULT_TTL_SECONDS = 30;
const MIN_TTL_SECONDS = 5;
const MAX_TTL_SECONDS = 600;
const MAX_STOP_ATTEMPTS = 3;
const RETRY_DELAY_MS = 50;

const leases = new Map();
let generation = 0;
let stopPromise = null;
let shutdownPromise = null;

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateClientId(clientId) {
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/.test(clientId)) {
    throw createError(
      'INVALID_CLIENT_ID',
      'clientId must be 1-96 characters using letters, numbers, dot, underscore, colon, or hyphen',
    );
  }
  return clientId;
}

function validateTtlSeconds(ttlSeconds) {
  const value = ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : ttlSeconds;
  if (!Number.isInteger(value) || value < MIN_TTL_SECONDS || value > MAX_TTL_SECONDS) {
    throw createError('INVALID_TTL_SECONDS', 'ttlSeconds must be an integer from 5 to 600');
  }
  return value;
}

function clearLeases() {
  for (const lease of leases.values()) clearTimeout(lease.timer);
  leases.clear();
}

function scheduleLease(clientId, lease) {
  const delay = Math.max(0, lease.expiresAtMs - Date.now());
  lease.timer = setTimeout(() => {
    void expireLease(clientId, lease.generation, lease.expiresAtMs).catch((error) => {
      logger.error('Device watchdog expiry failed', {
        clientId,
        expiresAt: new Date(lease.expiresAtMs).toISOString(),
        error: error?.message || String(error),
      });
    });
  }, delay);
  lease.timer.unref?.();
}

async function expireLease(clientId, expectedGeneration, expectedExpiresAtMs) {
  const current = leases.get(clientId);
  if (!current
    || current.generation !== expectedGeneration
    || current.expiresAtMs !== expectedExpiresAtMs) {
    return;
  }

  if (Date.now() < current.expiresAtMs) {
    scheduleLease(clientId, current);
    return;
  }

  await stopAll({
    clientId,
    reason: 'lease-expired',
    trigger: 'lease-expired',
    expiresAt: new Date(expectedExpiresAtMs).toISOString(),
  });
}

function heartbeat({ clientId, ttlSeconds } = {}) {
  if (shutdownPromise) {
    throw createError('WATCHDOG_SHUT_DOWN', 'device watchdog is shutting down');
  }
  if (stopPromise) {
    throw createError('WATCHDOG_STOP_IN_PROGRESS', 'device stop is in progress');
  }

  const validClientId = validateClientId(clientId);
  const validTtlSeconds = validateTtlSeconds(ttlSeconds);
  const previous = leases.get(validClientId);
  if (previous) clearTimeout(previous.timer);

  const lease = {
    generation: ++generation,
    expiresAtMs: Date.now() + validTtlSeconds * 1000,
    timer: null,
  };
  leases.set(validClientId, lease);
  scheduleLease(validClientId, lease);

  return {
    ok: true,
    clientId: validClientId,
    ttlSeconds: validTtlSeconds,
    expiresAt: new Date(lease.expiresAtMs).toISOString(),
  };
}

function waitForRetry() {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, RETRY_DELAY_MS);
    timer.unref?.();
  });
}

async function stopDeviceWithRetry(device) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_STOP_ATTEMPTS; attempt += 1) {
    try {
      const stop = deviceService.stopExecutionDeviceAndWait || deviceService.stopExecutionDevice;
      const result = await Promise.resolve(stop(device.id));
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_STOP_ATTEMPTS) await waitForRetry();
    }
  }

  return {
    deviceId: device.id,
    eligible: true,
    commandSent: false,
    confirmed: false,
    attempts: MAX_STOP_ATTEMPTS,
    error: {
      code: lastError?.code || 'DEVICE_STOP_FAILED',
      message: lastError?.message || String(lastError),
    },
  };
}

async function performStopAll({
  clientId = null,
  reason = 'unspecified',
  trigger = 'client-request',
  expiresAt = null,
} = {}) {
  const devices = deviceService.listDevicesForApi();
  const settled = await Promise.all(devices.map((device) => stopDeviceWithRetry(device)));
  const stopped = settled.filter((result) => result.eligible);
  const skipped = settled.filter((result) => !result.eligible).map((result) => result.deviceId);
  const ok = stopped.every((result) => result.commandSent);
  const result = { ok, trigger, clientId, reason, stopped, skipped };

  logger.info('Device watchdog stop completed', {
    trigger,
    clientId,
    reason,
    expiresAt,
    stopped: stopped.map(({ deviceId, commandSent, confirmed, attempts, error }) => ({
      deviceId,
      commandSent,
      confirmed,
      attempts,
      error,
    })),
    skipped,
  });
  return result;
}

function stopAll(options = {}) {
  const trigger = options.trigger || 'client-request';
  if (trigger === 'client-request') validateClientId(options.clientId);
  if (stopPromise) return stopPromise;
  clearLeases();
  stopPromise = performStopAll({ ...options, trigger }).finally(() => {
    stopPromise = null;
  });
  return stopPromise;
}

function shutdown(reason = 'backend-shutdown') {
  if (!shutdownPromise) {
    shutdownPromise = stopAll({ reason, trigger: 'backend-shutdown' });
  }
  return shutdownPromise;
}

function resetForTests() {
  clearLeases();
  generation = 0;
  stopPromise = null;
  shutdownPromise = null;
}

module.exports = {
  heartbeat,
  stopAll,
  shutdown,
  resetForTests,
};
