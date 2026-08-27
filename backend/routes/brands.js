/**
 * 品牌设备路由：发现、连接、断开。
 * 控制走 /api/devices/:id/capabilities/... 或 operations。
 */
const express = require('express');
const router = express.Router();
const brandService = require('../brands/brandService');
const { sendError } = require('../utils/http');

// 状态 / 支持列表
router.get('/status', (req, res) => {
  try {
    res.json(brandService.getStatus());
  } catch (e) {
    sendError(res, 'BRAND_STATUS_FAILED', e.message || String(e), 500);
  }
});

// 原版 V2 强度位布局（标定用）：GET 读取当前布局，POST 切换（'official' | 'coyote2'）
router.get('/v2-layout', (req, res) => {
  try {
    res.json({ layout: brandService.getV2StrengthLayout(), options: ['official', 'coyote2'] });
  } catch (e) {
    sendError(res, 'BRAND_V2_LAYOUT_READ_FAILED', e.message || String(e), 500);
  }
});
router.post('/v2-layout', (req, res) => {
  try {
    const layout = String(req.body?.layout || '');
    const next = brandService.setV2StrengthLayout(layout);
    res.json({ layout: next, options: ['official', 'coyote2'] });
  } catch (e) {
    sendError(res, 'BRAND_V2_LAYOUT_SET_FAILED', e.message || String(e), 400);
  }
});

// 发现设备
// 郊狼：?brand=dglab&host=192.168.1.10 或 &hosts=192.168.1.10,192.168.1.11
// 役次元 bridge：?brand=ycy&mode=bridge&host=127.0.0.1&port=3001
// 役次元 ble   ：?brand=ycy&mode=ble&timeoutMs=5000
router.get('/discover', async (req, res) => {
  try {
    const brand = String(req.query.brand || '');
    if (!brand) return sendError(res, 'BRAND_REQUIRED', '缺少 brand 参数', 400);
    const opts = {
      host: req.query.host,
      port: req.query.port ? Number(req.query.port) : undefined,
      mode: req.query.mode,
      timeoutMs: req.query.timeoutMs ? Number(req.query.timeoutMs) : undefined,
    };
    if (req.query.hosts) {
      opts.hosts = String(req.query.hosts).split(',').map((s) => s.trim()).filter(Boolean);
    }
    const found = await brandService.discover(brand, opts);
    res.json({ brand, count: found.length, devices: found });
  } catch (e) {
    sendError(res, 'BRAND_DISCOVER_FAILED', e.message || String(e), 500);
  }
});

// 连接设备
router.post('/connect', async (req, res) => {
  try {
    const brand = req.body?.brand;
    if (!brand) return sendError(res, 'BRAND_REQUIRED', '缺少 brand 字段', 400);
    const result = await brandService.connect(brand, req.body || {});
    res.json(result);
  } catch (e) {
    sendError(res, 'BRAND_CONNECT_FAILED', e.message || String(e), 500);
  }
});

// 已连接品牌设备列表
router.get('/', (req, res) => {
  try {
    res.json(brandService.list());
  } catch (e) {
    sendError(res, 'BRAND_LIST_FAILED', e.message || String(e), 500);
  }
});

// 断开连接
router.post('/:deviceId/disconnect', async (req, res) => {
  try {
    const ok = await brandService.disconnect(req.params.deviceId);
    if (!ok) return sendError(res, 'BRAND_DEVICE_NOT_FOUND', '设备未连接', 404);
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 'BRAND_DISCONNECT_FAILED', e.message || String(e), 500);
  }
});

module.exports = router;
