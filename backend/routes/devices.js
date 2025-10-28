const express = require('express');
const router = express.Router();
const deviceService = require('../services/deviceService');
const { sendError } = require('../utils/http');

// 查询设备列表
router.get('/', (req, res) => {
  try {
    const rows = deviceService.listDevicesForApi();
    res.json(rows);
  } catch (e) {
    sendError(res, 'DEVICE_LIST_FAILED', e.message || String(e), 500);
  }
});

// 清空所有设备（注意顺序，避免与 :id 冲突）
router.delete('/all', (req, res) => {
  try {
    deviceService.clearDevices();
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 'DEVICE_CLEAR_FAILED', e.message || String(e), 500);
  }
});

// 查询设备详情
router.get('/:id', (req, res) => {
  try {
    const id = req.params.id;
    const dev = deviceService.getDeviceForApi(id);
    if (!dev) return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);
    res.json(dev);
  } catch (e) {
    sendError(res, 'DEVICE_DETAIL_FAILED', e.message || String(e), 500);
  }
});

// 更新设备元数据（例如名称），并通知设备
router.patch('/:id', (req, res) => {
  try {
    const id = req.params.id;
    const patch = req.body || {};
    const dev = deviceService.updateDeviceMeta(id, patch);
    if (!dev) return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);
    try {
      deviceService.notifyDeviceUpdate(id, patch);
    } catch (e) {
      return sendError(res, 'MQTT_CLIENT_PUBLISH_FAILED', e.message || String(e), 500);
    }
    res.json(deviceService.toApiDevice(dev));
  } catch (e) {
    sendError(res, 'DEVICE_UPDATE_FAILED', e.message || String(e), 500);
  }
});

// 删除单个设备
router.delete('/:id', (req, res) => {
  try {
    const id = req.params.id;
    const ok = deviceService.deleteDeviceById(id);
    if (!ok) return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 'DEVICE_DELETE_FAILED', e.message || String(e), 500);
  }
});

module.exports = router;