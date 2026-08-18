const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

jest.mock('../services/logService', () => ({
  log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

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
      "const fs = require('fs');",
      "const path = require('path');",
      "const http = require('http');",
      `const port = ${port};`,
      "fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });",
      "fs.writeFileSync(path.join(__dirname, 'data', 'instance.json'), JSON.stringify({ port, pid: process.pid }));",
      "http.createServer((req, res) => {",
      "  res.setHeader('content-type', 'application/json');",
      "  res.end(JSON.stringify({ avatar: 'xiaoya_wide', model: '256', ep: 'DmlExecutionProvider' }));",
      "}).listen(port, '127.0.0.1');",
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

  it('does not treat a foreign readyUrl occupant as the installed app', async () => {
    const decoyPort = await freePort();
    const realPort = await freePort();
    const decoy = require('http').createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ avatar: 'foreign', model: '256', ep: 'CPUExecutionProvider' }));
    });
    await new Promise((resolve) => decoy.listen(decoyPort, '127.0.0.1', resolve));
    const current = path.join(process.env.BACKEND_DATA_DIR, 'apps', 'digital-human', 'current');
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, 'server.js'), [
      "const fs = require('fs');",
      "const path = require('path');",
      "const http = require('http');",
      `const port = ${realPort};`,
      "fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });",
      "fs.writeFileSync(path.join(__dirname, 'data', 'instance.json'), JSON.stringify({ port, pid: process.pid }));",
      "http.createServer((req, res) => {",
      "  res.setHeader('content-type', 'application/json');",
      "  res.end(JSON.stringify({ avatar: 'xiaoya_wide', model: '256', ep: 'DmlExecutionProvider' }));",
      "}).listen(port, '127.0.0.1');",
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(current, '.app-meta.json'), JSON.stringify({
      id: 'digital-human',
      version: 'test',
      launch: {
        cwd: '.',
        exe: process.execPath,
        args: ['server.js'],
        readyUrl: `http://127.0.0.1:${decoyPort}/api/info`,
      },
    }));
    const service = require('../services/localAppProcessService');
    try {
      const started = await service.startApp('digital-human');
      expect(started.url).toContain(String(realPort));
      expect(started.url).not.toContain(String(decoyPort));
      expect(started.info.avatar).toBe('xiaoya_wide');
    } finally {
      decoy.close();
    }
  });

  it('ignores a leftover instance.json that points at a decoy', async () => {
    const decoyPort = await freePort();
    const realPort = await freePort();
    const decoy = require('http').createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ avatar: 'stale', model: '256', ep: 'CPUExecutionProvider' }));
    });
    await new Promise((resolve) => decoy.listen(decoyPort, '127.0.0.1', resolve));
    const current = path.join(process.env.BACKEND_DATA_DIR, 'apps', 'digital-human', 'current');
    fs.mkdirSync(path.join(current, 'data'), { recursive: true });
    fs.writeFileSync(path.join(current, 'data', 'instance.json'), JSON.stringify({
      port: decoyPort, pid: 1,
    }));
    fs.writeFileSync(path.join(current, 'server.js'), [
      "const fs = require('fs');",
      "const path = require('path');",
      "const http = require('http');",
      `const port = ${realPort};`,
      "setTimeout(() => {",
      "  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });",
      "  fs.writeFileSync(path.join(__dirname, 'data', 'instance.json'), JSON.stringify({ port, pid: process.pid }));",
      "  http.createServer((req, res) => {",
      "    res.setHeader('content-type', 'application/json');",
      "    res.end(JSON.stringify({ avatar: 'xiaoya_wide', model: '256', ep: 'DmlExecutionProvider' }));",
      "  }).listen(port, '127.0.0.1');",
      "}, 400);",
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(current, '.app-meta.json'), JSON.stringify({
      id: 'digital-human', version: 'test',
      launch: { cwd: '.', exe: process.execPath, args: ['server.js'] },
    }));
    const service = require('../services/localAppProcessService');
    try {
      const started = await service.startApp('digital-human');
      expect(started.url).toContain(String(realPort));
      expect(started.url).not.toContain(String(decoyPort));
      expect(started.info.avatar).toBe('xiaoya_wide');
    } finally {
      decoy.close();
    }
  });

  it('surfaces child output when the process exits early', async () => {
    const current = path.join(process.env.BACKEND_DATA_DIR, 'apps', 'digital-human', 'current');
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, 'boom.js'), "console.error('ffmpeg not found'); process.exit(1);\n");
    fs.writeFileSync(path.join(current, '.app-meta.json'), JSON.stringify({
      id: 'digital-human', version: 'test',
      launch: { cwd: '.', exe: process.execPath, args: ['boom.js'] },
    }));
    const service = require('../services/localAppProcessService');
    await expect(service.startApp('digital-human')).rejects.toMatchObject({
      code: 'LOCAL_APP_EXITED',
      message: expect.stringContaining('ffmpeg not found'),
    });
  });
});
