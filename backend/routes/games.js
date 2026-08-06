const express = require('express');
const router = express.Router();
const { sendError } = require('../utils/http');
const gameService = require('../services/gameService');
const gameCacheService = require('../services/gameCacheService');
const bridgeService = require('../services/bridgeService');

// 抓取第三方游戏网页，解析内联 game-manifest，返回与本地游戏一致的结构
// 必须在 /:id 之前注册，避免被参数路由捕获
router.get('/external/meta', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return sendError(res, 'INVALID_URL', '需提供合法的 http(s) URL', 400);
  }
  try {
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) {
      return sendError(res, 'EXTERNAL_FETCH_FAILED', `抓取失败: HTTP ${resp.status}`, 502);
    }
    const html = await resp.text();
    const manifest = gameService.extractManifestFromHtml(html);
    if (!manifest) {
      return sendError(res, 'NO_MANIFEST', '该网页未包含 game-manifest 元数据', 422);
    }
    const u = new URL(resp.url || url);
    res.json({
      id: manifest.id || u.hostname,
      name: manifest.title || u.hostname,
      description: manifest.description || '',
      howTo: typeof manifest.howTo === 'string' ? manifest.howTo : '',
      version: manifest.version || '1.0.0',
      devices: manifest.devices || [],
      params: manifest.params || [],
      // 前缀式代理路径，前端据此拼 iframe src（同源化）。
      // 含协议段 <http|https>，使本机/局域网 http 游戏站也能被代理。
      gamePath: `/games/proxy/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}`,
      externalUrl: resp.url || url,
      external: true,
    });
  } catch (e) {
    sendError(res, 'EXTERNAL_META_FAILED', e?.message || String(e), 502);
  }
});

router.get('/', (req, res) => {
  try {
    res.json(gameService.listGames());
  } catch (e) {
    sendError(res, 'GAMES_LIST_FAILED', e?.message || String(e), 500);
  }
});

router.get('/status', (req, res) => {
  res.json({ running: false });
});

router.post('/played', (req, res) => {
  try {
    const saved = gameService.savePlayedGame(req.body || {});
    res.json(saved);
  } catch (e) {
    const status = e?.code === 'INVALID_PLAYED_GAME' ? 400 : 500;
    sendError(res, e?.code || 'GAME_PLAYED_SAVE_FAILED', e?.message || String(e), status);
  }
});

router.get('/:id', (req, res) => {
  try {
    const g = gameService.getGameById(req.params.id);
    if (!g) return sendError(res, 'GAME_NOT_FOUND', '游戏不存在', 404);
    res.json(g);
  } catch (e) {
    sendError(res, 'GAME_DETAIL_FAILED', e?.message || String(e), 500);
  }
});

router.get('/:id/meta', (req, res) => {
  try {
    const g = gameService.getGameById(req.params.id);
    if (!g) return sendError(res, 'GAME_NOT_FOUND', '游戏不存在', 404);
    res.json({ devices: g.devices || [], params: g.params || [] });
  } catch (e) {
    sendError(res, 'GAME_META_FAILED', e?.message || String(e), 500);
  }
});

router.post('/:id/start', (req, res) => {
  try {
    const g = gameService.getGameById(req.params.id);
    if (!g) return sendError(res, 'GAME_NOT_FOUND', '游戏不存在', 404);
    const { deviceMapping = {}, parameters = {} } = req.body || {};
    const normalizedMap = {};
    for (const [k, v] of Object.entries(deviceMapping)) {
      normalizedMap[k] = Array.isArray(v) ? v : (v ? [v] : []);
    }
    res.json({
      ok: true,
      gamePath: g.gamePath,
      deviceMap: normalizedMap,
      params: parameters,
    });
  } catch (e) {
    sendError(res, 'GAME_START_FAILED', e?.message || String(e), 500);
  }
});

router.post('/stop-current', (req, res) => {
  try {
    res.json(bridgeService.exitCurrent());
  } catch (e) {
    sendError(res, 'GAME_STOP_FAILED', e?.message || String(e), 500);
  }
});

router.post('/reload', (req, res) => {
  try {
    res.json(gameService.reloadGames());
  } catch (e) {
    sendError(res, 'GAMES_RELOAD_FAILED', e?.message || String(e), 500);
  }
});

router.delete('/:id', (req, res) => {
  try {
    const removeFile = ['1', 'true'].includes(String(req.query.removeFile || '').toLowerCase());
    const game = gameService.getGameById(req.params.id);
    if (!game) return sendError(res, 'GAME_NOT_FOUND', '游戏不存在', 404);
    if (removeFile && (
      game.cached === true
      || String(game.gamePath || '').startsWith('/games/cache/')
      || String(game.localGamePath || '').startsWith('/games/cache/')
    )) {
      gameCacheService.deleteGameCaches(game.id);
    }
    gameService.deleteGameById(req.params.id, { removeFile });
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 'GAME_DELETE_FAILED', e?.message || String(e), 500);
  }
});

module.exports = router;
