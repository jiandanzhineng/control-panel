const express = require('express');
const router = express.Router();
const { sendError } = require('../utils/http');
const gameCacheService = require('../services/gameCacheService');

function sendServiceError(res, error, fallbackCode) {
  sendError(
    res,
    error?.code || fallbackCode,
    error?.message || String(error),
    error?.status || 500,
  );
}

router.get('/status/:id', async (req, res) => {
  try {
    res.json(await gameCacheService.getStatus(req.params.id));
  } catch (error) {
    sendServiceError(res, error, 'GAME_CACHE_STATUS_FAILED');
  }
});

router.post('/install/:id', async (req, res) => {
  try {
    res.json(await gameCacheService.installGame(req.params.id));
  } catch (error) {
    sendServiceError(res, error, 'GAME_CACHE_INSTALL_FAILED');
  }
});

router.delete('/:id/:version', (req, res) => {
  try {
    const result = gameCacheService.deleteCache(req.params.id, req.params.version);
    if (result.notFound) {
      return sendError(res, 'GAME_CACHE_NOT_FOUND', '缓存不存在', 404);
    }
    res.json({ ok: true });
  } catch (error) {
    sendServiceError(res, error, 'GAME_CACHE_DELETE_FAILED');
  }
});

module.exports = router;
