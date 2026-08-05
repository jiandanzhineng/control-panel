const express = require('express');
const watchdog = require('../services/deviceWatchdogService');
const { sendError } = require('../utils/http');

const router = express.Router();

function getStatus(code) {
  switch (code) {
    case 'INVALID_CLIENT_ID':
    case 'INVALID_TTL_SECONDS':
      return 400;
    case 'WATCHDOG_STOP_IN_PROGRESS':
      return 409;
    case 'WATCHDOG_SHUT_DOWN':
      return 503;
    default:
      return 500;
  }
}

function handleError(res, error) {
  sendError(
    res,
    error?.code || 'DEVICE_WATCHDOG_FAILED',
    error?.message || String(error),
    getStatus(error?.code),
  );
}

router.post('/heartbeat', (req, res) => {
  try {
    res.json(watchdog.heartbeat(req.body || {}));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/stop-all', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await watchdog.stopAll({
      clientId: body.clientId,
      reason: typeof body.reason === 'string' && body.reason.length > 0
        ? body.reason.slice(0, 160)
        : 'client-request',
      trigger: 'client-request',
    });
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

module.exports = router;
