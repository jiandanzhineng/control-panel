const express = require('express');
const router = express.Router();
const deviceService = require('../services/deviceService');
const { getAllDeviceTypeConfigs } = require('../config/deviceTypes');
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

// 获取所有设备类型配置
router.get('/configs', (req, res) => {
  try {
    const configs = getAllDeviceTypeConfigs();
    res.json(configs);
  } catch (e) {
    sendError(res, 'DEVICE_TYPE_CONFIGS_FAILED', e.message || String(e), 500);
  }
});

// 获取特定设备类型配置
router.get('/:type/config', (req, res) => {
  try {
    const { type } = req.params;
    const config = deviceService.getDeviceTypeConfigForApi(type);
    
    if (!config) {
      return sendError(res, 'DEVICE_TYPE_NOT_FOUND', '设备类型不存在', 404);
    }
    
    res.json(config);
  } catch (e) {
    sendError(res, 'DEVICE_TYPE_CONFIG_FAILED', e.message || String(e), 500);
  }
});

module.exports = router;