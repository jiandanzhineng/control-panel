const express = require('express');
const router = express.Router();
const networkService = require('../services/networkService');
const { sendError } = require('../utils/http');

router.get('/ips', async (req, res) => {
  try {
    const rows = await networkService.getIps();
    if (!rows || rows.length === 0) return sendError(res, 'IFCONFIG_NOT_AVAILABLE', 'No IPv4 available', 500);
    res.json(rows);
  } catch (e) {
    sendError(res, 'IFCONFIG_NOT_AVAILABLE', e.message, 500);
  }
});

module.exports = router;