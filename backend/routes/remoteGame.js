const express = require('express');
const remoteGame = require('../services/remoteGameService');
const roomApi = require('../services/roomApiService');
const { sendError } = require('../utils/http');

const router = express.Router();

function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

// 画面同步事件（SSE）：与 /api/game-runtime/stream 同一套帧格式
function writeEvent(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function handleError(res, error) {
  if (error instanceof roomApi.RoomApiError) {
    return sendError(res, error.code, error.message, error.status);
  }
  const code = error?.code || 'REMOTE_GAME_ERROR';
  const status = code === 'CONTROL_NOT_AUTHORIZED'
    ? 403
    : (code === 'STALE_GAME_SESSION' || code === 'GAME_SESSION_MISMATCH' ? 409 : 400);
  return sendError(res, code, error?.message || '远程游戏操作失败', status);
}

router.get('/status', (req, res) => {
  res.json(remoteGame.getStatus());
});

// 画面同步（SSE）：与 /api/game-runtime/stream 同一套协议，只是状态文档换成
// /api/remote-game/status 的形状（主控端页面读它渲染）。
// 进流先给全量 snapshot，之后只给有变化的 patch；页面 rev 断档时重开本流。
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  writeEvent(res, { type: 'snapshot', ...remoteGame.getStateEvent() });
  const unsubscribe = remoteGame.subscribeState((event) => {
    try {
      writeEvent(res, event);
    } catch (_) {}
  });
  const cleanup = () => {
    try { unsubscribe(); } catch (_) {}
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

router.get('/room', async (req, res) => {
  try {
    res.json({ members: await remoteGame.getRoom() });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/kick', async (req, res) => {
  try {
    res.json(await remoteGame.kick({ userId: req.body?.userId }));
  } catch (error) {
    handleError(res, error);
  }
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
