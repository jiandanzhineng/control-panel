const express = require('express');
const router = express.Router();
const { sendError } = require('../utils/http');
const { getAllCapabilities, getTypeCapabilities } = require('../config/deviceTypes');
const { getAllCapabilityDefinitions } = require('../devices/capabilities');
const registry = require('../devices/registry');

router.get('/', (req, res) => {
  try {
    res.json({
      capabilities: getAllCapabilities(),
      capabilityConfig: getAllCapabilityDefinitions(),
      typeCapabilityMap: registry.getTypeCapabilityMap(),
    });
  } catch (e) {
    sendError(res, 'DEVICE_CAPABILITIES_FAILED', e.message || String(e), 500);
  }
});

module.exports = router;
