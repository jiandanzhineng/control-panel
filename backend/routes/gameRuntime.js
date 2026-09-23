const express = require('express');
const gameHost = require('../game-runtime/gameHostService');
const bridgeService = require('../services/bridgeService');
const { sendError } = require('../utils/http');

const router = express.Router();

function handleError(res, error) {
  const code = error?.code || 'GAME_RUNTIME_ERROR';
  const status = code === 'NO_SESSION' || code === 'GAME_NOT_HOSTED' ? 400 : 400;
  return sendError(res, code, error?.message || '游戏运行失败', status);
}

router.get('/status', (req, res) => {
  res.json(gameHost.getStatus());
});

router.get('/games', (req, res) => {
  const { GAME_ID, TITLE, VERSION, PARAMS, DEVICES } = require('../game-runtime/cores/surge-edging-manifest');
  res.json([{ id: GAME_ID, title: TITLE, version: VERSION, runtimeMode: 'host', params: PARAMS, devices: DEVICES }]);
});

router.post('/start', async (req, res) => {
  try {
    const body = req.body || {};
    await require('../services/localAppProcessService').stopAll();
    try { bridgeService.exitCurrent(); } catch (_) {}
    res.status(201).json(gameHost.start({
      gameId: body.gameId,
      deviceMap: body.deviceMap,
      params: body.params,
      source: body.source || 'local',
    }));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/params', (req, res) => {
  try {
    res.json(gameHost.setParams(req.body?.params));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/action', (req, res) => {
  try {
    res.json(gameHost.action(req.body?.action, req.body?.payload));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/sensor', (req, res) => {
  try {
    res.json(gameHost.pushSensor(req.body || {}));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/tick', (req, res) => {
  try {
    const nowMs = req.body?.nowMs;
    res.json(gameHost.tick(Number.isFinite(Number(nowMs)) ? Number(nowMs) : undefined));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/stop', (req, res) => {
  try {
    res.json(gameHost.stop({ reason: req.body?.reason || 'api-stop' }));
  } catch (error) {
    handleError(res, error);
  }
});

module.exports = router;
