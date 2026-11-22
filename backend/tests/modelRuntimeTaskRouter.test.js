const { TaskRouter, CIRCUIT_FAILURES } = require('../model-runtime/taskRouter');

const MODEL = {
  id: 'sense', task: 'asr', recommended: true,
  title: { zh: 'S', en: 'S' }, files: [], providers: ['cuda', 'cpu'],
};

function makeCatalog() {
  const models = [MODEL, { ...MODEL, id: 'other', recommended: false }];
  return { list: () => models, get: (id) => models.find((m) => m.id === id) || null };
}

function makeSettings(enabled = true, provider = 'auto', model = null) {
  const state = { localEnabled: enabled, provider, model, configured: true };
  return { get: () => ({ ...state }), update: (task, patch) => Object.assign(state, patch) };
}

class FakeAccelerators {
  constructor(order = ['cpu']) { this.order = order.slice(); this.bench = {}; this.failures = {}; }
  orderForModel() {
    const scored = this.order.filter((p) => this.bench[p]);
    const rest = this.order.filter((p) => !this.bench[p]);
    scored.sort((a, b) => this.bench[a].ms - this.bench[b].ms);
    return [...scored, ...rest];
  }
  benchmarkFor(id, provider) { return this.bench[provider] || null; }
  recordBenchmark(id, provider, ms) { this.bench[provider] = { ms }; }
  recordFailure(id, provider) { this.failures[provider] = (this.failures[provider] || 0) + 1; }
}

function makeWorkerHost(handler) {
  const calls = [];
  return {
    calls,
    prefetch: jest.fn(async () => {}),
    request: jest.fn(async (key, payload, opts) => {
      calls.push({ key, audio: payload.audio, timeoutMs: opts?.timeoutMs });
      return handler(key, payload);
    }),
  };
}

function makeRouter(overrides = {}) {
  const cloudCalls = [];
  const cloud = jest.fn(async () => {
    cloudCalls.push(1);
    return { text: 'cloud', mode: 'own_key', latencyMs: 12 };
  });
  const router = new TaskRouter({
    catalog: overrides.catalog || makeCatalog(),
    modelStore: overrides.modelStore || {
      isReady: (id) => id === 'sense',
      modelDir: (id) => `models/${id}`,
    },
    settings: overrides.settings || makeSettings(),
    accelerators: overrides.accelerators || new FakeAccelerators(),
    workerHost: overrides.workerHost || makeWorkerHost(() => ({ text: 'local' })),
    engine: { workerEnv: (model, dir, provider) => ({ MR_PROVIDER: provider, MR_MODEL_DIR: dir }) },
    cloudHandlers: new Map([['asr.transcribe', cloud]]),
    now: overrides.now || Date.now,
  });
  return { router, cloud, cloudCalls };
}

