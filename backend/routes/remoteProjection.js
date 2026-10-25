const express = require('express');
const remoteProjection = require('../services/remoteProjectionService');
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
  return sendError(res, error?.code || 'REMOTE_PROJECTION_ERROR', error?.message || '远程投影操作失败', 400);
}

router.get('/status', (req, res) => {
  res.json(remoteProjection.getStatus());
});

router.post('/create', async (req, res) => {
  try {
    const status = await remoteProjection.create({
      token: bearerToken(req),
      controlTtlSec: req.body?.controlTtlSec,
      limits: req.body?.limits,
      capacity: req.body?.capacity,
    });
    res.status(201).json(status);
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/join', async (req, res) => {
  try {
    res.json(await remoteProjection.join({
      token: bearerToken(req),
      joinCode: req.body?.joinCode,
    }));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/stop', async (req, res) => {
  try {
    res.json(await remoteProjection.stop());
  } catch (error) {
    handleError(res, error);
  }
});

// 房主显式授权某个成员（userId）。未授权成员拿不到设备清单，写入被拒。
router.post('/authorize', async (req, res) => {
  try {
    res.json(await remoteProjection.authorize(req.body?.userId));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/revoke', async (req, res) => {
  try {
    res.json(await remoteProjection.revoke());
  } catch (error) {
    handleError(res, error);
  }
});

// 移出房间：服务端踢人 + 本地立即拒绝（服务端踢线未接线）。
router.post('/kick', async (req, res) => {
  try {
    res.json(await remoteProjection.kick(req.body?.userId));
  } catch (error) {
    handleError(res, error);
  }
});

module.exports = router;
