const express = require('express');
const router = express.Router();
const vds = require('../services/virtualDeviceService');
const { sendError } = require('../utils/http');

router.post('/', (req, res) => {
  try {
    const { id, type, properties } = req.body;
    if (!id || !type) return sendError(res, 'INVALID_INPUT', '缺少 id 或 type', 400);
    const dev = vds.createDevice({ id, type, properties: properties || {} });
    res.json({ ok: true, id: dev.id, type: dev.type, properties: dev.properties });
  } catch (e) {
    const code = e.code === 'VIRTUAL_DEVICE_EXISTS' ? 409 : 500;
    sendError(res, e.code || 'CREATE_FAILED', e.message, code);
  }
});

router.post('/batch', (req, res) => {
  try {
    const { devices } = req.body;
    if (!Array.isArray(devices)) return sendError(res, 'INVALID_INPUT', 'devices must be array', 400);
    const results = vds.batchCreate(devices);
    res.json({ ok: true, results });
  } catch (e) {
    sendError(res, 'BATCH_FAILED', e.message, 500);
  }
});

router.get('/', (req, res) => {
  res.json(vds.listDevices());
});

router.delete('/:id', (req, res) => {
  const ok = vds.deleteDevice(req.params.id);
  if (!ok) return sendError(res, 'NOT_FOUND', '虚拟设备不存在', 404);
  res.json({ ok: true });
});

router.put('/:id/properties', (req, res) => {
  const result = vds.setProperties(req.params.id, req.body || {});
  if (result === null) return sendError(res, 'NOT_FOUND', '虚拟设备不存在', 404);
  res.json(result);
});

router.get('/:id/properties', (req, res) => {
  const dev = vds.getDevice(req.params.id);
  if (!dev) return sendError(res, 'NOT_FOUND', '虚拟设备不存在', 404);
  res.json(dev.properties);
});

router.post('/:id/emit', (req, res) => {
  const ok = vds.emitMessage(req.params.id, req.body || {});
  if (ok === null) return sendError(res, 'NOT_FOUND', '虚拟设备不存在', 404);
  res.json({ ok: true });
});

router.get('/:id/commands', (req, res) => {
  const cmds = vds.getCommands(req.params.id);
  if (cmds === null) return sendError(res, 'NOT_FOUND', '虚拟设备不存在', 404);
  res.json(cmds);
});

router.delete('/:id/commands', (req, res) => {
  const ok = vds.clearCommands(req.params.id);
  if (!ok) return sendError(res, 'NOT_FOUND', '虚拟设备不存在', 404);
  res.json({ ok: true });
});

router.post('/:id/timeline', (req, res) => {
  const { timeline, loop } = req.body || {};
  if (!Array.isArray(timeline)) return sendError(res, 'INVALID_INPUT', 'timeline must be array', 400);
  const result = vds.startTimeline(req.params.id, timeline, !!loop);
  if (result === null) return sendError(res, 'NOT_FOUND', '虚拟设备不存在', 404);
  res.json({ ok: true });
});

router.delete('/:id/timeline', (req, res) => {
  const ok = vds.stopTimeline(req.params.id);
  if (!ok) return sendError(res, 'NOT_FOUND', '虚拟设备不存在或无timeline', 404);
  res.json({ ok: true });
});

router.get('/:id/timeline', (req, res) => {
  const status = vds.getTimelineStatus(req.params.id);
  if (status === null) return sendError(res, 'NOT_FOUND', '无活跃timeline', 404);
  res.json(status);
});

module.exports = router;
