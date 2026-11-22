const express = require('express');
const localSession = require('../services/localSessionService');
const voiceSettings = require('../services/voiceSettingsService');
const phraseCatalog = require('../voice/voicePhraseCatalog');
const { sendError } = require('../utils/http');

const router = express.Router();

function requireLoopback(req, res) {
  if (localSession.isLoopback(req)) return true;
  sendError(res, 'LOCAL_ONLY', '仅本机可读写语音设置', 403);
  return false;
}

router.get('/status', (req, res) => {
  if (!requireLoopback(req, res)) return;
  res.json(voiceSettings.status());
});

// 「语音开始」固定口令目录：前端从这里取，避免前后端各存一份定义。
// 读接口不做回环限制（远程模式下前端也要能渲染，只是入口隐藏、后端拒连）。
router.get('/phrases', (req, res) => {
  res.json({
    phrases: phraseCatalog.listPhrasesForApi(),
    defaultId: phraseCatalog.DEFAULT_VOICE_PHRASE_ID,
  });
});

router.post('/settings', (req, res) => {
  if (!requireLoopback(req, res)) return;
  const { route, api_key, tako_api_key, tako_proxy, siliconflow_api_key } = req.body || {};
  if (route !== undefined && !voiceSettings.ROUTES.includes(route)) {
    return sendError(res, 'BAD_ROUTE', 'route 只能是 own_key 或 panel', 400);
  }
  if (tako_proxy !== undefined && tako_proxy) {
    try {
      const url = new URL(tako_proxy);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
    } catch {
      return sendError(res, 'BAD_PROXY', 'Tako 代理必须是 HTTP 或 HTTPS 地址', 400);
    }
  }
  res.json(voiceSettings.update({ route, api_key, tako_api_key, tako_proxy, siliconflow_api_key }));
});

module.exports = router;
