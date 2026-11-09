const express = require('express');
const agentControl = require('../services/agentControlService');
const { sendError } = require('../utils/http');

const router = express.Router();

router.post('/lease', (req, res) => {
  try {
    res.json(agentControl.createLease(req.body || {}));
  } catch (error) {
    sendError(res, error.code || 'AGENT_LEASE_FAILED', error.message || String(error), error.status || 400);
  }
});

router.delete('/lease/:clientId', (req, res) => {
  try {
    res.json(agentControl.releaseLease(req.params.clientId));
  } catch (error) {
    sendError(res, error.code || 'AGENT_LEASE_FAILED', error.message || String(error), error.status || 400);
  }
});

router.get('/status', (req, res) => {
  res.json(agentControl.getStatus());
});

module.exports = router;
