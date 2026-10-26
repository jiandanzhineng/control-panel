const express = require('express');
const remoteSession = require('../services/remoteSessionService');
const remoteOutputSettings = require('../services/remoteOutputSettingsService');
const roomApi = require('../services/roomApiService');
const { sendError } = require('../utils/http');

const router = express.Router();

function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** 主控端本机玩法占用：登记 / 释放（页面式游戏跑在主控端，被控端登记为一次远程占用）。 */
router.post('/play/occupy', async (req, res) => {
  try {
    res.json(await remoteSession.occupyPlay({
      gameId: req.body?.gameId,
      gameName: req.body?.gameName,
    }));
  } catch (error) {
    // 被控端本地玩法运行中：主控端启动必须失败可见（409 HOST_PLAY_ACTIVE）
    const status = error?.code === 'HOST_PLAY_ACTIVE' ? 409 : 400;
    sendError(res, error?.code || 'PLAY_OCCUPY_FAILED', error?.message || '玩法占用登记失败', status);
  }
});

router.post('/play/release', async (req, res) => {
  try {
    res.json(await remoteSession.releasePlay({ gameId: req.body?.gameId }));
  } catch (error) {
    sendError(res, error?.code || 'PLAY_RELEASE_FAILED', error?.message || '玩法占用释放失败', 400);
  }
});

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

// 远程输出上限（持有方/B 端自己的设置，A 改不了）：电压上限 0–100，默认 20。
// 生效于远控游戏（source=remote）与远程手动设备控制；改完下一条输出立即生效。
router.get('/output-limits', (req, res) => {
  res.json(remoteOutputSettings.status());
});

router.put('/output-limits', (req, res) => {
  try {
    res.json(remoteOutputSettings.setVoltage(req.body?.voltage));
  } catch (error) {
    sendError(res, error?.code || 'OUTPUT_LIMIT_INVALID', error?.message || '远程输出上限设置失败', 400);
  }
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
