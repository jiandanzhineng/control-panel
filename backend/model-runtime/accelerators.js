// 推理设备探测与排序：CPU 永远可用；CUDA / DirectML 需要引擎构建、硬件、实际加载都通过。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { acceleratorsPath } = require('./paths');

const ORDER = ['cuda', 'directml', 'npu', 'cpu'];
const DISPLAY = { cuda: 'CUDA', directml: 'DirectML', npu: 'NPU', cpu: 'CPU' };
const PROBE_TIMEOUT_MS = 4000;

// 异步执行探测命令，绝不阻塞主进程；超时或失败都返回 null。
function runProbe(command, args, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let child;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (child && !child.killed) child.kill(); } catch (_) {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) {
      finish(null);
      return;
    }
    child.stdout?.on('data', (chunk) => { out += String(chunk); });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? out : null));
  });
}

async function readNvidia() {
  const out = await runProbe('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader']);
  if (!out) return null;
  const line = String(out).split(/\r?\n/).find((row) => row.trim());
  if (!line) return null;
  const [name, driver] = line.split(',').map((part) => part.trim());
  return { name: name || 'NVIDIA GPU', driver: driver || '' };
}

async function detectNpu() {
  if (process.platform !== 'win32') return null;
  const script = "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\bNPU\\b|AI Boost|Neural|\\bIPU\\b|Hexagon' } | Select-Object -ExpandProperty Name -First 1";
  const out = await runProbe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 6000);
  const name = String(out || '').split(/\r?\n/).find((row) => row.trim());
  return name ? name.trim() : null;
}

function cpuName() {
  const cpus = require('os').cpus() || [];
  const model = cpus[0]?.model ? String(cpus[0].model).trim() : 'CPU';
  return `${model}（${cpus.length} 线程）`;
}

class Accelerators {
  constructor({ engine, catalog, cachePath = acceleratorsPath(), now = Date.now,
    probeNvidia = readNvidia, probeNpu = detectNpu, platform = process.platform } = {}) {
    this.engine = engine;
    this.catalog = catalog;
    this.probeNvidia = probeNvidia;
    this.probeNpu = probeNpu;
    this.platform = platform;
    this.cachePath = cachePath;
    this.now = now;
    this.cache = null;
    this.failures = new Map();
    this.probePromise = null;
    this.refreshState = { probing: false, lastAt: null, error: null };
  }

  fingerprint() {
    // 只包含版本类信息；硬件探测结果单独缓存在 cache.hardware，避免同步跑 nvidia-smi。
    return JSON.stringify({ probe: 5, engine: this.engine?.buildInfo?.() || {}, platform: this.platform });
  }

  _loadCache() {
    if (this.cache) return this.cache;
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')); } catch (_) {}
    if (saved && saved.fingerprint === this.fingerprint()) {
      this.cache = saved;
    } else {
      this.cache = { fingerprint: this.fingerprint(), devices: null, hardware: null, benchmarks: {} };
    }
    return this.cache;
  }

