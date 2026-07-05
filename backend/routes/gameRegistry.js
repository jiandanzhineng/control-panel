// gameRegistry.js — 远程游戏仓库（play-registry）API。
// 挂在 /api/game-registry。后端代拉 registry.json（规避浏览器 CORS、便于国内直连 OSS）。
const express = require('express');
const router = express.Router();
const { sendError } = require('../utils/http');
const registry = require('../services/gameRegistryService');

// 列表（每条 gamePath 已预解析为 /games/proxy/...）
router.get('/', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const data = await registry.listForClient({ force });
    res.json(data);
  } catch (e) {
    sendError(res, 'REGISTRY_LIST_FAILED', e?.message || String(e), 502);
  }
});

// 本地兜底 vs registry 的版本差
router.get('/check-updates', async (req, res) => {
  try {
    res.json(await registry.checkUpdates());
  } catch (e) {
    sendError(res, 'REGISTRY_CHECK_FAILED', e?.message || String(e), 500);
  }
});

// 读 / 写源 URL（换源 = 换信任根，前端改源需二次确认）
router.get('/source', (req, res) => {
  res.json({ url: registry.getSource(), default: registry.DEFAULT_SOURCE });
});

router.put('/source', (req, res) => {
  try {
    const url = String((req.body || {}).url || '').trim();
    if (!url) return sendError(res, 'INVALID_SOURCE', '需提供 url', 400);
    const next = registry.setSource(url);
    res.json({ url: next });
  } catch (e) {
    sendError(res, 'INVALID_SOURCE', e?.message || String(e), 400);
  }
});

// 单条详情（供 PlayConfigView，避免每次进配置页重抓远程 HTML）
router.get('/:id', async (req, res) => {
  try {
    const g = await registry.getGameById(req.params.id);
    if (!g) return sendError(res, 'REGISTRY_GAME_NOT_FOUND', '远程仓库无此游戏', 404);
    res.json(g);
  } catch (e) {
    sendError(res, 'REGISTRY_DETAIL_FAILED', e?.message || String(e), 502);
  }
});

module.exports = router;
