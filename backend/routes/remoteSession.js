const express = require('express');
const remoteSession = require('../services/remoteSessionService');
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
  const code = error?.code || 'REMOTE_SESSION_ERROR';
  const status = code === 'CONTROL_NOT_AUTHORIZED' || code === 'NOT_OWNER' || code === 'CANNOT_KICK_SELF'
    ? 403
    : (code === 'USER_KICKED' ? 409
      : (code === 'STALE_GAME_SESSION' || code === 'GAME_SESSION_MISMATCH' ? 409 : 400));
  return sendError(res, code, error?.message || '远程会话操作失败', status);
}

router.get('/status', (req, res) => {
  res.json(remoteSession.getStatus());
});

router.post('/create', async (req, res) => {
  try {
    res.status(201).json(await remoteSession.create({ token: bearerToken(req) }));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/join', async (req, res) => {
  try {
    res.json(await remoteSession.join({ token: bearerToken(req), joinCode: req.body?.joinCode }));
  } catch (error) {
    handleError(res, error);
  }
});

// 被控端授权成员：主房间授权 + 下发投影房间码 + 自动授权投影
router.post('/authorize', async (req, res) => {
  try {
    res.json(await remoteSession.authorize({ userId: req.body?.userId }));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/revoke', async (req, res) => {
  try {
    res.json(await remoteSession.revoke());
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/kick', async (req, res) => {
  try {
    res.json(await remoteSession.kick({ userId: req.body?.userId }));
  } catch (error) {
    handleError(res, error);
  }
});

// 急停：停主控端触发的输出与玩法，会话继续
router.post('/emergency-stop', async (req, res) => {
  try {
    res.json(await remoteSession.emergencyStop());
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/stop', async (req, res) => {
  try {
    res.json(await remoteSession.stop({ reason: req.body?.reason || 'session-stop' }));
  } catch (error) {
    handleError(res, error);
  }
});

module.exports = router;
