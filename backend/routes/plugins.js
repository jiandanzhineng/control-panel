const express = require('express');
const router = express.Router();
const { sendError } = require('../utils/http');
const pluginService = require('../services/pluginService');

router.get('/', (req, res) => {
  try {
    res.json(pluginService.listPlugins());
  } catch (error) {
    sendError(res, 'PLUGINS_LIST_FAILED', error?.message || String(error), 500);
  }
});

router.get('/:id', (req, res) => {
  try {
    const plugin = pluginService.getPluginById(req.params.id);
    if (!plugin) return sendError(res, 'PLUGIN_NOT_FOUND', '插件不存在', 404);
    res.json(plugin);
  } catch (error) {
    sendError(res, 'PLUGIN_DETAIL_FAILED', error?.message || String(error), 500);
  }
});

router.post('/:id/activate', (req, res) => {
  try {
    const result = pluginService.activate(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    if (error?.code === 'PLUGIN_NOT_FOUND') {
      return sendError(res, 'PLUGIN_NOT_FOUND', error.message, 404);
    }
    sendError(res, 'PLUGIN_ACTIVATE_FAILED', error?.message || String(error), 500);
  }
});

module.exports = router;
