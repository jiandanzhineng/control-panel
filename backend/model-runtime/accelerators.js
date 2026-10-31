// 推理设备探测与排序：CPU 永远可用；CUDA / DirectML 需要引擎构建、硬件、实际加载都通过。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { acceleratorsPath } = require('./paths');

const ORDER = ['cuda', 'directml', 'npu', 'cpu'];
const DISPLAY = { cuda: 'CUDA', directml: 'DirectML', npu: 'NPU', cpu: 'CPU' };

function readNvidia() {
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], {
      encoding: 'utf8', timeout: 4000, windowsHide: true,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const line = String(r.stdout).split(/\r?\n/).find((row) => row.trim());
    if (!line) return null;
    const [name, driver] = line.split(',').map((part) => part.trim());
    return { name: name || 'NVIDIA GPU', driver: driver || '' };
  } catch (_) {
    return null;
  }
}

function detectNpu() {
  if (process.platform !== 'win32') return null;
  try {
    const script = "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\bNPU\b|AI Boost|Neural|\bIPU\b|Hexagon' } | Select-Object -ExpandProperty Name -First 1";
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 6000, windowsHide: true,
    });
    const name = String(r.stdout || '').split(/\r?\n/).find((row) => row.trim());
    return name ? name.trim() : null;
  } catch (_) {
    return null;
  }
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
  }

  fingerprint() {
    const build = this.engine?.buildInfo?.() || {};
    const gpu = this.probeNvidia();
    return JSON.stringify({ probe: 4, engine: build, gpu: gpu ? gpu.driver : null, platform: this.platform });
  }

  _loadCache() {
    if (this.cache) return this.cache;
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')); } catch (_) {}
    if (saved && saved.fingerprint === this.fingerprint()) {
      this.cache = saved;
    } else {
      this.cache = { fingerprint: this.fingerprint(), devices: null, benchmarks: {} };
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

  hardware() {
    const nvidia = this.probeNvidia();
    return {
      cuda: nvidia ? { present: true, name: `${nvidia.name} (CUDA)`, driver: nvidia.driver } : { present: false },
      directml: this.platform === 'win32'
        ? { present: true, name: nvidia ? `${nvidia.name} (DirectML)` : 'DirectX 12 GPU (DirectML)' }
        : { present: false },
      npu: (() => {
        const name = this.probeNpu();
        return name ? { present: true, name: `${name} (NPU)` } : { present: false };
      })(),
      cpu: { present: true, name: cpuName() },
    };
  }

  probeAll({ force = false } = {}) {
    const cache = this._loadCache();
    let devices = cache.devices;
    if (force || !devices) {
      const supported = this.supported();
      const hw = this.hardware();
      devices = ORDER.map((id) => {
        const supportedHere = supported.has(id);
        const present = !!hw[id]?.present;
        let reason = null;
        if (!supportedHere) reason = 'engine-unsupported';
        else if (!present) reason = 'hardware-missing';
        else if (id !== 'cpu' && !cache.verified?.[id]) reason = 'untested';
        return {
          id,
          name: hw[id]?.name || DISPLAY[id] || id,
          available: supportedHere && present && (id === 'cpu' || !!cache.verified?.[id]),
          supported: supportedHere,
          present,
          reason,
        };
      });
      cache.devices = devices;
      this._saveCache();
    }
    return devices;
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

  recordBenchmark(modelId, provider, ms) {
    const cache = this._loadCache();
    cache.benchmarks[modelId] = cache.benchmarks[modelId] || {};
    cache.benchmarks[modelId][provider] = { ms: Math.round(ms), at: this.now() };
    cache.verified = cache.verified || {};
    cache.verified[provider] = true;
    cache.devices = null;
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
      cache.devices = null;
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
    return this.probeAll({ force: true });
  }
}

module.exports = { Accelerators, ORDER, readNvidia, detectNpu, cpuName };

