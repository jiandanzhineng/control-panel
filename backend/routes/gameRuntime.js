const express = require('express');
const gameHost = require('../game-runtime/gameHostService');
const coreResolver = require('../game-runtime/gameCoreResolver');
const bridgeService = require('../services/bridgeService');
const remoteSession = require('../services/remoteSessionService');
const { sendError } = require('../utils/http');

const router = express.Router();

// 已接入 HostRuntime 的游戏清单：单一解析器（内置 core + 游戏包里的分离式 core）
function hostGames() {
  return coreResolver.listHostGames();
}

// 画面同步（SSE）：先发一份全量 snapshot，之后只发有变化的 patch。
// 页面在 rev 断档时重开本流（见 docs/architecture/split-game-contract.md）。
function writeEvent(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  // 进流首帧：无论有没有会话都给全量（无会话时是 { active: false, ... }）
  writeEvent(res, { type: 'snapshot', ...gameHost.getStateEvent() });
  const unsubscribe = gameHost.subscribeState((event) => {
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

// 主控端远程模式下本机起 HostRuntime（被控端登记为一次远程占用，ADR-0004 玩法唯一性）。
// 被控端本地玩法运行中会以 HOST_PLAY_ACTIVE 拒绝 → 启动失败可见（不会顶掉本机玩法）。
async function occupyRemoteHostPlay(body) {
  if (!remoteSession.isOperatorRemoteMode()) return;
  const gameId = String(body?.gameId || '').trim();
  if (!gameId) return;
  await remoteSession.occupyPlay({ gameId, gameName: body?.title || gameId });
}

// 本机停止 HostRuntime（主控端 stop / 被控端本机停）：释放主控端登记的占用。
async function releaseRemoteHostPlay() {
  if (!remoteSession.isOperatorRemoteMode()) return;
  if (!remoteSession.localPlay?.()) return;
  await remoteSession.releasePlay({}).catch(() => {});
}

function handleError(res, error) {
  const code = error?.code || 'GAME_RUNTIME_ERROR';
  // 被控端本地玩法运行中：409，主控端界面据此显示「被控端正在运行本地玩法」
  const status = code === 'HOST_PLAY_ACTIVE' ? 409 : 400;
  return sendError(res, code, error?.message || '游戏运行失败', status);
}

router.get('/status', (req, res) => {
  res.json(gameHost.getStatus());
});

router.get('/games', (req, res) => {
  res.json(hostGames());
});

router.post('/start', async (req, res) => {
  try {
    const body = req.body || {};
    // 主控端远程模式：本机起 HostRuntime 前先在被控端登记占用（被拒则不启动，失败可见）
    await occupyRemoteHostPlay(body);
    await require('../services/localAppProcessService').stopAll();
    try { bridgeService.exitCurrent(); } catch (_) {}
    res.status(201).json(gameHost.start({
      gameId: body.gameId,
      deviceMap: body.deviceMap,
      params: body.params,
      source: body.source || 'local',
      agentClientId: req.agentClientId || null,
    }));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/params', (req, res) => {
  try {
    // agent 操作了用户局：把本局标记为 agent 控制，后续 tick 输出同样限幅
    if (req.agentClientId) gameHost.markAgentControl(req.agentClientId);
    res.json(gameHost.setParams(req.body?.params));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/action', (req, res) => {
  try {
    if (req.agentClientId) gameHost.markAgentControl(req.agentClientId);
    res.json(gameHost.action(req.body?.action, req.body?.payload));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/sensor', (req, res) => {
  try {
    if (req.agentClientId) gameHost.markAgentControl(req.agentClientId);
    res.json(gameHost.pushSensor(req.body || {}));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/tick', (req, res) => {
  try {
    if (req.agentClientId) gameHost.markAgentControl(req.agentClientId);
    const nowMs = req.body?.nowMs;
    res.json(gameHost.tick(Number.isFinite(Number(nowMs)) ? Number(nowMs) : undefined));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/stop', async (req, res) => {
  try {
    await releaseRemoteHostPlay();
    res.json(gameHost.stop({ reason: req.body?.reason || 'api-stop' }));
  } catch (error) {
    handleError(res, error);
  }
});

module.exports = router;
