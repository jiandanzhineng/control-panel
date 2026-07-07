const http = require('http');
const { spawn, execFileSync } = require('child_process');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:5278';
const WAIT_TIMEOUT_MS = 60_000;
const WAIT_INTERVAL_MS = 500;

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

async function main() {
  const npmCommand = process.platform === 'win32' ? 'npm' : 'npm';
  const electronPath = require('electron');

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

  const electronArgs = [...process.argv.slice(2), 'electron/main.js'];
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
