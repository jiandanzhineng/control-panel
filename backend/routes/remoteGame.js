const express = require('express');
const remoteGame = require('../services/remoteGameService');
const roomApi = require('../services/roomApiService');
const { sendError } = require('../utils/http');

const router = express.Router();

function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

function handleError(res, error) {
  if (error instanceof roomApi.RoomApiError) {
    return sendError(res, error.code, error.message, error.status);
  }
  const code = error?.code || 'REMOTE_GAME_ERROR';
  const status = code === 'CONTROL_NOT_AUTHORIZED' ? 403 : 400;
  return sendError(res, code, error?.message || '远程游戏操作失败', status);
}

router.get('/status', (req, res) => {
  res.json(remoteGame.getStatus());
});

router.post('/create', async (req, res) => {
  try {
    res.status(201).json(await remoteGame.create({ token: bearerToken(req) }));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/join', async (req, res) => {
  try {
    res.json(await remoteGame.join({ token: bearerToken(req), joinCode: req.body?.joinCode }));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/authorize', async (req, res) => {
  try {
    res.json(await remoteGame.authorize());
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/revoke', async (req, res) => {
  try {
    res.json(await remoteGame.revoke());
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/command', async (req, res) => {
  try {
    const result = await remoteGame.command({ type: req.body?.type, payload: req.body?.payload });
    if (result && result.ok === false) return handleError(res, { code: result.code, message: result.message });
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/stop', async (req, res) => {
  try {
    res.json(await remoteGame.stop({ reason: req.body?.reason || 'room-closed' }));
  } catch (error) {
    handleError(res, error);
  }
});

module.exports = router;
