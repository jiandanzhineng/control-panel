// 任务路由：选模型 → 选设备 → 本地推理 → 失败回退云端；连续失败熔断 60 秒。
const logService = require('../services/logService');

const CIRCUIT_FAILURES = 3;
const CIRCUIT_MS = 60 * 1000;

function baseTask(task) { return String(task || '').split('.')[0]; }

// 音频问题和主动停止不代表设备不可用，不计入连续失败。
function countableFailure(error) {
  return !['BAD_AUDIO', 'WORKER_KILLED', 'ABORTED'].includes(error?.code);
}

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function silenceWav(seconds = 4, sampleRate = 16000) {
  const samples = sampleRate * seconds;
  const pcm = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString('base64');
}

class TaskRouter {
  constructor({ catalog, modelStore, settings, accelerators, workerHost, engine,
    cloudHandlers = new Map(), logger = logService, now = Date.now } = {}) {
    this.catalog = catalog;
    this.modelStore = modelStore;
    this.settings = settings;
    this.accelerators = accelerators;
    this.workerHost = workerHost;
    this.engine = engine;
    this.cloudHandlers = cloudHandlers;
    this.logger = logger;
    this.now = now;
    this.localFailures = 0;
    this.circuitUntil = 0;
    this.lastProvider = null;
    this.lastLatencyMs = null;
    this.warming = new Map();
  }

  registerCloud(task, handler) { this.cloudHandlers.set(task, handler); }

  circuitOpen() { return this.localFailures >= CIRCUIT_FAILURES && this.now() < this.circuitUntil; }

  _recordFailure() {
    this.localFailures += 1;
    if (this.localFailures >= CIRCUIT_FAILURES) this.circuitUntil = this.now() + CIRCUIT_MS;
  }

  _resetFailures() { this.localFailures = 0; this.circuitUntil = 0; }

  selectModel(task, explicit, taskSettings) {
    const group = baseTask(task);
    const candidates = [explicit, taskSettings?.model].filter(Boolean);
    for (const id of candidates) {
      const model = this.catalog.get(id);
      if (model && model.task === group && this.modelStore.isReady(id)) return model;
    }
    const fallback = this.catalog.list().find((m) => m.task === group && m.recommended && this.modelStore.isReady(m.id));
    return fallback || null;
  }

  async run(task, input, opts = {}) {
    const taskSettings = this.settings.get(baseTask(task));
    const model = this.selectModel(task, opts.model, taskSettings);
    let localError = null;
    const shouldTryLocal = taskSettings.localEnabled && model && !this.circuitOpen();
    if (shouldTryLocal) {
      try {
        const result = await this._runTaskLocal(task, model, taskSettings, input, opts);
        logService.info('ModelRuntime', `task=${task} mode=local model=${model.id} provider=${result.provider} ms=${result.latencyMs}`);
        return result;
      } catch (error) {
        localError = error;
        this._recordFailure();
        logService.warn('ModelRuntime', `task=${task} local_failed code=${error?.code || 'ERROR'} fallback=1: ${error?.message || error}`);
      }
    }
    const cloud = this.cloudHandlers.get(task);
    if (!cloud) {
      if (localError) throw localError;
      throw makeError('NO_LOCAL', '本地模型不可用，且没有可用的云端通道');
    }
    let result;
    try {
      result = await cloud(input, opts);
    } catch (cloudError) {
      if (localError) throw localError;
      throw cloudError;
    }
    if (localError) {
      logService.info('ModelRuntime', `task=${task} mode=${result.mode} fallback=1 ms=${result.latencyMs ?? '-'}`);
    }
    return { ...result, fallback: Boolean(localError) };
  }

  async _runTaskLocal(task, model, taskSettings, input, opts) {
    if (!input || !input.audio) throw makeError('BAD_AUDIO', '音频为空');
    const order = this.accelerators.orderForModel(model.id, taskSettings.provider);
    let lastError = null;
    for (const provider of order) {
      try {
        const started = this.now();
        const startEnv = this.engine.workerEnv(model, this.modelStore.modelDir(model.id), provider);
        const result = await this.workerHost.request(`${model.id}|${provider}`, { audio: input.audio }, {
          timeoutMs: opts.timeoutMs, startEnv,
        });
        const latencyMs = this.now() - started;
        this._resetFailures();
        this.lastProvider = provider;
        this.lastLatencyMs = latencyMs;
        return { text: result.text, mode: 'local', model: model.id, provider, latencyMs, fallback: false };
      } catch (error) {
        lastError = error;
        if (countableFailure(error)) this.accelerators.recordFailure(model.id, provider);
        logService.warn('ModelRuntime', `task=${task} local provider=${provider} failed code=${error?.code || 'ERROR'}: ${error?.message || error}`);
      }
    }
    throw lastError || makeError('NO_LOCAL', '没有可用的本地推理设备');
  }

  /** 状态查询时预热：加载模型，自动模式下顺便基准测试各设备。 */
  warmUp(task) {
    if (this.warming.has(task)) return this.warming.get(task);
    const promise = (async () => {
      const taskSettings = this.settings.get(baseTask(task));
      const model = this.selectModel(task, null, taskSettings);
      if (!taskSettings.localEnabled || !model) return;
      const order = this.accelerators.orderForModel(model.id, taskSettings.provider);
      if (taskSettings.provider === 'auto' && order.length > 1) {
        await this._benchmarkProviders(model, order);
      }
      const preferred = this.accelerators.orderForModel(model.id, taskSettings.provider);
      const provider = preferred[0];
      if (!provider) return;
      const startEnv = this.engine.workerEnv(model, this.modelStore.modelDir(model.id), provider);
      await this.workerHost.prefetch(`${model.id}|${provider}`, startEnv);
    })().finally(() => { this.warming.delete(task); });
    this.warming.set(task, promise);
    return promise;
  }

  async _benchmarkProviders(model, order) {
    const sample = silenceWav(4);
    for (const provider of order) {
      if (this.accelerators.benchmarkFor(model.id, provider)) continue;
      try {
        const startEnv = this.engine.workerEnv(model, this.modelStore.modelDir(model.id), provider);
        const started = this.now();
        await this.workerHost.request(`${model.id}|${provider}`, { audio: sample }, { timeoutMs: 5000, startEnv });
        this.accelerators.recordBenchmark(model.id, provider, this.now() - started);
      } catch (error) {
        if (countableFailure(error)) this.accelerators.recordFailure(model.id, provider);
        logService.warn('ModelRuntime', `benchmark model=${model.id} provider=${provider} failed: ${error?.message || error}`);
      }
    }
  }

  localStatus(task) {
    const taskSettings = this.settings.get(baseTask(task));
    const model = this.selectModel(task, null, taskSettings);
    if (!taskSettings.localEnabled || !model || this.circuitOpen()) return null;
    const provider = this.lastProvider || this.accelerators.orderForModel(model.id, taskSettings.provider)[0];
    setImmediate(() => { this.warmUp(task).catch(() => {}); });
    return { ready: true, mode: 'local', model: model.id, provider, modelTitle: model.title };
  }
}

module.exports = { TaskRouter, silenceWav, baseTask, CIRCUIT_FAILURES, CIRCUIT_MS };


