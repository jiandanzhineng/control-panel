const express = require('express');
const clientControl = require('../services/clientControlService');
const { sendError } = require('../utils/http');

const router = express.Router();

function statusFor(code) {
  switch (code) {
    case 'CLIENT_UNAVAILABLE': return 503;
    case 'GAME_NOT_FOUND': return 404;
    case 'HOST_PLAY_ACTIVE': return 409;
    case 'AGENT_GAME_NOT_REGISTERED': return 403;
    case 'INVALID_REQUEST':
    case 'INVALID_WINDOW_ACTION':
    case 'INVALID_SCREENSHOT_FORMAT':
    case 'ROUTE_NOT_ALLOWED':
    case 'GAME_ID_REQUIRED':
      return 400;
    default:
      return 500;
  }
}

function handleError(res, error) {
  sendError(res, error?.code || 'CLIENT_CONTROL_FAILED', error?.message || '客户端控制失败', statusFor(error?.code));
}

router.get('/state', async (req, res) => {
  try {
    res.json(await clientControl.getState());
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/window', async (req, res) => {
  try {
    res.json(await clientControl.windowAction(req.body?.action));
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/routes', (req, res) => {
  res.json(clientControl.getRoutes());
});

router.post('/navigate', async (req, res) => {
  try {
    res.json(await clientControl.navigate(req.body?.path, { show: req.body?.show !== false }));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/screenshot', async (req, res) => {
  try {
    res.json(await clientControl.screenshot({
      format: req.body?.format,
      maxWidth: req.body?.maxWidth,
    }));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/games/:id/launch', async (req, res) => {
  try {
    res.json(await clientControl.launchGame({
      gameId: req.params.id,
      deviceMap: req.body?.deviceMap || req.body?.deviceMapping || {},
      parameters: req.body?.parameters || {},
      show: req.body?.show !== false,
      agentClientId: req.agentClientId || null,
    }));
  } catch (error) {
    handleError(res, error);
  }
});

module.exports = router;
