const express = require('express');
const wiredFlashService = require('../services/wiredFlashService');
const { sendError } = require('../utils/http');

const router = express.Router();

router.get('/ports', async (req, res) => {
  try {
    res.json(await wiredFlashService.listPorts());
  } catch (error) {
    sendError(res, error.code || 'WIRED_FLASH_PORTS_FAILED', error.message || String(error), error.status || 500);
  }
});

router.post('/identify', async (req, res) => {
  try {
    res.json(await wiredFlashService.identify(req.body?.path));
  } catch (error) {
    sendError(res, error.code || 'SERIAL_IDENTIFY_FAILED', error.message || String(error), error.status || 500);
  }
});

router.get('/firmware', async (req, res) => {
  try {
    res.json(await wiredFlashService.getFirmwareForDevice(req.query.deviceType, req.query.currentVersion));
  } catch (error) {
    sendError(res, error.code || 'WIRED_FLASH_FIRMWARE_FAILED', error.message || String(error), error.status || 500);
  }
});

router.post('/flash', async (req, res) => {
  try {
    res.json(await wiredFlashService.startFlash(req.body || {}));
  } catch (error) {
    sendError(res, error.code || 'FLASH_START_FAILED', error.message || String(error), error.status || 500);
  }
});

router.get('/flash/:flashId/status', (req, res) => {
  const status = wiredFlashService.getFlashStatus(req.params.flashId);
  if (!status) {
    return sendError(res, 'FLASH_NOT_FOUND', '烧录任务不存在', 404);
  }
  res.json(status);
});

module.exports = router;
