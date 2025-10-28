const express = require('express');
const router = express.Router();
const mqttClient = require('../services/mqttClientService');
const { sendError } = require('../utils/http');

router.get('/status', (req, res) => {
  try {
    const s = mqttClient.status();
    res.json(s);
  } catch (e) {
    sendError(res, 'MQTT_CLIENT_STATUS_FAILED', e.message || String(e), 500);
  }
});

router.post('/publish', (req, res) => {
  try {
    const { topic, message } = req.body || {};
    if (!topic) return sendError(res, 'MQTT_CLIENT_PUBLISH_FAILED', 'Missing topic', 400);
    if (message === undefined) return sendError(res, 'MQTT_CLIENT_PUBLISH_FAILED', 'Missing message', 400);
    mqttClient.publish(topic, message);
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 'MQTT_CLIENT_PUBLISH_FAILED', e.message || String(e), 500);
  }
});

module.exports = router;