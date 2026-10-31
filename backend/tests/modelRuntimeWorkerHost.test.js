const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkerHost } = require('../model-runtime/workerHost');

const FAKE_WORKER = `
process.send({ type: 'ready' });
let active = 0;
let max = 0;
process.on('message', (m) => {
  if (!m || m.type !== 'transcribe') return;
  active += 1;
  max = Math.max(max, active);
  if (m.audio === 'crash') process.exit(3);
  const delay = m.audio === 'slow' ? 5000 : ({ one: 60, two: 30 }[m.audio] || 10);
  setTimeout(() => {
    active -= 1;
    process.send({ id: m.id, ok: true, text: m.audio, ms: delay, max });
  }, delay);
});
`;

describe('WorkerHost', () => {
  let dir;
  let script;
  let host;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-worker-'));
    script = path.join(dir, 'fake-worker.js');
    fs.writeFileSync(script, FAKE_WORKER);
  });
  afterEach(() => {
    host?.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeHost(options = {}) {
    host = new WorkerHost({ workerPath: script, idleMs: 60000, ...options });
    return host;
  }

  test('runs requests serially in arrival order', async () => {
    makeHost();
    const results = await Promise.all([
      host.request('demo|cpu', { audio: 'one' }),
      host.request('demo|cpu', { audio: 'two' }),
      host.request('demo|cpu', { audio: 'three' }),
    ]);
    expect(results.map((r) => r.text)).toEqual(['one', 'two', 'three']);
  });

  test('times out a stuck request and serves the next one from a fresh process', async () => {
    makeHost();
    await expect(host.request('demo|cpu', { audio: 'slow' }, { timeoutMs: 200 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    const result = await host.request('demo|cpu', { audio: 'fast' }, { timeoutMs: 3000 });
    expect(result.text).toBe('fast');
  });

  test('restarts the worker after a crash', async () => {
    makeHost();
    await expect(host.request('demo|cpu', { audio: 'crash' }, { timeoutMs: 3000 }))
      .rejects.toMatchObject({ code: 'WORKER_CRASHED' });
    const result = await host.request('demo|cpu', { audio: 'recovered' }, { timeoutMs: 3000 });
    expect(result.text).toBe('recovered');
  });

  test('exits an idle worker', async () => {
    makeHost({ idleMs: 120 });
    const key = 'demo|cpu';
    await host.request(key, { audio: 'quick' }, { timeoutMs: 3000 });
    expect(host.status()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(host.status()).toHaveLength(0);
  });

  test('prefetch loads the worker without running a request', async () => {
    makeHost();
    await host.prefetch('demo|cpu');
    expect(host.status()[0]).toMatchObject({ ready: true, busy: false, queued: 0 });
    const result = await host.request('demo|cpu', { audio: 'after-prefetch' });
    expect(result.text).toBe('after-prefetch');
  });
});
