const { spawn } = require('child_process');
const path = require('path');
const localAppService = require('./localAppService');
const localSessionService = require('./localSessionService');

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

function backendUrl() {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL.replace(/\/+$/, '');
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch (_) {}
}

function launchEnv(launch) {
  const extra = launch.env && typeof launch.env === 'object' ? launch.env : {};
  return {
    ...process.env,
    ...extra,
    DIGITAL_HUMAN_NO_BROWSER: '1',
    DIGITAL_HUMAN_PLAY_URL: backendUrl(),
    MIMO_RELAY_URL: localSessionService.getRelayUrl(),
  };
}

async function waitReady(url, child, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw procError('LOCAL_APP_EXITED', `进程提前退出 (${child.exitCode})`, 500);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (_) {}
    await sleep(400);
  }
  throw procError('LOCAL_APP_READY_TIMEOUT', '等待服务就绪超时', 504);
}

function getRunning(id) {
  const item = running.get(id);
  if (!item) return { running: false, id };
  return {
    running: item.child.exitCode == null,
    id,
    pid: item.child.pid,
    url: item.url,
    startedAt: item.startedAt,
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
  const child = spawn(exe, args, {
    cwd,
    env: launchEnv(launch),
    windowsHide: true,
    stdio: 'ignore',
  });
  const url = launch.readyUrl || 'http://127.0.0.1:8020/';
  running.set(id, { child, url, startedAt: Date.now() });
  child.on('exit', () => {
    const current = running.get(id);
    if (current && current.child === child) running.delete(id);
  });
  try {
    await waitReady(url, child);
  } catch (error) {
    await stopApp(id);
    throw error;
  }
  return { id, running: true, url, pid: child.pid };
}

function _resetForTests() {
  running.clear();
}

module.exports = {
  startApp,
  stopApp,
  stopAll,
  getRunning,
  _resetForTests,
};
