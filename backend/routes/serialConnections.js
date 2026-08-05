const express = require('express');
const serialConnections = require('../services/serialConnectionService');
const { sendError } = require('../utils/http');

const router = express.Router();

router.get('/ports', async (req, res) => {
  try {
    res.json(await serialConnections.listPorts());
  } catch (error) {
    sendError(res, error.code || 'SERIAL_PORT_LIST_FAILED', error.message || String(error), error.status || 500);
  }
});

router.post('/connections', async (req, res) => {
  try {
    res.json(await serialConnections.connect(req.body?.path, { automatic: false }));
  } catch (error) {
    sendError(res, error.code || 'SERIAL_CONNECT_FAILED', error.message || String(error), error.status || 500);
  }
});

router.delete('/connections/:deviceId', async (req, res) => {
  try {
    const disconnected = await serialConnections.disconnectDevice(req.params.deviceId);
    if (!disconnected) {
      return sendError(res, 'SERIAL_CONNECTION_NOT_FOUND', '设备没有在线串口连接', 404);
    }
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error.code || 'SERIAL_DISCONNECT_FAILED', error.message || String(error), error.status || 500);
  }
});

router.get('/settings', (req, res) => {
  res.json(serialConnections.getSettings());
});

router.put('/settings', async (req, res) => {
  try {
    res.json(await serialConnections.setSettings(req.body || {}));
  } catch (error) {
    sendError(res, error.code || 'SERIAL_SETTINGS_FAILED', error.message || String(error), error.status || 500);
  }
});

module.exports = router;
