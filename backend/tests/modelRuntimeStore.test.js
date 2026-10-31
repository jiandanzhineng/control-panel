const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { ModelStore } = require('../model-runtime/modelStore');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function catalogOf(models) {
  const map = new Map(models.map((model) => [model.id, model]));
  return { list: () => models.slice(), get: (id) => map.get(id) || null };
}

function serve(files, { slow = false, onRange } = {}) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(String(req.url || '').replace(/^\//, ''));
    const buf = files[name];
    if (!buf) { res.statusCode = 404; res.end('missing'); return; }
    const range = req.headers.range;
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)?.[1] || 0);
      if (onRange) onRange(name, start);
      res.writeHead(206, {
        'Content-Length': buf.length - start,
        'Content-Range': `bytes ${start}-${buf.length - 1}/${buf.length}`,
        'Content-Type': 'application/octet-stream',
      });
      if (slow) return streamSlow(res, buf.subarray(start));
      res.end(buf.subarray(start));
      return;
    }
    res.writeHead(200, { 'Content-Length': buf.length, 'Content-Type': 'application/octet-stream' });
    if (slow) return streamSlow(res, buf);
    res.end(buf);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function streamSlow(res, buf) {
  let offset = 0;
  const timer = setInterval(() => {
    if (offset >= buf.length) { clearInterval(timer); res.end(); return; }
    const end = Math.min(offset + 8, buf.length);
    res.write(buf.subarray(offset, end));
    offset = end;
  }, 20);
  res.on('close', () => clearInterval(timer));
}

function makeModel(base, contents, overrides = {}) {
  return {
    id: 'demo',
    task: 'asr',
    title: { zh: '演示', en: 'Demo' },
    engine: 'sherpa-onnx',
    engineConfig: { type: 'sense_voice', model: 'a.bin', tokens: 'b.txt' },
    files: Object.entries(contents).map(([name, buf]) => ({
      name, bytes: buf.length, sha256: sha(buf), urls: [`${base}/${name}`],
    })),
    providers: ['cpu'],
    license: { name: 'MIT' },
    recommended: true,
    ...overrides,
  };
}

