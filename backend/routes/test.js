const express = require('express');
const router = express.Router();
const testService = require('../services/testService');
const autoProvisionService = require('../services/autoProvisionService');
const { sendError } = require('../utils/http');

// 1. 开始测试平台 (对应前端页面打开)
router.post('/start', async (req, res) => {
  testService.startPlatform();
  try {
    const provision = await autoProvisionService.start();
    res.json({ success: true, message: 'Test platform started', provision });
  } catch (error) {
    sendError(res, error.code || 'AUTO_PROVISION_START_FAILED', error.message || String(error), error.status || 500);
  }
});

// 2. 停止测试平台 (对应前端页面关闭)
router.post('/stop', async (req, res) => {
  testService.stopPlatform();
  try {
    const provision = await autoProvisionService.stop();
    res.json({ success: true, message: 'Test platform stopped', provision });
  } catch (error) {
    sendError(res, error.code || 'AUTO_PROVISION_STOP_FAILED', error.message || String(error), error.status || 500);
  }
});

// 3. 重新下发开始命令 (单个设备)
router.post('/device/:id/start', (req, res) => {
  const deviceId = req.params.id;
  testService.startTest(deviceId);
  res.json({ success: true, message: `Started test for device ${deviceId}` });
});

// 4. SSE 数据推送
router.get('/stream', (req, res) => {
  testService.handleSSE(req, res);
});

// 5. 串口自动供给（探测 → 烧录 → 再探测）状态与设置
router.get('/provision', (req, res) => {
  res.json(autoProvisionService.getState());
});

router.put('/provision/settings', (req, res) => {
  try {
    autoProvisionService.setSettings(req.body || {});
    res.json(autoProvisionService.getState());
  } catch (error) {
    sendError(res, error.code || 'AUTO_PROVISION_SETTINGS_FAILED', error.message || String(error), error.status || 400);
  }
});

router.post('/provision/ports/:path/retry', async (req, res) => {
  try {
    res.json(await autoProvisionService.retry(req.params.path));
  } catch (error) {
    sendError(res, error.code || 'AUTO_PROVISION_RETRY_FAILED', error.message || String(error), error.status || 500);
  }
});

module.exports = router;
