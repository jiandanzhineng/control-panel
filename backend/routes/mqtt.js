const express = require('express');
const router = express.Router();
const mqttService = require('../services/mqttService');
const { sendError } = require('../utils/http');

router.post('/start', async (req, res) => {
  try {
    const { port = 1883, bind = '0.0.0.0', configPath } = req.body || {};
    const result = await mqttService.start({ port, bind, configPath });
    res.json(result);
  } catch (e) {
    sendError(res, 'MQTT_START_FAILED', e.message);
  }
});

router.get('/status', async (req, res) => {
  try {
    const result = await mqttService.status();
    res.json(result);
  } catch (e) {
    sendError(res, 'MQTT_STATUS_FAILED', e.message);
  }
});

router.post('/stop', async (req, res) => {
  try {
    const result = await mqttService.stop();
    res.json(result);
  } catch (e) {
    sendError(res, 'MQTT_STOP_FAILED', e.message);
  }
});

module.exports = router;