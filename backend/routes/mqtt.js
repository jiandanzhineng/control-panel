const express = require('express');
const router = express.Router();
const mqttService = require('../services/mqttService');
const { sendError } = require('../utils/http');

router.post('/start', (req, res) => {
  try {
    const { port = 1883, bind = '0.0.0.0', configPath } = req.body || {};
    const result = mqttService.start({ port, bind, configPath });
    res.json(result);
  } catch (e) {
    sendError(res, 'MQTT_START_FAILED', e.message);
  }
});

router.get('/status', (req, res) => {
  res.json(mqttService.status());
});

router.post('/stop', (req, res) => {
  try {
    const result = mqttService.stop();
    res.json(result);
  } catch (e) {
    sendError(res, 'MQTT_STOP_FAILED', e.message);
  }
});

module.exports = router;