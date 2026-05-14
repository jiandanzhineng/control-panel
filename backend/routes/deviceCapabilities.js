const express = require('express');
const router = express.Router();
const { sendError } = require('../utils/http');
const {
  capabilityConfig,
  typeCapabilityMap,
  getAllCapabilities,
} = require('../config/deviceTypes');

router.get('/', (req, res) => {
  try {
    res.json({
      capabilities: getAllCapabilities(),
      capabilityConfig,
      typeCapabilityMap,
    });
  } catch (e) {
    sendError(res, 'DEVICE_CAPABILITIES_FAILED', e.message || String(e), 500);
  }
});

module.exports = router;