describe('TaskRouter', () => {
  test('uses the local model when enabled and ready', async () => {
    const { router, cloud } = makeRouter();
    const result = await router.run('asr.transcribe', { audio: 'x' }, { timeoutMs: 5000 });
    expect(result).toMatchObject({ text: 'local', mode: 'local', provider: 'cpu', fallback: false });
    expect(cloud).not.toHaveBeenCalled();
  });

  test('falls back to cloud for this request when local fails', async () => {
    const workerHost = makeWorkerHost(() => { throw Object.assign(new Error('boom'), { code: 'WORKER_CRASHED' }); });
    const { router, cloud } = makeRouter({ workerHost });
    const result = await router.run('asr.transcribe', { audio: 'x' }, { timeoutMs: 5000 });
    expect(result).toMatchObject({ text: 'cloud', mode: 'own_key', fallback: true });
    expect(cloud).toHaveBeenCalledTimes(1);
  });

  test('opens the circuit after three local failures and retries after 60s', async () => {
    let clock = 1000;
    const workerHost = makeWorkerHost(() => { throw new Error('down'); });
    const { router, cloud } = makeRouter({ workerHost, now: () => clock });
    for (let i = 0; i < CIRCUIT_FAILURES; i++) {
      expect((await router.run('asr.transcribe', { audio: 'x' }, {})).fallback).toBe(true);
    }
    expect(workerHost.request).toHaveBeenCalledTimes(CIRCUIT_FAILURES);
    clock += 1000;
    const skipped = await router.run('asr.transcribe', { audio: 'x' }, {});
    expect(skipped.fallback).toBe(false);
    expect(workerHost.request).toHaveBeenCalledTimes(CIRCUIT_FAILURES);
    clock += 60000;
    await router.run('asr.transcribe', { audio: 'x' }, {});
    expect(workerHost.request).toHaveBeenCalledTimes(CIRCUIT_FAILURES + 1);
    expect(cloud).toHaveBeenCalledTimes(CIRCUIT_FAILURES + 2);
  });

  test('auto mode benchmarks every provider during warmup, not on first transcribe', async () => {
    const acc = new FakeAccelerators(['cuda', 'cpu']);
    const workerHost = makeWorkerHost(() => ({ text: 'ok' }));
    const { router } = makeRouter({ accelerators: acc, workerHost });
    await router.warmUp('asr.transcribe');
    expect(workerHost.request).toHaveBeenCalledTimes(2);
    expect(Object.keys(acc.bench).sort()).toEqual(['cpu', 'cuda']);
    const benchmarkProviders = workerHost.calls.map((c) => c.key.split('|')[1]);
    expect(benchmarkProviders.sort()).toEqual(['cpu', 'cuda']);
    expect(workerHost.prefetch).toHaveBeenCalledTimes(1);

    await router.run('asr.transcribe', { audio: 'real' }, {});
    expect(workerHost.request).toHaveBeenCalledTimes(3);
  });

  test('does not count audio problems or killed workers as device failures', async () => {
    const acc = new FakeAccelerators(['cpu']);
    const workerHost = makeWorkerHost(() => {
      throw Object.assign(new Error('killed'), { code: 'WORKER_KILLED' });
    });
    const { router } = makeRouter({ accelerators: acc, workerHost });
    await router.run('asr.transcribe', { audio: 'x' }, {});
    expect(acc.failures.cpu).toBeUndefined();

    const badAudio = makeWorkerHost(() => {
      throw Object.assign(new Error('bad'), { code: 'BAD_AUDIO' });
    });
    const second = makeRouter({ accelerators: acc, workerHost: badAudio }).router;
    await second.run('asr.transcribe', { audio: 'x' }, {});
    expect(acc.failures.cpu).toBeUndefined();
  });

  test('tries the next device when one fails', async () => {
    const acc = new FakeAccelerators(['cuda', 'cpu']);
    acc.bench = { cuda: { ms: 10 }, cpu: { ms: 20 } };
    const workerHost = makeWorkerHost((key) => {
      if (key.endsWith('|cuda')) throw new Error('cuda bad');
      return { text: 'cpu-result' };
    });
    const { router } = makeRouter({ accelerators: acc, workerHost });
    const result = await router.run('asr.transcribe', { audio: 'x' }, {});
    expect(result).toMatchObject({ text: 'cpu-result', provider: 'cpu', fallback: false });
    expect(acc.failures.cuda).toBe(1);
  });

  test('does not use local when disabled and reports no fallback', async () => {
    const { router, cloud } = makeRouter({ settings: makeSettings(false) });
    const result = await router.run('asr.transcribe', { audio: 'x' }, {});
    expect(result.fallback).toBe(false);
    expect(cloud).toHaveBeenCalledTimes(1);
  });

  test('reports local status only when enabled, ready and not circuit-broken', () => {
    const { router } = makeRouter();
    expect(router.localStatus('asr.transcribe')).toMatchObject({ ready: true, mode: 'local', provider: 'cpu' });
    const off = makeRouter({ settings: makeSettings(false) }).router;
    expect(off.localStatus('asr.transcribe')).toBeNull();
  });
});
