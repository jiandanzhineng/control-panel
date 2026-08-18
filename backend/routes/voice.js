const express = require('express');
const localSession = require('../services/localSessionService');
const voiceSettings = require('../services/voiceSettingsService');
const { sendError } = require('../utils/http');

const router = express.Router();

function requireLoopback(req, res) {
  if (localSession.isLoopback(req)) return true;
  sendError(res, 'LOCAL_ONLY', '仅本机可读写语音设置', 403);
  return false;
}

router.get('/status', (req, res) => {
  if (!requireLoopback(req, res)) return;
  res.json(voiceSettings.status());
});

router.post('/settings', (req, res) => {
  if (!requireLoopback(req, res)) return;
  const { route, api_key } = req.body || {};
  if (route !== undefined && !voiceSettings.ROUTES.includes(route)) {
    return sendError(res, 'BAD_ROUTE', 'route 只能是 own_key 或 panel', 400);
  }
  res.json(voiceSettings.update({ route, api_key }));
});

module.exports = router;
