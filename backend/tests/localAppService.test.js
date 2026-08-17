const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fileEntry(relPath, content) {
  const buffer = Buffer.from(content);
  return { path: relPath, sha256: sha256(buffer), size: buffer.length, buffer };
}

describe('localAppService', () => {
  let tempDir;
  let previousDataDir;
  let previousFeed;
  let previousChannel;
  let previousFetch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-app-'));
    previousDataDir = process.env.BACKEND_DATA_DIR;
    previousFeed = process.env.LOCAL_APP_FEED;
    previousChannel = process.env.LOCAL_APP_CHANNEL;
    previousFetch = global.fetch;
    process.env.BACKEND_DATA_DIR = path.join(tempDir, 'data');
    process.env.LOCAL_APP_FEED = 'http://feed.test/apps';
    process.env.LOCAL_APP_CHANNEL = 'test';
    jest.resetModules();
  });

  afterEach(() => {
    restoreEnv('BACKEND_DATA_DIR', previousDataDir);
    restoreEnv('LOCAL_APP_FEED', previousFeed);
    restoreEnv('LOCAL_APP_CHANNEL', previousChannel);
    global.fetch = previousFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function mockFeed(files, version = '1.0.0') {
    const manifest = {
      id: 'digital-human',
      kind: 'local-app',
      version,
      launch: {
        cwd: '.',
        exe: 'runtime/python.exe',
        args: ['-B', 'launcher.py'],
        readyUrl: 'http://127.0.0.1:8020/api/info',
      },
      files: files.map(({ path: rel, sha256: digest, size }) => ({
        path: rel, sha256: digest, size,
      })),
    };
    const byHash = new Map(files.map((file) => [file.sha256, file.buffer]));
    global.fetch = jest.fn(async (url) => {
      const text = String(url);
      if (text.endsWith('/digital-human/test/latest.json')) {
        return { ok: true, status: 200, json: async () => manifest };
      }
      const digest = text.split('/').pop();
      const buffer = byHash.get(digest);
      if (!buffer) return { ok: false, status: 404 };
      return { ok: true, status: 200, arrayBuffer: async () => buffer };
    });
    return manifest;
  }

  it('syncs only missing files and reuses cas objects', async () => {
    const web = fileEntry('web/app.js', 'hello\n');
    const model = fileEntry('models/a.bin', 'MODEL');
    mockFeed([web, model]);
    const service = require('../services/localAppService');

    const first = await service.syncApp('digital-human');
    expect(first.installed).toBe(true);
    expect(first.version).toBe('1.0.0');
    expect(first.bytesToDownload).toBe(0);
    expect(global.fetch).toHaveBeenCalledTimes(4);

    const second = await service.syncApp('digital-human');
    expect(second.installed).toBe(true);
    expect(global.fetch.mock.calls.filter((c) => String(c[0]).includes('/cas/'))).toHaveLength(2);
  });

  it('downloads only changed files on version bump', async () => {
    const web = fileEntry('web/app.js', 'hello\n');
    const model = fileEntry('models/a.bin', 'MODEL');
    mockFeed([web, model], '1.0.0');
    const service = require('../services/localAppService');
    await service.syncApp('digital-human');

    const web2 = fileEntry('web/app.js', 'hello2\n');
    mockFeed([web2, model], '1.0.1');
    const updated = await service.syncApp('digital-human');
    expect(updated.version).toBe('1.0.1');
    const casCalls = global.fetch.mock.calls.filter((c) => String(c[0]).includes('/cas/'));
    expect(casCalls).toHaveLength(1);
    expect(String(casCalls[0][0])).toContain(web2.sha256);
    const installed = fs.readFileSync(
      path.join(process.env.BACKEND_DATA_DIR, 'apps', 'digital-human', 'current', 'web', 'app.js'),
      'utf8',
    );
    expect(installed).toBe('hello2\n');
  });

  it('rejects unknown app ids', async () => {
    const service = require('../services/localAppService');
    await expect(service.getStatus('nope')).rejects.toMatchObject({ code: 'LOCAL_APP_NOT_FOUND' });
  });
});
