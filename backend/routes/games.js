const express = require('express');
const router = express.Router();
const multer = require('multer');
const { sendError } = require('../utils/http');
const gameService = require('../services/gameService');
const gameplayService = require('../services/gameplayService');
const configService = require('../services/gameConfigService');

const upload = multer({ storage: multer.memoryStorage() });

// 1) 列出所有游戏
router.get('/', (req, res) => {
  try {
    const rows = gameService.listGames();
    res.json(rows || []);
  } catch (e) {
    sendError(res, 'GAMES_LIST_FAILED', e?.message || String(e), 500);
  }
});

// 2) 查询单个游戏
router.get('/:id', (req, res) => {
  try {
    const id = req.params.id;
    const g = gameService.getGameById(id);
    if (!g) return sendError(res, 'GAME_NOT_FOUND', '游戏不存在', 404);
    res.json(g);
  } catch (e) {
    sendError(res, 'GAME_DETAIL_FAILED', e?.message || String(e), 500);
  }
});

// 2.1) 查询玩法元信息（从玩法文件读取 requiredDevices/参数等）
router.get('/:id/meta', (req, res) => {
  try {
    const id = req.params.id;
    const g = gameService.getGameById(id);
    if (!g) return sendError(res, 'GAME_NOT_FOUND', '游戏不存在', 404);
    const meta = gameplayService.getGameplayMeta(g.configPath);
    res.json(meta);
  } catch (e) {
    const code = e?.code === 'GAMEPLAY_PATH_INVALID' ? 400 : 500;
    const errCode = e?.code || 'GAME_META_FAILED';
    sendError(res, errCode, e?.message || String(e), code);
  }
});

router.get('/:id/config', (req, res) => {
  try {
    const id = req.params.id;
    const g = gameService.getGameById(id);
    if (!g) return sendError(res, 'GAME_NOT_FOUND', '游戏不存在', 404);
    const params = configService.getParametersForGame(id);
    res.json(params || null);
  } catch (e) {
    sendError(res, 'GAME_CONFIG_READ_FAILED', e?.message || String(e), 500);
  }
});

// 3) 启动游戏：加载玩法文件并进入运行循环
router.post('/:id/start', (req, res) => {
  try {
    const id = req.params.id;
    const g = gameService.getGameById(id);
    if (!g) return sendError(res, 'GAME_NOT_FOUND', '游戏不存在', 404);

    const { deviceMapping = {}, parameters = {} } = req.body || {};
    const result = gameplayService.startGameplay(g.configPath, deviceMapping, parameters);
    try { configService.saveParametersForGame(id, parameters); } catch (_) {}
    res.json({ ok: true, result, status: gameplayService.status() });
  } catch (e) {
    const code = e?.code === 'GAMEPLAY_ALREADY_RUNNING' ? 409 : 500;
    const errCode = e?.code === 'GAMEPLAY_ALREADY_RUNNING' ? 'GAME_ALREADY_RUNNING' : 'GAME_START_FAILED';
    sendError(res, errCode, e?.message || String(e), code);
  }
});

// 4) 上传游戏（单个 .js 文件）
router.post('/upload', upload.single('file'), (req, res) => {
  try {
    const file = req.file;
    if (!file) return sendError(res, 'GAME_FILE_INVALID', '缺少文件字段 file', 400);
    const originalName = file.originalname || 'game.js';
    if (!/\.js$/i.test(originalName)) return sendError(res, 'GAME_FILE_INVALID', '仅支持 .js 文件', 400);
    const game = gameService.saveUploadedJs({ originalName, buffer: file.buffer });
    res.json({ ok: true, game });
  } catch (e) {
    const code = e?.code === 'GAME_FILE_INVALID' ? 'GAME_FILE_INVALID' : 'GAME_UPLOAD_FAILED';
    sendError(res, code, e?.message || String(e), 500);
  }
});

// 5) 删除某个游戏（可选删除物理文件）
router.delete('/:id', (req, res) => {
  try {
    const id = req.params.id;
    const removeFile = ['1', 'true', 'yes'].includes(String(req.query.removeFile || '').toLowerCase());
    const result = gameService.deleteGameById(id, { removeFile });
    if (result.notFound) return sendError(res, 'GAME_NOT_FOUND', '游戏不存在', 404);
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 'GAME_DELETE_FAILED', e?.message || String(e), 500);
  }
});

// 6) 重新加载（从目录扫描）
router.post('/reload', (req, res) => {
  try {
    const payload = gameService.reloadGames();
    res.json(payload);
  } catch (e) {
    sendError(res, 'GAMES_RELOAD_FAILED', e?.message || String(e), 500);
  }
});

// 7) 停止当前运行的游戏
router.post('/stop-current', (req, res) => {
  try {
    const result = gameplayService.stopGameplay();
    res.json({ ok: true, result, status: gameplayService.status() });
  } catch (e) {
    sendError(res, 'GAME_STOP_FAILED', e?.message || String(e), 500);
  }
});

// 8) 查询玩法运行状态
router.get('/status', (req, res) => {
  try {
    res.json(gameplayService.status());
  } catch (e) {
    sendError(res, 'GAME_STATUS_FAILED', e?.message || String(e), 500);
  }
});

module.exports = router;
