const express = require('express');
const path = require('path');
const router = express.Router();
const { sendError } = require('../utils/http');
const gameService = require('../services/gameService');
const gameplayService = require('../services/gameplayService');

function setupSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // 禁止某些代理缓冲，避免 SSE 延迟
  res.setHeader('X-Accel-Buffering', 'no');
}

function sseWrite(res, eventName, data) {
  try {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (_) {}
}

function resolveGameAbsPath(configOrPath) {
  if (!configOrPath) return null;
  const p = typeof configOrPath === 'string' ? configOrPath : configOrPath.configPath;
  if (!p || typeof p !== 'string') return null;
  if (path.isAbsolute(p)) return p;
  const prefix = 'backend/game/';
  if (p.startsWith(prefix)) {
    const relWithinGame = p.slice(prefix.length);
    return path.resolve(__dirname, '..', 'game', relWithinGame);
  }
  return path.resolve(__dirname, '..', 'game', p);
}

function createSseConnection(res) {
  setupSseHeaders(res);
  // 事件节流：最多 10 个/秒（hello、state、ui、log、ping 总计）
  let bucketStart = Date.now();
  let eventsThisSecond = 0;
  const canSend = () => {
    const now = Date.now();
    if (now - bucketStart >= 1000) { bucketStart = now; eventsThisSecond = 0; }
    return eventsThisSecond < 10;
  };
  const markSent = () => { eventsThisSecond += 1; };

  // 聚合增量：100ms 刷新一次，合并相邻增量
  let pendingState = {};
  let pendingUi = {};
  const stateCb = (delta) => { try { Object.assign(pendingState, delta || {}); } catch (_) {} };
  const uiCb = (delta) => { try { Object.assign(pendingUi, delta || {}); } catch (_) {} };
  gameplayService.onStateUpdate(stateCb);
  gameplayService.onUiUpdate(uiCb);

  const flushTimer = setInterval(() => {
    if (!res.writableEnded) {
      // 优先发送 state，再发送 ui，每次检查配额
      if (Object.keys(pendingState).length) {
        if (canSend()) { sseWrite(res, 'state', pendingState); markSent(); pendingState = {}; }
      }
      if (Object.keys(pendingUi).length) {
        if (canSend()) { sseWrite(res, 'ui', pendingUi); markSent(); pendingUi = {}; }
      }
    }
  }, 100);

  // 日志转发（受全局配额限制，配额不足时丢弃）
  const logCb = (payload) => {
    if (res.writableEnded) return;
    if (canSend()) { sseWrite(res, 'log', payload); markSent(); }
  };
  gameplayService.addLogCallback(logCb);

  // 心跳（可选，10s 一次）
  const pingTimer = setInterval(() => {
    if (res.writableEnded) return;
    if (canSend()) { sseWrite(res, 'ping', { ts: Date.now() }); markSent(); }
  }, 10000);

  // 关闭时清理
  const cleanup = () => {
    try { clearInterval(flushTimer); } catch (_) {}
    try { clearInterval(pingTimer); } catch (_) {}
    try { gameplayService.offStateUpdate(stateCb); } catch (_) {}
    try { gameplayService.offUiUpdate(uiCb); } catch (_) {}
    try { gameplayService.removeLogCallback(logCb); } catch (_) {}
    try { res.end(); } catch (_) {}
  };
  res.on('close', cleanup);
  res.on('error', cleanup);

  // 返回发送接口与配额控制，供调用者发 hello
  return {
    sendHello(snapshot) { if (canSend()) { sseWrite(res, 'hello', { snapshot }); markSent(); } },
  };
}

// 订阅当前玩法 SSE
router.get('/current/stream', (req, res) => {
  try {
    const s = gameplayService.status();
    if (!s.running) return sendError(res, 'NO_GAME_RUNNING', '当前无运行玩法', 404);
    const conn = createSseConnection(res);
    // 首屏快照（在连接建立后 1 秒内发送）
    setTimeout(() => { try { conn.sendHello(gameplayService.getSnapshot()); } catch (_) {} }, 0);
  } catch (e) {
    sendError(res, 'GAME_STREAM_FAILED', e?.message || String(e), 500);
  }
});

// 订阅指定玩法 SSE（若非当前玩法则 409）
router.get('/:id/stream', (req, res) => {
  try {
    const { id } = req.params;
    const s = gameplayService.status();
    if (!s.running) return sendError(res, 'NO_GAME_RUNNING', '当前无运行玩法', 404);

    const game = gameService.getGameById(id);
    if (!game) return sendError(res, 'GAME_NOT_FOUND', '游戏不存在', 404);
    const absForId = resolveGameAbsPath(game.configPath);
    const currentAbs = s.gameplaySourcePath;
    if (!absForId || !currentAbs || path.resolve(absForId) !== path.resolve(currentAbs)) {
      return sendError(res, 'GAME_NOT_CURRENT', '请求的玩法不是当前运行', 409);
    }

    const conn = createSseConnection(res);
    setTimeout(() => { try { conn.sendHello(gameplayService.getSnapshot()); } catch (_) {} }, 0);
  } catch (e) {
    sendError(res, 'GAME_STREAM_FAILED', e?.message || String(e), 500);
  }
});

// 返回当前玩法的嵌入式页面 HTML
router.get('/current/html', (req, res) => {
  try {
    const html = gameplayService.getHtmlString();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    const code = e?.code === 'NO_GAME_RUNNING' ? 404 : 500;
    const errCode = e?.code || 'GAMEPLAY_HTML_NOT_AVAILABLE';
    sendError(res, errCode, e?.message || String(e), code);
  }
});

// 页面动作转发到玩法
router.post('/current/actions', (req, res) => {
  try {
    const { action, payload } = req.body || {};
    if (!action || typeof action !== 'string') {
      return sendError(res, 'GAMEPLAY_ACTION_NOT_SUPPORTED', '缺少有效动作名 action', 400);
    }
    const result = gameplayService.performAction(action, payload);
    res.json(result === undefined ? { ok: true } : { ok: true, result });
  } catch (e) {
    const code = e?.code === 'NO_GAME_RUNNING' ? 404 : (e?.code === 'GAMEPLAY_ACTION_NOT_SUPPORTED' ? 400 : 500);
    const errCode = e?.code || 'GAMEPLAY_ACTION_FAILED';
    sendError(res, errCode, e?.message || String(e), code);
  }
});

module.exports = router;