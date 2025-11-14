const express = require('express');
const router = express.Router();
const { sendError } = require('../utils/http');
const { interfaceConfig, typeInterfaceMap, getAllInterfaces } = require('../config/deviceTypes');

router.get('/', (req, res) => {
  try {
    const interfaces = getAllInterfaces();
    res.json({ interfaces, interfaceConfig, typeInterfaceMap });
  } catch (e) {
    sendError(res, 'DEVICE_INTERFACES_FAILED', e.message || String(e), 500);
  }
});

module.exports = router;
