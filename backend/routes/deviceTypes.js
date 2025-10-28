const express = require('express');
const router = express.Router();
const deviceService = require('../services/deviceService');
const { sendError } = require('../utils/http');

// 获取设备类型映射
router.get('/', (req, res) => {
  try {
    const map = deviceService.getDeviceTypesForApi();
    res.json(map);
  } catch (e) {
    sendError(res, 'DEVICE_TYPES_FAILED', e.message || String(e), 500);
  }
});

module.exports = router;