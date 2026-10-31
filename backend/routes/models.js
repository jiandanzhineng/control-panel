// 本地模型运行时 HTTP 接口：目录/状态、下载、取消、删除、设备、任务设置。
const express = require('express');
const localSession = require('../services/localSessionService');
const modelRuntime = require('../model-runtime');
const { sendError } = require('../utils/http');

const router = express.Router();

function requireLoopback(req, res) {
  if (localSession.isLoopback(req)) return true;
  sendError(res, 'LOCAL_ONLY', '仅本机可管理本地模型', 403);
  return false;
}

function snapshot() {
  const list = modelRuntime.catalog.list().map((model) => ({ ...model, ...modelRuntime.modelStore.status(model.id) }));
  const settings = modelRuntime.allSettings();
  const accelerators = modelRuntime.accelerators.probeAll();
  const benchmarks = modelRuntime.benchmarks();
  const workers = modelRuntime.workerHost.status();
  return {
    models: list,
    settings,
    accelerators,
    acceleratorState: modelRuntime.accelerators.refreshState,
    benchmarks,
    last: {
      provider: modelRuntime.router.lastProvider,
      latencyMs: modelRuntime.router.lastLatencyMs,
    },
    workers,
  };
}

router.get('/', (req, res) => {
  if (!requireLoopback(req, res)) return;
  res.json(snapshot());
});

router.get('/accelerators', (req, res) => {
  if (!requireLoopback(req, res)) return;
  res.json({
    devices: modelRuntime.accelerators.probeAll(),
    state: modelRuntime.accelerators.refreshState,
    benchmarks: modelRuntime.benchmarks(),
  });
});

router.post('/accelerators/refresh', async (req, res) => {
  if (!requireLoopback(req, res)) return;
  try {
    const devices = await modelRuntime.refreshAccelerators();
    res.json({
      devices,
      state: modelRuntime.accelerators.refreshState,
      benchmarks: modelRuntime.benchmarks(),
    });
  } catch (error) {
    res.status(500).json({
      error: error?.message || String(error),
      state: modelRuntime.accelerators.refreshState,
    });
  }
});

router.get('/settings', (req, res) => {
  if (!requireLoopback(req, res)) return;
  res.json({ settings: modelRuntime.allSettings() });
});

router.post('/settings', (req, res) => {
  if (!requireLoopback(req, res)) return;
  const body = req.body || {};
  const tasks = body.tasks && typeof body.tasks === 'object' && !Array.isArray(body.tasks) ? body.tasks : body;
  const allowed = new Set(modelRuntime.catalog.list().map((model) => model.task));
  const updated = Object.create(null);
  for (const task of Object.keys(tasks)) {
    const patch = tasks[task];
    if (!allowed.has(task)) {
      return sendError(res, 'INVALID_TASK', `未知任务: ${task}`, 400);
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
    if (patch.model) {
      const model = modelRuntime.catalog.get(patch.model);
      if (!model || model.task !== task) {
        return sendError(res, 'BAD_MODEL', `模型 ${patch.model} 不属于任务 ${task}`, 400);
      }
    }
    updated[task] = modelRuntime.updateSettings(task, {
      localEnabled: patch.localEnabled,
      model: patch.model,
      provider: patch.provider,
    });
  }
  res.json({ settings: { ...modelRuntime.allSettings(), ...updated } });
});

router.post('/:id/download', (req, res) => {
  if (!requireLoopback(req, res)) return;
  try {
    res.json(modelRuntime.modelStore.download(req.params.id));
  } catch (error) {
    sendError(res, error.code || 'DOWNLOAD_FAILED', error.message, 404);
  }
});

router.post('/:id/cancel', (req, res) => {
  if (!requireLoopback(req, res)) return;
  res.json(modelRuntime.modelStore.cancel(req.params.id));
});

router.delete('/:id', async (req, res) => {
  if (!requireLoopback(req, res)) return;
  try {
    res.json(await modelRuntime.removeModel(req.params.id));
  } catch (error) {
    sendError(res, error.code || 'DELETE_FAILED', error.message, 404);
  }
});

module.exports = router;
module.exports.snapshot = snapshot;
