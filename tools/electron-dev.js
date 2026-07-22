const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:5278';
const WAIT_TIMEOUT_MS = 60_000;
const WAIT_INTERVAL_MS = 500;

// --local-registry：本地起 play-registry 静态站，并把在线游戏源指向它，方便试玩本地游戏。
const LOCAL_REGISTRY = process.argv.includes('--local-registry') || process.env.GAME_REGISTRY_LOCAL === '1';
const LOCAL_REGISTRY_PORT = Number(process.env.LOCAL_REGISTRY_PORT || 4178);
const LOCAL_REGISTRY_URL = `http://127.0.0.1:${LOCAL_REGISTRY_PORT}/registry.json`;
const REPO_ROOT = path.resolve(__dirname, '..');
const REGISTRY_SITE_DIR = path.join(REPO_ROOT, 'play-registry', '.site');

const children = new Set();
let shuttingDown = false;
let ownsFrontend = false;

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    ...options,
    env: {
      ...process.env,
      ...options.env,
    },
  });

  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function stopChildren() {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    killProcessTree(child);
  }
}

function readUrl(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, body });
      });
    });

    req.on('error', reject);
    req.setTimeout(WAIT_INTERVAL_MS, () => {
      req.destroy(new Error(`Timed out probing ${url}`));
    });
  });
}

async function probeFrontend(url) {
  const response = await readUrl(url);
  const isOk = response.statusCode >= 200 && response.statusCode < 400;
  const isThisApp = response.body.includes('id="app"') && response.body.includes('/src/main.ts');

  if (!isOk || !isThisApp) {
    throw new Error(`${url} is not this Vite app`);
  }
}

function waitForUrl(url, timeoutMs = WAIT_TIMEOUT_MS) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const probe = () => {
      probeFrontend(url)
        .then(resolve)
        .catch(() => {
          if (Date.now() - startedAt >= timeoutMs) {
            reject(new Error(`Timed out waiting for ${url}`));
            return;
          }
          setTimeout(probe, WAIT_INTERVAL_MS);
        });
    };

    probe();
  });
}

function killProcessTree(child) {
  if (!child || child.killed || !child.pid) return;

  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      return;
    }

    child.kill();
  } catch {
    try {
      child.kill();
    } catch {}
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// 用内置 http 起一个只读静态站，服务 play-registry/.site（无需额外依赖）。
function startRegistryServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    const resolved = path.normalize(path.join(REGISTRY_SITE_DIR, rel));
    if (!resolved.startsWith(REGISTRY_SITE_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(resolved, (err, buf) => {
      if (err) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
        'access-control-allow-origin': '*',
      });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(LOCAL_REGISTRY_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const npmCommand = process.platform === 'win32' ? 'npm' : 'npm';
  const electronPath = require('electron');

  if (LOCAL_REGISTRY) {
    console.log('[electron-dev] building play-registry site (.site)...');
    execFileSync(npmCommand, ['--prefix', 'play-registry', 'run', 'build:site'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (!fs.existsSync(REGISTRY_SITE_DIR)) {
      throw new Error(`registry site not built: ${REGISTRY_SITE_DIR}`);
    }
    const registryServer = await startRegistryServer();
    registryServer.once('close', () => {});
    process.env.GAME_REGISTRY_URL = LOCAL_REGISTRY_URL;
    console.log(`[electron-dev] local game registry: ${LOCAL_REGISTRY_URL}`);
  }

  try {
    await probeFrontend(DEV_SERVER_URL);
    console.log(`[electron-dev] reusing frontend dev server: ${DEV_SERVER_URL}`);
  } catch {
    ownsFrontend = true;
    console.log(`[electron-dev] starting frontend dev server: ${DEV_SERVER_URL}`);
    const frontend = spawnChild(
      npmCommand,
      ['--prefix', 'frontend', 'run', 'dev', '--', '--strictPort'],
      {
        shell: process.platform === 'win32',
        env: {
          VITE_API_PROXY_TARGET: API_PROXY_TARGET,
        },
      },
    );

    frontend.once('exit', (code) => {
      if (!shuttingDown) {
        console.error(`[electron-dev] frontend exited before Electron stopped (code ${code})`);
        process.exit(code || 1);
      }
    });

    await waitForUrl(DEV_SERVER_URL);
  }

  console.log('[electron-dev] frontend is ready, starting Electron');

  // --local-registry 是本脚本自己消费的标志，不透传给 electron。
  const passthroughArgs = process.argv.slice(2).filter((a) => a !== '--local-registry');
  const electronArgs = [...passthroughArgs, 'electron/main.js'];
  const electron = spawnChild(electronPath, electronArgs, {
    env: {
      VITE_DEV_SERVER_URL: DEV_SERVER_URL,
    },
  });

  electron.once('exit', (code) => {
    if (ownsFrontend) stopChildren();
    process.exit(code || 0);
  });
}

process.once('SIGINT', () => {
  stopChildren();
  process.exit(130);
});
process.once('SIGTERM', () => {
  stopChildren();
  process.exit(143);
});
process.once('exit', stopChildren);

main().catch((error) => {
  console.error(`[electron-dev] ${error.message}`);
  stopChildren();
  process.exit(1);
});
