/**
 * 品牌设备路由：郊狼（DGLab）与役次元（YCY）设备的发现、连接、断开与控制。
 * 通用设备能力（shock/strength）也可经 /api/devices/:id/capabilities/... 触发，
 * 此处提供面向品牌的更高层控制（波形选择、通道强度、指令触发等）。
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
router.post('/:deviceId/disconnect', (req, res) => {
  try {
    const ok = brandService.disconnect(req.params.deviceId);
    if (!ok) return sendError(res, 'BRAND_DEVICE_NOT_FOUND', '设备未连接', 404);
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 'BRAND_DISCONNECT_FAILED', e.message || String(e), 500);
  }
});

// 高层控制
// body: { action, ... }  —— action 依品牌不同而不同
router.post('/:deviceId/control', (req, res) => {
  const { deviceId } = req.params;
  const { action, ...params } = req.body || {};
  try {
    let result;
    switch (action) {
      // 郊狼
      case 'setPattern': result = brandService.dglabSetPattern(deviceId, params); break;
      case 'stop': result = brandService.dglabStop(deviceId); break;
      case 'setMaxIntensity': result = brandService.dglabSetMaxIntensity(deviceId, params); break;
      case 'setBackground': result = brandService.dglabSetBackground(deviceId, params); break;
      // 郊狼 V2（Web Bluetooth 直连）
      case 'v2SetStrength': result = brandService.dglabV2SetStrength(deviceId, params); break;
      case 'v2SetWaveform': result = brandService.dglabV2SetWaveform(deviceId, params); break;
      case 'v2Stop': result = brandService.dglabV2Stop(deviceId); break;
      case 'v2ReadBattery': result = brandService.dglabV2ReadBattery(deviceId); break;
      // 役次元
      case 'trigger': result = brandService.ycyTrigger(deviceId, params.commandId, params.token); break;
      case 'ycyStop': result = brandService.ycyStop(deviceId); break;
      case 'setStrength': result = brandService.ycySetStrength(deviceId, params); break;
      case 'setMode': result = brandService.ycySetMode(deviceId, params); break;
      case 'setSpeed': result = brandService.ycySetSpeed(deviceId, params); break;
      case 'setToyMode': result = brandService.ycySetToyMode(deviceId, params); break;
      default:
        return sendError(res, 'BRAND_UNKNOWN_ACTION', `未知控制动作: ${action}`, 400);
    }
    // 部分动作（BLE）返回 Promise
    Promise.resolve(result)
      .then((r) => res.json({ ok: true, result: r ?? null }))
      .catch((err) => sendError(res, 'BRAND_CONTROL_FAILED', err.message || String(err), 500));
  } catch (e) {
    sendError(res, 'BRAND_CONTROL_FAILED', e.message || String(e), 500);
  }
});

module.exports = router;
