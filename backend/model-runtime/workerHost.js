// 推理子进程管理：每个（模型, 设备）一个进程；串行排队、超时、崩溃后下次请求重启、空闲退出。
const { spawn } = require('child_process');
const path = require('path');

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_LOAD_MS = 30000;
const DEFAULT_REQUEST_MS = 10000;

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class WorkerHost {
  constructor({ workerPath, spawnImpl = spawn, execPath = process.execPath, baseEnv = process.env,
    idleMs = DEFAULT_IDLE_MS, loadMs = DEFAULT_LOAD_MS, logger } = {}) {
    this.workerPath = workerPath || path.join(__dirname, 'worker.js');
    this.spawnImpl = spawnImpl;
    this.execPath = execPath;
    this.baseEnv = baseEnv;
    this.idleMs = idleMs;
    this.loadMs = loadMs;
    this.logger = logger || { warn() {}, info() {}, debug() {} };
    this.entries = new Map();
    this.seq = 0;
  }

  key(modelId, provider) { return `${modelId}|${provider}`; }

  _entry(key) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, child: null, ready: false, busy: false, tasks: [], current: null,
        startEnv: null, lastUsed: Date.now(), idleTimer: null, stderr: '', loadWaiters: [] };
      this.entries.set(key, entry);
    }
    return entry;
  }

  _clearIdle(entry) {
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
  }

  _spawn(entry, startEnv) {
    this._clearIdle(entry);
    entry.startEnv = startEnv || entry.startEnv || {};
    const env = { ...this.baseEnv, ...entry.startEnv };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    else delete env.ELECTRON_RUN_AS_NODE;
    let child;
    try {
      child = this.spawnImpl(this.execPath, [this.workerPath], {
        env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (error) {
      throw makeError('WORKER_SPAWN_FAILED', error.message);
    }
    const childId = (entry.childId || 0) + 1;
    entry.childId = childId;
    entry.child = child;
    entry.ready = false;
    entry.stderr = '';
    let readyTimer = setTimeout(() => {
      this.logger.warn('ModelRuntime', `worker load timeout key=${entry.key}`);
      this._failLoad(entry, makeError('WORKER_LOAD_TIMEOUT', '模型加载超时'));
      this.kill(entry.key);
    }, this.loadMs);
    entry.readyTimer = readyTimer;
    const settleLoad = (error) => {
      clearTimeout(readyTimer);
      readyTimer = null;
      entry.readyTimer = null;
      const waiters = entry.loadWaiters.splice(0);
      for (const waiter of waiters) error ? waiter.reject(error) : waiter.resolve();
    };
    entry.settleLoad = settleLoad;
    child.stderr?.on('data', (chunk) => {
      entry.stderr = (entry.stderr + String(chunk)).slice(-4000);
    });
    child.stdout?.on('data', () => {});
    child.on('message', (message) => this._onMessage(entry, message, childId));
    child.on('error', (error) => {
      entry.stderr = `${entry.stderr}\n${error.message}`.slice(-4000);
    });
    child.on('exit', (code, signal) => {
      if (entry.childId !== childId) return;
      if (readyTimer) { clearTimeout(readyTimer); settleLoad(makeError('WORKER_LOAD_FAILED', `子进程退出 (${code ?? signal})`)); }
      this._onExit(entry, code, signal);
    });
    return entry;
  }

  _failLoad(entry, error) {
    if (entry.settleLoad) entry.settleLoad(error);
    entry.settleLoad = null;
  }

  _onMessage(entry, message, childId) {
    if (!message || typeof message !== 'object') return;
    if (entry.childId !== childId || !entry.child) return;
    if (message.type === 'ready') {
      entry.ready = true;
      entry.settleLoad = null;
      if (entry.readyTimer) { clearTimeout(entry.readyTimer); entry.readyTimer = null; }
      const waiters = entry.loadWaiters.splice(0);
      for (const waiter of waiters) {
        if (waiter.generation !== childId) waiter.reject(makeError('WORKER_KILLED', '本地推理进程已停止'));
        else waiter.resolve();
      }
      this._pump(entry);
      return;
    }
    if (message.type === 'fatal') {
      this.logger.warn('ModelRuntime', `worker fatal key=${entry.key}: ${message.message}`);
      entry.stderr = `${entry.stderr}\n${message.message || ''}`.slice(-4000);
      if (entry.settleLoad) entry.settleLoad(makeError('WORKER_LOAD_FAILED', message.message || '子进程启动失败'));
      this.kill(entry.key);
      return;
    }
    const task = entry.current;
    if (!task || message.id !== task.id) return;
    if (task.timer) { clearTimeout(task.timer); task.timer = null; }
    entry.current = null;
    entry.busy = false;
    entry.lastUsed = Date.now();
    if (message.ok) task.resolve({ text: message.text, ms: message.ms });
    else task.reject(makeError(message.code || 'LOCAL_INFERENCE_FAILED', message.message || '本地推理失败'));
    this._pump(entry);
  }

  _onExit(entry, code, signal) {
    const wasReady = entry.ready;
    entry.child = null;
    entry.ready = false;
    entry.busy = false;
    if (entry.readyTimer) { clearTimeout(entry.readyTimer); entry.readyTimer = null; }
    if (entry.settleLoad) entry.settleLoad(makeError('WORKER_LOAD_FAILED', `子进程退出 (${code ?? signal})`));
    const task = entry.current;
    entry.current = null;
    if (task) {
      if (task.timer) clearTimeout(task.timer);
      task.reject(makeError('WORKER_CRASHED', `本地推理进程退出 (${code ?? signal})${entry.stderr ? `: ${entry.stderr.trim()}` : ''}`));
    }
    this.logger.warn('ModelRuntime', `worker exit key=${entry.key} ready=${wasReady} code=${code} signal=${signal}`);
    if (entry.tasks.length) this._ensureChild(entry);
    else this._scheduleIdle(entry);
  }

  _ensureChild(entry) {
    if (entry.child) return;
    try { this._spawn(entry, entry.startEnv); } catch (error) {
      const tasks = entry.tasks.splice(0);
      for (const task of tasks) task.reject(error);
      const waiters = entry.loadWaiters.splice(0);
      for (const waiter of waiters) waiter.reject(error);
    }
  }

  _pump(entry) {
    if (entry.busy || !entry.ready || !entry.child) return;
    const task = entry.tasks.shift();
    if (!task) { this._scheduleIdle(entry); return; }
    if (task.cancelled) { task.reject(makeError('ABORTED', '已取消')); this._pump(entry); return; }
    entry.busy = true;
    entry.current = task;
    entry.lastUsed = Date.now();
    task.timer = setTimeout(() => {
      if (entry.current !== task) return;
      entry.current = null;
      entry.busy = false;
      task.timer = null;
      task.reject(makeError('TIMEOUT', `本地推理超时（${task.timeoutMs}ms）`));
      this.logger.warn('ModelRuntime', `worker request timeout key=${entry.key}`);
      this._killChild(entry);
      if (entry.tasks.length) this._ensureChild(entry);
      else this._scheduleIdle(entry);
    }, task.timeoutMs);
    try {
      entry.child.send({ type: 'transcribe', id: task.id, audio: task.payload.audio });
    } catch (error) {
      clearTimeout(task.timer);
      entry.current = null;
      entry.busy = false;
      task.reject(makeError('WORKER_CRASHED', error.message));
      this._killChild(entry);
      if (entry.tasks.length) this._ensureChild(entry);
    }
  }

  _rejectLoadWaiters(entry, error) {
    const waiters = entry.loadWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }

  _killChild(entry) {
    entry.childId = (entry.childId || 0) + 1;
    entry.ready = false;
    const child = entry.child;
    entry.child = null;
    this._rejectLoadWaiters(entry, makeError('WORKER_KILLED', '本地推理进程已停止'));
    try { child?.kill(); } catch (_) {}
    if (entry.readyTimer) { clearTimeout(entry.readyTimer); entry.readyTimer = null; }
  }

  _scheduleIdle(entry) {
    this._clearIdle(entry);
    if (entry.busy || entry.tasks.length) return;
    entry.idleTimer = setTimeout(() => {
      this.logger.info('ModelRuntime', `worker idle exit key=${entry.key}`);
      this._clearIdle(entry);
      this._killChild(entry);
      this.entries.delete(entry.key);
    }, this.idleMs);
    if (entry.idleTimer.unref) entry.idleTimer.unref();
  }
  request(key, payload, { timeoutMs = DEFAULT_REQUEST_MS, startEnv } = {}) {
    const entry = this._entry(key);
    if (startEnv) entry.startEnv = startEnv;
    this._clearIdle(entry);
    return new Promise((resolve, reject) => {
      const task = { id: ++this.seq, payload, resolve, reject, timeoutMs, timer: null };
      entry.tasks.push(task);
      if (!entry.child) this._ensureChild(entry);
      this._pump(entry);
    });
  }

  /** 预热：只把子进程和模型加载好，不跑推理。 */
  prefetch(key, startEnv) {
    const entry = this._entry(key);
    if (startEnv) entry.startEnv = startEnv;
    this._clearIdle(entry);
    if (entry.ready) return Promise.resolve();
    if (!entry.child) {
      try { this._spawn(entry, entry.startEnv); } catch (error) { return Promise.reject(error); }
    }
    if (entry.ready) return Promise.resolve();
    if (!entry.child) return Promise.reject(makeError('WORKER_SPAWN_FAILED', '子进程启动失败'));
    const generation = entry.childId;
    return new Promise((resolve, reject) => {
      entry.loadWaiters.push({ resolve, reject, generation });
    });
  }

  kill(key, { rejectQueued = true } = {}) {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve();
    this._clearIdle(entry);
    const child = entry.child;
    const error = makeError('WORKER_KILLED', '本地推理进程已停止');
    this._rejectLoadWaiters(entry, error);
    if (entry.current) {
      if (entry.current.timer) clearTimeout(entry.current.timer);
      entry.current.reject(error);
      entry.current = null;
    }
    if (rejectQueued) {
      for (const task of entry.tasks.splice(0)) task.reject(error);
    }
    entry.busy = false;
    this._killChild(entry);
    this.entries.delete(key);
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 3000);
      if (timer.unref) timer.unref();
      if (child.exitCode !== null) finish();
      else child.once('exit', finish);
    });
  }

  killModel(modelId) {
    const jobs = [];
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(`${modelId}|`)) jobs.push(this.kill(key));
    }
    return Promise.all(jobs);
  }

  stopAll() {
    return Promise.all(Array.from(this.entries.keys()).map((key) => this.kill(key)));
  }

  status() {
    return Array.from(this.entries.values()).map((entry) => ({
      key: entry.key, pid: entry.child?.pid || null, ready: entry.ready,
      busy: entry.busy, queued: entry.tasks.length,
    }));
  }
}

module.exports = { WorkerHost, DEFAULT_IDLE_MS, DEFAULT_LOAD_MS, DEFAULT_REQUEST_MS, makeError };


