const express = require('express');
const localSession = require('../services/localSessionService');
const voiceRelay = require('../services/voiceRelayService');
const { sendError } = require('../utils/http');

const router = express.Router();

router.post('/chat/completions', express.json({ limit: '24mb' }), (req, res, next) => {
  if (!localSession.isLoopback(req)) {
    return sendError(res, 'LOCAL_ONLY', '仅本机可使用语音中转', 403);
  }
  return voiceRelay.chatCompletions(req, res).catch(next);
});

module.exports = router;
