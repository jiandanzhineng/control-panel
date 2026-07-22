const express = require('express');
const router = express.Router();
const externalGameAccessService = require('../services/externalGameAccessService');
const { sendError } = require('../utils/http');

// 开发者「外部本地游戏」放行开关。
// GET  /api/dev-access         读取当前开关与白名单
// PUT  /api/dev-access         设置开关(enabled)与白名单(origins)
router.get('/', (req, res) => {
  try {
    res.json(externalGameAccessService.getStatus());
  } catch (e) {
    sendError(res, 'DEV_ACCESS_STATUS_FAILED', e.message);
  }
});

router.put('/', (req, res) => {
  try {
    const { enabled, origins } = req.body || {};
    const next = externalGameAccessService.setStatus({ enabled, origins });
    res.json(next);
  } catch (e) {
    sendError(res, 'DEV_ACCESS_UPDATE_FAILED', e.message);
  }
});

module.exports = router;
