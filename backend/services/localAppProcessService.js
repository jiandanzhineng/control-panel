const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const localAppService = require('./localAppService');
const { launchEnv, attachOutput, exitHint } = require('./localAppLaunchEnv');

const running = new Map();

function procError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch (_) {}
}

async function waitReady(dir, child, timeoutMs = 120000, tail = []) {
  const deadline = Date.now() + timeoutMs;
  const instancePath = path.join(dir, 'data', 'instance.json');
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      await sleep(80);
      throw procError('LOCAL_APP_EXITED', exitHint(child.exitCode, tail), 500);
    }
    try {
      const inst = JSON.parse(fs.readFileSync(instancePath, 'utf8'));
      const port = Number(inst.port);
      if (port > 0 && Number(inst.pid) === Number(child.pid)) {
        const infoUrl = `http://127.0.0.1:${port}/api/info`;
        const response = await fetch(infoUrl);
        if (response.ok) {
          const info = await response.json();
          if (info && info.avatar && info.model) {
            return { url: `http://127.0.0.1:${port}/`, info };
          }
        }
      }
    } catch (_) {}
    await sleep(400);
  }
  throw procError('LOCAL_APP_READY_TIMEOUT', '等待服务就绪超时', 504);
}

function getRunning(id) {
  const item = running.get(id);
  if (!item) return { running: false, id, phase: 'idle', detail: '', elapsedMs: 0 };
  return {
    running: item.child.exitCode == null,
    id,
    pid: item.child.pid,
    url: item.url,
    startedAt: item.startedAt,
    phase: item.phase || 'idle',
    detail: item.detail || '',
    elapsedMs: Date.now() - (item.startedAt || Date.now()),
  };
}

function waitExit(child, timeoutMs) {
  if (child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopApp(id) {
  const item = running.get(id);
  if (!item) return { ok: true, running: false, id };
  running.delete(id);
  killTree(item.child.pid);
  await waitExit(item.child, 3000);
  return { ok: true, running: false, id };
}

async function stopAll() {
  const ids = [...running.keys()];
  for (const id of ids) await stopApp(id);
  return { ok: true };
}

async function startApp(id) {
  const { dir, launch } = localAppService.getCurrentLaunch(id);
  await stopAll();
  const exe = path.resolve(dir, launch.exe);
  const args = Array.isArray(launch.args) ? launch.args.slice() : [];
  const cwd = path.resolve(dir, launch.cwd || '.');
  fs.rmSync(path.join(cwd, 'data', 'instance.json'), { force: true });
  running.set(id, {
    child: { exitCode: null, pid: null }, url: null, startedAt: Date.now(),
    phase: 'starting', detail: '正在启动数字人进程',
  });
  const tail = [];
  const child = spawn(exe, args, {
    cwd,
    env: launchEnv(launch, cwd),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  attachOutput(child, cwd, tail);
  running.set(id, {
    child, url: null, startedAt: Date.now(),
    phase: 'waiting', detail: '等待数字人服务就绪',
  });
  child.on('exit', () => {
    const current = running.get(id);
    if (current && current.child === child) running.delete(id);
  });
  try {
    const ready = await waitReady(cwd, child, 120000, tail);
    running.set(id, {
      child, url: ready.url, startedAt: Date.now(),
      phase: 'ready', detail: '服务已就绪',
    });
    return { id, running: true, url: ready.url, pid: child.pid, info: ready.info };
  } catch (error) {
    await stopApp(id);
    throw error;
  }
}

function _resetForTests() {
  running.clear();
}

module.exports = {
  startApp,
  stopApp,
  stopAll,
  getRunning,
  launchEnv,
  _resetForTests,
};
