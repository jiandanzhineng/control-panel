const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on('error', reject);
  });
}

describe('localAppProcessService', () => {
  let tempDir;
  let previousDataDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-app-proc-'));
    previousDataDir = process.env.BACKEND_DATA_DIR;
    process.env.BACKEND_DATA_DIR = path.join(tempDir, 'data');
    jest.resetModules();
  });

  afterEach(async () => {
    const service = require('../services/localAppProcessService');
    await service.stopAll();
    restoreEnv('BACKEND_DATA_DIR', previousDataDir);
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('starts a local process, waits for ready, then stops it', async () => {
    const port = await freePort();
    const current = path.join(process.env.BACKEND_DATA_DIR, 'apps', 'digital-human', 'current');
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, 'server.js'), [
      "const http = require('http');",
      `http.createServer((req, res) => {`,
      "  res.setHeader('content-type', 'application/json');",
      "  res.end(JSON.stringify({ ok: true }));",
      `}).listen(${port}, '127.0.0.1');`,
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(current, '.app-meta.json'), JSON.stringify({
      id: 'digital-human',
      version: 'test',
      launch: {
        cwd: '.',
        exe: process.execPath,
        args: ['server.js'],
        readyUrl: `http://127.0.0.1:${port}/api/info`,
      },
    }));

    const service = require('../services/localAppProcessService');
    const started = await service.startApp('digital-human');
    expect(started.running).toBe(true);
    expect(started.url).toContain(String(port));
    expect(service.getRunning('digital-human').running).toBe(true);

    await service.stopApp('digital-human');
    expect(service.getRunning('digital-human').running).toBe(false);
  });
});
