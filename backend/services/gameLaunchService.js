// 启动 / 停止一次玩法。抽出来供 HTTP 路由与客户端控制（/api/client/games/:id/launch）复用，
// 保证「用户在界面点开始」与「agent 启动」走同一条路径（含远程占用登记、停本机其它载体）。
const gameService = require('./gameService');
const bridgeService = require('./bridgeService');
const gameHost = require('../game-runtime/gameHostService');
const remoteSession = require('./remoteSessionService');
const gameLaunchTokenService = require('./gameLaunchTokenService');
const localAppProcessService = require('./localAppProcessService');

async function occupyRemotePlay(id, game) {
  if (!remoteSession.isOperatorRemoteMode()) return null;
  return remoteSession.occupyPlay({ gameId: id, gameName: game?.name || game?.title || id });
}

async function releaseRemotePlay(id) {
  if (!remoteSession.isOperatorRemoteMode()) return;
  if (!remoteSession.localPlay?.()) return;
  await remoteSession.releasePlay({ gameId: id }).catch(() => {});
}

function normalizeDeviceMap(deviceMapping = {}) {
  const normalized = {};
  if (!deviceMapping || typeof deviceMapping !== 'object' || Array.isArray(deviceMapping)) return normalized;
  for (const [key, value] of Object.entries(deviceMapping)) {
    normalized[key] = Array.isArray(value) ? value : (value ? [value] : []);
  }
  return normalized;
}

/**
 * 启动一次玩法（与 POST /api/games/:id/start 同语义）。
 * @returns {Promise<object>} 路由原回包（ok/gamePath/deviceMap/params/runtime）
 */
async function startGame({
  gameId,
  deviceMapping = {},
  parameters = {},
  source = 'local',
  defer = false,
  gamePath = null,
  externalUrl = null,
  agentClientId = null,
} = {}) {
  const id = String(gameId || '').trim();
  const normalizedMap = normalizeDeviceMap(deviceMapping);
  const game = id ? gameService.getGameById(id) : null;

  if (id && gameHost.isHostGame(id)) {
    if (defer) {
      return {
        ok: true,
        deferred: true,
        deviceMap: normalizedMap,
        params: parameters,
        runtime: { mode: 'host', gameId: id },
      };
    }
    await occupyRemotePlay(id, game);
    await localAppProcessService.stopAll();
    try { bridgeService.exitCurrent(); } catch (_) {}
    const started = gameHost.start({
      gameId: id,
      deviceMap: normalizedMap,
      params: parameters,
      source,
      agentClientId,
    });
    return {
      ok: true,
      gamePath: game?.gamePath || null,
      deviceMap: started.deviceMap,
      params: started.snapshot?.params || parameters,
      runtime: { mode: 'host', ...started },
    };
  }

  if (!game && !gamePath && !externalUrl) {
    const error = new Error('游戏不存在');
    error.code = 'GAME_NOT_FOUND';
    throw error;
  }
  await occupyRemotePlay(id, game);
  await localAppProcessService.stopAll();
  // 页面游戏云存档的 gameId 由宿主持有：签发一次启动令牌，前端拼进 iframe URL。
  // 只给已登记的游戏签令牌（未登记的外部页面不带云存档身份），与原路由一致。
  const gameToken = gameLaunchTokenService.issue(game?.id, { agentClientId });
  return {
    ok: true,
    gamePath: game?.gamePath || gamePath || null,
    deviceMap: normalizedMap,
    params: parameters,
    runtime: gameToken ? { mode: 'iframe', gameToken } : { mode: 'iframe' },
  };
}

/** 停当前玩法（与 POST /api/games/stop-current 同语义）。 */
async function stopCurrentPlay({ gameId = null, reason = 'explicit-exit' } = {}) {
  await releaseRemotePlay(gameId);
  await localAppProcessService.stopAll();
  const host = gameHost.stop({ reason });
  const bridge = bridgeService.exitCurrent();
  return { ...bridge, host };
}

module.exports = {
  startGame,
  stopCurrentPlay,
  normalizeDeviceMap,
};