  _saveCache() {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, `${JSON.stringify(this._loadCache(), null, 2)}\n`, 'utf8');
    } catch (_) {}
  }

  supported() {
    try { return new Set(this.engine?.supportedProviders?.() || ['cpu']); } catch (_) { return new Set(['cpu']); }
  }

  cpuDevice() {
    return { present: true, name: cpuName() };
  }

  fallbackDevices() {
    const supported = this.supported();
    const declared = new Set(['cpu']);
    for (const model of this.catalog?.list?.() || []) {
      for (const id of model.providers || []) declared.add(id);
    }
    return ORDER.filter((id) => declared.has(id)).map((id) => ({
      id,
      name: id === 'cpu' ? cpuName() : (DISPLAY[id] || id),
      available: id === 'cpu' && supported.has('cpu'),
      supported: supported.has(id),
      present: id === 'cpu',
      reason: supported.has(id) ? (id === 'cpu' ? null : 'untested') : 'engine-unsupported',
      provisional: true,
    }));
  }

  hardware() {
    return this._loadCache().hardware || null;
  }

  probeAll() {
    const cache = this._loadCache();
    if (!cache.devices) cache.devices = this.fallbackDevices();
    if (!cache.hardware) this._ensureProbed().catch(() => {});
    return cache.devices;
  }

  _deviceList(hw, cache) {
    const supported = this.supported();
    return ORDER.map((id) => {
      const supportedHere = supported.has(id);
      const present = id === 'cpu' ? true : !!hw[id]?.present;
      let reason = null;
      if (!supportedHere) reason = 'engine-unsupported';
      else if (!present) reason = 'hardware-missing';
      else if (id !== 'cpu' && !cache.verified?.[id]) reason = 'untested';
      return {
        id,
        name: hw[id]?.name || (id === 'cpu' ? cpuName() : DISPLAY[id] || id),
        available: supportedHere && present && (id === 'cpu' || !!cache.verified?.[id]),
        supported: supportedHere,
        present,
        reason,
        provisional: false,
      };
    });
  }

  async _probeHardware() {
    const [nvidia, npu] = await Promise.all([
      Promise.resolve().then(() => this.probeNvidia()).catch(() => null),
      Promise.resolve().then(() => this.probeNpu()).catch(() => null),
    ]);
    return {
      cuda: nvidia ? { present: true, name: `${nvidia.name} (CUDA)`, driver: nvidia.driver } : { present: false },
      directml: this.platform === 'win32'
        ? { present: true, name: nvidia ? `${nvidia.name} (DirectML)` : 'DirectX 12 GPU (DirectML)' }
        : { present: false },
      npu: npu ? { present: true, name: `${npu} (NPU)` } : { present: false },
      cpu: this.cpuDevice(),
    };
  }

  _ensureProbed(force = false) {
    if (this.probePromise) return this.probePromise;
    const cache = this._loadCache();
    if (!force && cache.hardware) return Promise.resolve(cache.devices || this.fallbackDevices());
    this.refreshState = { probing: true, lastAt: this.refreshState.lastAt, error: null };
    this.probePromise = (async () => {
      try {
        const hw = await this._probeHardware();
        const current = this._loadCache();
        current.hardware = hw;
        current.devices = this._deviceList(hw, current);
        this._saveCache();
        this.refreshState = { probing: false, lastAt: this.now(), error: null };
        return current.devices;
      } catch (error) {
        this.refreshState = { probing: false, lastAt: this.refreshState.lastAt, error: error?.message || String(error) };
        throw error;
      } finally {
        this.probePromise = null;
      }
    })();
    return this.probePromise;
  }

  devicesForModel(modelId) {
    const model = this.catalog?.get?.(modelId);
    const allowed = new Set(model?.providers || ['cpu']);
    return this.probeAll().map((device) => {
      const failures = this.failures.get(`${modelId}|${device.id}`) || 0;
      let reason = device.reason;
      if (!allowed.has(device.id)) reason = 'model-unsupported';
      else if (failures >= 2) reason = 'failed-twice';
      return {
        ...device,
        available: device.available && allowed.has(device.id) && failures < 2,
        reason,
        failures,
      };
    });
  }

  candidateIds(modelId, preference = 'auto') {
    const model = this.catalog?.get?.(modelId);
    const modelProviders = new Set(model?.providers || ['cpu']);
    // probeAll 有缓存；这里不能再调 hardware()，否则每次状态查询都会跑 nvidia-smi / PowerShell。
    const devices = this.probeAll();
    const usable = devices
      .filter((device) => modelProviders.has(device.id) && device.supported && device.present
        && (this.failures.get(`${modelId}|${device.id}`) || 0) < 2)
      .map((device) => device.id);
    if (preference && preference !== 'auto' && usable.includes(preference)) {
      return [preference, ...usable.filter((id) => id !== preference)];
    }
    return usable.length ? usable : ['cpu'];
  }

  orderForModel(modelId, preference = 'auto') {
    const ids = this.candidateIds(modelId, preference);
    if (preference !== 'auto') return ids;
    const bench = this._loadCache().benchmarks[modelId] || {};
    const scored = ids.filter((id) => Number.isFinite(bench[id]?.ms));
    const rest = ids.filter((id) => !Number.isFinite(bench[id]?.ms));
    scored.sort((a, b) => bench[a].ms - bench[b].ms);
    return [...scored, ...rest];
  }

  benchmarkFor(modelId, provider) {
    return this._loadCache().benchmarks[modelId]?.[provider] || null;
  }

  _invalidateDevices(cache) {
    // 有硬件快照时立即重算，避免下一次 probeAll 退回只剩 CPU 的兜底列表。
    cache.devices = cache.hardware ? this._deviceList(cache.hardware, cache) : null;
    return cache.devices;
  }

  recordBenchmark(modelId, provider, ms) {
    const cache = this._loadCache();
    cache.benchmarks[modelId] = cache.benchmarks[modelId] || {};
    cache.benchmarks[modelId][provider] = { ms: Math.round(ms), at: this.now() };
    cache.verified = cache.verified || {};
    cache.verified[provider] = true;
    this._invalidateDevices(cache);
    this._saveCache();
    return cache.benchmarks[modelId][provider];
  }

  recordFailure(modelId, provider) {
    const key = `${modelId}|${provider}`;
    const next = (this.failures.get(key) || 0) + 1;
    this.failures.set(key, next);
    if (next >= 2) {
      const cache = this._loadCache();
      if (cache.verified) cache.verified[provider] = false;
      this._invalidateDevices(cache);
      this._saveCache();
    }
    return next;
  }

  resetFailures(modelId, provider) {
    const key = `${modelId}|${provider}`;
    if (provider) this.failures.delete(key);
    else for (const k of this.failures.keys()) if (k.startsWith(`${modelId}|`)) this.failures.delete(k);
  }

  benchmarks(modelId) {
    return { ...(this._loadCache().benchmarks[modelId] || {}) };
  }

  refresh() {
    this.cache = null;
    this.failures.clear();
    return this._ensureProbed(true);
  }
}

module.exports = { Accelerators, ORDER, readNvidia, detectNpu, cpuName };