describe('ModelStore', () => {
  let dir;
  let servers;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-store-'));
    servers = [];
  });
  afterEach(async () => {
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function start(files, opts) {
    const s = await serve(files, opts);
    servers.push(s.server);
    return s;
  }

  test('downloads all files, verifies sha256 and reports ready', async () => {
    const contents = { 'a.bin': Buffer.alloc(4096, 7), 'b.txt': Buffer.from('hello') };
    const { base } = await start(contents);
    const onReady = jest.fn();
    const store = new ModelStore({
      catalog: catalogOf([makeModel(base, contents)]), rootDir: dir, fetchImpl: fetch, onReady,
    });
    const status = await store.downloadAsync('demo');
    expect(status).toMatchObject({ state: 'ready', received: 4101, total: 4101 });
    expect(fs.readFileSync(path.join(dir, 'demo', 'a.bin')).equals(contents['a.bin'])).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  test('resumes a partial .part file with a Range request', async () => {
    const contents = { 'a.bin': Buffer.alloc(8192, 9), 'b.txt': Buffer.from('tok') };
    const ranges = [];
    const { base } = await start(contents, { onRange: (name, start) => ranges.push([name, start]) });
    const model = makeModel(base, contents);
    const part = path.join(dir, 'demo', 'a.bin.part');
    fs.mkdirSync(path.dirname(part), { recursive: true });
    fs.writeFileSync(part, contents['a.bin'].subarray(0, 3000));
    const store = new ModelStore({ catalog: catalogOf([model]), rootDir: dir, fetchImpl: fetch });
    const status = await store.downloadAsync('demo');
    expect(ranges).toContainEqual(['a.bin', 3000]);
    expect(status.state).toBe('ready');
    expect(fs.readFileSync(path.join(dir, 'demo', 'a.bin')).equals(contents['a.bin'])).toBe(true);
  });

  test('falls back to the next url when one fails', async () => {
    const contents = { 'a.bin': Buffer.from('fallback-data'), 'b.txt': Buffer.from('t') };
    const { base } = await start(contents);
    const model = makeModel(base, contents);
    model.files[0].urls = [`${base}/missing`, `${base}/a.bin`];
    const store = new ModelStore({ catalog: catalogOf([model]), rootDir: dir, fetchImpl: fetch });
    const status = await store.downloadAsync('demo');
    expect(status.state).toBe('ready');
    expect(fs.readFileSync(path.join(dir, 'demo', 'a.bin')).toString()).toBe('fallback-data');
  });

  test('deletes the file and reports error when sha256 does not match', async () => {
    const contents = { 'a.bin': Buffer.from('actual'), 'b.txt': Buffer.from('t') };
    const { base } = await start(contents);
    const model = makeModel(base, contents);
    model.files[0].sha256 = 'f'.repeat(64);
    const store = new ModelStore({ catalog: catalogOf([model]), rootDir: dir, fetchImpl: fetch });
    const status = await store.downloadAsync('demo');
    expect(status.state).toBe('error');
    expect(status.error).toMatch(/校验失败/);
    expect(fs.existsSync(path.join(dir, 'demo', 'a.bin.part'))).toBe(false);
  });

  test('cancels an in-flight download and keeps the partial file', async () => {
    const contents = { 'a.bin': Buffer.alloc(4000, 3), 'b.txt': Buffer.from('t') };
    const { base } = await start(contents, { slow: true });
    const store = new ModelStore({ catalog: catalogOf([makeModel(base, contents)]), rootDir: dir, fetchImpl: fetch });
    store.download('demo');
    await new Promise((resolve) => setTimeout(resolve, 120));
    store.cancel('demo');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(store.status('demo').state).toBe('absent');
    expect(fs.existsSync(path.join(dir, 'demo', 'a.bin.part'))).toBe(true);
  });

  test('trusts a verified marker on startup and verifies again when it is missing', async () => {
    const contents = { 'a.bin': Buffer.alloc(4096, 7), 'b.txt': Buffer.from('hello') };
    const { base } = await start(contents);
    const model = makeModel(base, contents);
    await new ModelStore({ catalog: catalogOf([model]), rootDir: dir, fetchImpl: fetch }).downloadAsync('demo');
    expect(fs.existsSync(path.join(dir, 'demo', '.verified.json'))).toBe(true);

    const reopened = new ModelStore({ catalog: catalogOf([model]), rootDir: dir, fetchImpl: fetch });
    reopened.refreshFromDisk();
    expect(reopened.status('demo').state).toBe('ready');

    fs.rmSync(path.join(dir, 'demo', '.verified.json'));
    const reverify = new ModelStore({ catalog: catalogOf([model]), rootDir: dir, fetchImpl: fetch });
    reverify.refreshFromDisk();
    expect(reverify.status('demo').state).toBe('verifying');
    for (let i = 0; i < 200 && reverify.status('demo').state === 'verifying'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(reverify.status('demo').state).toBe('ready');
  });

  test('cancels during checksum verification without renaming the file', async () => {
    const contents = { 'a.bin': Buffer.alloc(24 * 1024 * 1024, 5), 'b.txt': Buffer.from('t') };
    const { base } = await start(contents);
    const store = new ModelStore({ catalog: catalogOf([makeModel(base, contents)]), rootDir: dir, fetchImpl: fetch });
    const promise = store.downloadAsync('demo');
    for (let i = 0; i < 2000 && store.status('demo').state !== 'verifying'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(store.status('demo').state).toBe('verifying');
    store.cancel('demo');
    const status = await promise;
    expect(status.state).toBe('absent');
    expect(fs.existsSync(path.join(dir, 'demo', 'a.bin'))).toBe(false);
  });

  test('waits for the worker to exit before deleting the model directory', async () => {
    const contents = { 'a.bin': Buffer.from('x'), 'b.txt': Buffer.from('y') };
    const { base } = await start(contents);
    let dirExistedWhenWorkerExited = false;
    const onRemove = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      dirExistedWhenWorkerExited = fs.existsSync(path.join(dir, 'demo'));
    });
    const store = new ModelStore({ catalog: catalogOf([makeModel(base, contents)]), rootDir: dir, fetchImpl: fetch, onRemove });
    await store.downloadAsync('demo');
    await store.remove('demo');
    expect(dirExistedWhenWorkerExited).toBe(true);
    expect(fs.existsSync(path.join(dir, 'demo'))).toBe(false);
  });

  test('can be cancelled repeatedly without uncaught stream errors', async () => {
    const contents = { 'a.bin': Buffer.alloc(4000, 3), 'b.txt': Buffer.from('t') };
    const { base } = await start(contents, { slow: true });
    const catalog = catalogOf([makeModel(base, contents)]);
    for (let i = 0; i < 50; i++) {
      fs.rmSync(path.join(dir, 'demo'), { recursive: true, force: true });
      const store = new ModelStore({ catalog, rootDir: dir, fetchImpl: fetch });
      const promise = store.downloadAsync('demo');
      for (let j = 0; j < 500 && store.status('demo').received === 0; j++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      store.cancel('demo');
      const status = await promise;
      expect(status.state).toBe('absent');
    }
  }, 20000);

  test('refuses a file name that escapes the model directory', () => {
    const store = new ModelStore({ catalog: catalogOf([makeModel('http://x', { 'a': Buffer.from('x') })]), rootDir: dir });
    expect(() => store.filePath('demo', '../escape.bin')).toThrow(expect.objectContaining({ code: 'BAD_FILE_NAME' }));
  });

  test('reports an error and refreshes from disk when deleting the directory fails', async () => {
    const fsp = require('fs/promises');
    const contents = { 'a.bin': Buffer.from('x'), 'b.txt': Buffer.from('y') };
    const { base } = await start(contents);
    const store = new ModelStore({ catalog: catalogOf([makeModel(base, contents)]), rootDir: dir, fetchImpl: fetch });
    await store.downloadAsync('demo');
    const spy = jest.spyOn(fsp, 'rm').mockRejectedValueOnce(new Error('busy'));
    try {
      await expect(store.remove('demo')).rejects.toThrow('busy');
    } finally {
      spy.mockRestore();
    }
    expect(store.status('demo').state).toBe('error');
    expect(store.status('demo').error).toContain('删除失败');
  });

  test('removes an installed model', async () => {
    const contents = { 'a.bin': Buffer.from('x'), 'b.txt': Buffer.from('y') };
    const { base } = await start(contents);
    const onRemove = jest.fn();
    const store = new ModelStore({ catalog: catalogOf([makeModel(base, contents)]), rootDir: dir, fetchImpl: fetch, onRemove });
    await store.downloadAsync('demo');
    const status = await store.remove('demo');
    expect(status.state).toBe('absent');
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir, 'demo'))).toBe(false);
  });
});
