// 本地模型运行时入口：目录、下载、设备探测、推理子进程和任务路由的装配。
const logService = require('../services/logService');
const { loadCatalog } = require('./catalog');
const { catalogDir, modelsRoot } = require('./paths');
const settings = require('./settings');
const engine = require('./engines/sherpaOnnxEngine');
const { ModelStore } = require('./modelStore');
const { Accelerators } = require('./accelerators');
const { WorkerHost } = require('./workerHost');
const { TaskRouter } = require('./taskRouter');

function buildCatalog(dir) {
  const { models, invalid } = loadCatalog(dir);
  for (const item of invalid) {
    logService.warn('ModelRuntime', `模型目录条目无效 ${item.file}: ${item.errors.join('; ')}`);
  }
  const map = new Map(models.map((model) => [model.id, model]));
  return {
    list: () => models.slice(),
    get: (id) => map.get(id) || null,
    invalid,
  };
}

function createRuntime(options = {}) {
  const catalog = options.catalog || buildCatalog(options.catalogDir || catalogDir());
  const modelStore = new ModelStore({
    catalog,
    rootDir: options.rootDir || modelsRoot(),
    fetchImpl: options.fetchImpl || globalThis.fetch,
  });
  const accelerators = new Accelerators({
    engine, catalog, cachePath: options.acceleratorCachePath,
  });
  const workerHost = options.workerHost || new WorkerHost({ logger: logService, idleMs: options.idleMs });
  const router = new TaskRouter({
    catalog, modelStore, settings, accelerators, workerHost, engine,
    cloudHandlers: options.cloudHandlers || new Map(),
    now: options.now,
  });
  modelStore.onReady = (model) => {
    settings.markDownloaded(model.task);
    logService.info('ModelRuntime', `model ready id=${model.id} task=${model.task}`);
  };
  modelStore.onRemove = (model) => {
    logService.info('ModelRuntime', `model removed id=${model.id}`);
    return workerHost.killModel(model.id);
  };
  modelStore.refreshFromDisk();
  accelerators.probeAll();
  logService.info('ModelRuntime', `catalog dir=${options.catalogDir || catalogDir()} models=${catalog.list().length}`);
  return { catalog, modelStore, accelerators, workerHost, router, engine };
}

const runtime = createRuntime();

module.exports = {
  createRuntime,
  catalog: runtime.catalog,
  modelStore: runtime.modelStore,
  accelerators: runtime.accelerators,
  workerHost: runtime.workerHost,
  engine: runtime.engine,
  router: runtime.router,
  run: (task, input, opts) => runtime.router.run(task, input, opts),
  localStatus: (task) => runtime.router.localStatus(task),
  warmUp: (task) => runtime.router.warmUp(task),
  registerCloudHandler: (task, handler) => runtime.router.registerCloud(task, handler),
  getSettings: (task) => settings.get(task),
  allSettings: () => settings.all(),
  updateSettings: (task, patch) => settings.update(task, patch),
  removeModel: (id) => runtime.modelStore.remove(id),
  status: () => ({
    models: runtime.modelStore.list(),
    settings: settings.all(),
    accelerators: runtime.accelerators.probeAll(),
    acceleratorState: runtime.accelerators.refreshState,
    workers: runtime.workerHost.status(),
    last: {
      provider: runtime.router.lastProvider,
      latencyMs: runtime.router.lastLatencyMs,
    },
  }),
  refreshAccelerators: () => runtime.accelerators.refresh(),
  benchmarks: () => {
    const out = {};
    for (const model of runtime.catalog.list()) out[model.id] = runtime.accelerators.benchmarks(model.id);
    return out;
  },
  _runtime: runtime,
};
