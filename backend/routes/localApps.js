const express = require('express');
const router = express.Router();
const { sendError } = require('../utils/http');
const localAppService = require('../services/localAppService');
const localAppProcessService = require('../services/localAppProcessService');

function sendServiceError(res, error, fallbackCode) {
  sendError(
    res,
    error?.code || fallbackCode,
    error?.message || String(error),
    error?.status || 500,
  );
}

router.get('/', async (req, res) => {
  try {
    res.json(await localAppService.listApps());
  } catch (error) {
    sendServiceError(res, error, 'LOCAL_APP_LIST_FAILED');
  }
});

router.get('/:id/status', async (req, res) => {
  try {
    const status = await localAppService.getStatus(req.params.id);
    res.json({ ...status, process: localAppProcessService.getRunning(req.params.id) });
  } catch (error) {
    sendServiceError(res, error, 'LOCAL_APP_STATUS_FAILED');
  }
});

router.post('/:id/sync', async (req, res) => {
  try {
    const status = await localAppService.syncApp(req.params.id);
    res.json(status);
  } catch (error) {
    sendServiceError(res, error, 'LOCAL_APP_SYNC_FAILED');
  }
});

router.post('/:id/start', async (req, res) => {
  try {
    res.json(await localAppProcessService.startApp(req.params.id));
  } catch (error) {
    sendServiceError(res, error, 'LOCAL_APP_START_FAILED');
  }
});

router.post('/:id/stop', async (req, res) => {
  try {
    res.json(await localAppProcessService.stopApp(req.params.id));
  } catch (error) {
    sendServiceError(res, error, 'LOCAL_APP_STOP_FAILED');
  }
});

module.exports = router;
