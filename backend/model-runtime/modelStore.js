// 模型下载与本地存储：.part 续传、按 urls 换源、sha256 校验、取消、删除。
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { modelsRoot } = require('./paths');

const TERMINAL_STATES = new Set(['ready', 'error', 'absent']);
const MARKER = '.verified.json';

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ABORTED';
}

function sha256File(file, signal) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      reject(error);
    };
    const abort = () => {
      stream.destroy();
      fail(Object.assign(new Error('已取消'), { code: 'ABORTED' }));
    };
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => fail(isAbort(error) ? Object.assign(new Error('已取消'), { code: 'ABORTED' }) : error));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(hash.digest('hex'));
    });
  });
}

function totalBytes(model) {
  return (model.files || []).reduce((sum, file) => sum + (Number(file.bytes) || 0), 0);
}

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class ModelStore {
  constructor({ catalog, rootDir = modelsRoot(), fetchImpl = globalThis.fetch, onReady, onRemove } = {}) {
    this.catalog = catalog;
    this.rootDir = rootDir;
    this.fetchImpl = fetchImpl;
    this.onReady = onReady || (() => {});
    this.onRemove = onRemove || (() => {});
    this.jobs = new Map();
    this.states = new Map();
    this.verifying = new Set();
    for (const model of catalog.list()) {
      this.states.set(model.id, { state: 'absent', received: 0, total: totalBytes(model), error: null });
    }
  }

  modelDir(id) { return path.join(this.rootDir, id); }
  filePath(id, name) {
    const dir = path.resolve(this.modelDir(id));
    const full = path.resolve(dir, name);
    if (full === dir || !full.startsWith(dir + path.sep)) {
      throw makeError('BAD_FILE_NAME', `非法模型文件名: ${name}`);
    }
    return full;
  }
  partPath(id, name) { return `${this.filePath(id, name)}.part`; }
  markerPath(id) { return path.join(this.modelDir(id), MARKER); }

  getModel(id) { return this.catalog.get(id) || null; }

  status(id) {
    const model = this.getModel(id);
    if (!model) return null;
    const state = this.states.get(id);
    return { id, ...state };
  }

  list() {
    return this.catalog.list().map((model) => this.status(model.id));
  }

  isReady(id) {
    const state = this.states.get(id);
    return !!state && state.state === 'ready';
  }

  _set(id, patch) {
    const current = this.states.get(id) || { state: 'absent', received: 0, total: 0, error: null };
    this.states.set(id, { ...current, ...patch });
  }

  _installedBytes(model) {
    let received = 0;
    for (const file of model.files) {
      const dest = this.filePath(model.id, file.name);
      const part = this.partPath(model.id, file.name);
      try { received += fs.statSync(dest).size; } catch (_) {}
      try { received += fs.statSync(part).size; } catch (_) {}
    }
    return received;
  }

  _sizesMatch(model) {
    for (const file of model.files) {
      let size = -1;
      try { size = fs.statSync(this.filePath(model.id, file.name)).size; } catch (_) {}
      if (size !== file.bytes) return false;
    }
    return true;
  }

  _readMarker(model) {
    try { return JSON.parse(fs.readFileSync(this.markerPath(model.id), 'utf8')); } catch (_) { return null; }
  }

  _markerMatches(model, marker) {
    if (!marker || !marker.files) return false;
    for (const file of model.files) {
      const saved = marker.files[file.name];
      let stat;
      try { stat = fs.statSync(this.filePath(model.id, file.name)); } catch (_) { return false; }
      if (!saved || saved.sha256 !== file.sha256 || saved.bytes !== file.bytes || saved.mtimeMs !== stat.mtimeMs) {
        return false;
      }
    }
    return true;
  }

  _writeMarker(model) {
    const files = {};
    for (const file of model.files) {
      const stat = fs.statSync(this.filePath(model.id, file.name));
      files[file.name] = { sha256: file.sha256, bytes: file.bytes, mtimeMs: stat.mtimeMs };
    }
    fs.writeFileSync(this.markerPath(model.id), `${JSON.stringify({ files }, null, 2)}\n`, 'utf8');
  }

  /** 启动时信任「大小 + 上次校验标记」；没有标记就后台校验，通过前不算 ready。 */
  refreshFromDisk() {
    for (const model of this.catalog.list()) {
      if (this.jobs.has(model.id)) continue;
      const received = this._installedBytes(model);
      if (!this._sizesMatch(model)) {
        this._set(model.id, { state: 'absent', received, total: totalBytes(model), error: null });
        continue;
      }
      const marker = this._readMarker(model);
      if (this._markerMatches(model, marker)) {
        this._set(model.id, { state: 'ready', received, total: totalBytes(model), error: null });
      } else {
        this._set(model.id, { state: 'verifying', received, total: totalBytes(model), error: null });
        setImmediate(() => { this._verifyInstalled(model).catch(() => {}); });
      }
    }
  }

  async _verifyInstalled(model) {
    if (this.verifying.has(model.id) || this.jobs.has(model.id)) return;
    this.verifying.add(model.id);
    try {
      for (const file of model.files) {
        const digest = await sha256File(this.filePath(model.id, file.name));
        if (digest !== file.sha256) {
          this._set(model.id, { state: 'error', error: `${file.name} 校验失败`, received: totalBytes(model), total: totalBytes(model) });
          return;
        }
      }
      this._writeMarker(model);
      this._set(model.id, { state: 'ready', received: totalBytes(model), total: totalBytes(model), error: null });
      try { this.onReady(model); } catch (_) {}
    } catch (error) {
      this._set(model.id, { state: 'error', error: error?.message || String(error), total: totalBytes(model) });
    } finally {
      this.verifying.delete(model.id);
    }
  }

  download(id) {
    const model = this.getModel(id);
    if (!model) throw makeError('MODEL_NOT_FOUND', `未知模型: ${id}`);
    if (this.jobs.has(id)) return this.status(id);
    const controller = new AbortController();
    const job = { controller, cancelled: false, promise: null };
    this.jobs.set(id, job);
    this._set(id, { state: 'downloading', received: this._installedBytes(model), total: totalBytes(model), error: null });
    job.promise = this._run(model, job)
      .then(() => {
        if (job.cancelled) throw makeError('ABORTED', '已取消');
        this._writeMarker(model);
        this._set(id, { state: 'ready', received: totalBytes(model), total: totalBytes(model), error: null });
        try { this.onReady(model); } catch (_) {}
      })
      .catch((error) => {
        if (job.cancelled || isAbort(error) || error?.code === 'ABORTED') {
          this._set(id, { state: 'absent', error: null });
        } else {
          this._set(id, { state: 'error', error: error?.message || String(error) });
        }
      })
      .finally(() => { this.jobs.delete(id); });
    return this.status(id);
  }

  downloadAsync(id) {
    this.download(id);
    const job = this.jobs.get(id);
    return job ? job.promise.then(() => this.status(id)) : Promise.resolve(this.status(id));
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return this.status(id);
    job.cancelled = true;
    try { job.controller.abort(); } catch (_) {}
    return this.status(id);
  }

  async remove(id) {
    const model = this.getModel(id);
    if (!model) throw makeError('MODEL_NOT_FOUND', `未知模型: ${id}`);
    this.cancel(id);
    const job = this.jobs.get(id);
    if (job) { try { await job.promise; } catch (_) {} }
    try {
      await Promise.race([
        Promise.resolve().then(() => this.onRemove(model)),
        new Promise((resolve) => { const timer = setTimeout(resolve, 3000); if (timer.unref) timer.unref(); }),
      ]);
    } catch (_) {}
    try {
      await fsp.rm(this.modelDir(id), { recursive: true, force: true });
    } catch (error) {
      this.refreshFromDisk();
      this._set(id, { state: 'error', error: `删除失败: ${error.message}` });
      throw error;
    }
    this._set(id, { state: 'absent', received: 0, total: totalBytes(model), error: null });
    return this.status(id);
  }

  async _run(model, job) {
    let completed = 0;
    for (const file of model.files) {
      if (job.cancelled) throw makeError('ABORTED', '已取消');
      const dest = this.filePath(model.id, file.name);
      const part = this.partPath(model.id, file.name);
      const size = (() => { try { return fs.statSync(dest).size; } catch (_) { return -1; } })();
      if (size === file.bytes) {
        completed += file.bytes;
        this._set(model.id, { received: completed });
        continue;
      }
      await this._downloadFile(model, file, part, completed, job);
      completed += file.bytes;
      this._set(model.id, { received: completed, total: totalBytes(model) });
    }
    if (job.cancelled) throw makeError('ABORTED', '已取消');
  }

  async _downloadFile(model, file, part, completed, job) {
    fs.mkdirSync(path.dirname(part), { recursive: true });
    let lastError = null;
    for (const url of file.urls) {
      if (job.cancelled) throw makeError('ABORTED', '已取消');
      try {
        await this._fetchToPart(url, model, file, part, completed, job);
        lastError = null;
        break;
      } catch (error) {
        if (job.cancelled || isAbort(error) || error?.code === 'ABORTED') throw makeError('ABORTED', '已取消');
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    if (job.cancelled) throw makeError('ABORTED', '已取消');
    let size = -1;
    try { size = fs.statSync(part).size; } catch (_) {}
    if (size !== file.bytes) {
      throw makeError('SIZE_MISMATCH', `${file.name} 大小不符：${size} / ${file.bytes}`);
    }
    this._set(model.id, { state: 'verifying', received: completed + file.bytes });
    const digest = await sha256File(part, job.controller.signal);
    if (job.cancelled) throw makeError('ABORTED', '已取消');
    if (digest !== file.sha256) {
      try { fs.unlinkSync(part); } catch (_) {}
      throw makeError('SHA256_MISMATCH', `${file.name} 校验失败`);
    }
    if (job.cancelled) throw makeError('ABORTED', '已取消');
    const dest = this.filePath(model.id, file.name);
    try { fs.unlinkSync(dest); } catch (_) {}
    await fsp.rename(part, dest);
    if (job.cancelled) {
      try { fs.unlinkSync(dest); } catch (_) {}
      throw makeError('ABORTED', '已取消');
    }
    this._set(model.id, { state: 'downloading', error: null });
  }

  async _fetchToPart(url, model, file, part, completed, job) {
    let partSize = 0;
    try { partSize = fs.statSync(part).size; } catch (_) {}
    if (partSize === file.bytes) return;
    if (partSize > file.bytes) { try { fs.rmSync(part); } catch (_) {} partSize = 0; }
    const headers = partSize > 0 ? { Range: `bytes=${partSize}-` } : {};
    const response = await this.fetchImpl(url, { headers, signal: job.controller.signal });
    if (response.status === 416 && partSize === file.bytes) return;
    if (!response.ok || !response.body) {
      throw makeError(`HTTP_${response.status}`, `${url} 返回 HTTP ${response.status}`);
    }
    const append = response.status === 206 && partSize > 0;
    if (!append) partSize = 0;
    const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    let written = 0;
    const meter = new Transform({
      transform: (chunk, _encoding, callback) => {
        written += chunk.length;
        this._set(model.id, {
          state: 'downloading',
          received: completed + partSize + written,
          total: totalBytes(model),
        });
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body), meter, out, { signal: job.controller.signal });
    } catch (error) {
      if (job.cancelled || isAbort(error)) throw makeError('ABORTED', '已取消');
      throw error;
    }
    const size = (await fsp.stat(part)).size;
    if (size !== file.bytes) {
      throw makeError('SIZE_MISMATCH', `${file.name} 大小不符：${size} / ${file.bytes}`);
    }
  }
}

module.exports = { ModelStore, sha256File, totalBytes, makeError, TERMINAL_STATES, MARKER };
