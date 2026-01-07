const express = require('express');
const router = express.Router();
const testService = require('../services/testService');

// 1. 开始测试平台 (对应前端页面打开)
router.post('/start', (req, res) => {
  testService.startPlatform();
  res.json({ success: true, message: 'Test platform started' });
});

// 2. 停止测试平台 (对应前端页面关闭)
router.post('/stop', (req, res) => {
  testService.stopPlatform();
  res.json({ success: true, message: 'Test platform stopped' });
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

module.exports = router;
