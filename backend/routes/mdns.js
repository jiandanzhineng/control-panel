const express = require('express');
const router = express.Router();
const mdnsService = require('../services/mdnsService');
const { sendError } = require('../utils/http');

router.post('/publish', (req, res) => {
  try {
    const { ip } = req.body || {};
    if (!ip) return sendError(res, 'MDNS_PUBLISH_FAILED', 'Missing ip', 400);
    const result = mdnsService.publish({ ip });
    res.json({ running: true, pid: result.pid, ip, id: result.id });
  } catch (e) {
    sendError(res, 'MDNS_PUBLISH_FAILED', e.message);
  }
});

router.post('/unpublish', (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return sendError(res, 'MDNS_PUBLISH_FAILED', 'Missing id', 400);
    const result = mdnsService.unpublish(id);
    res.json(result);
  } catch (e) {
    sendError(res, 'MDNS_PUBLISH_FAILED', e.message);
  }
});

router.get('/status', (req, res) => {
  try {
    const rows = mdnsService.status();
    res.json(rows);
  } catch (e) {
    sendError(res, 'MDNS_STATUS_FAILED', e.message);
  }
});

module.exports = router;