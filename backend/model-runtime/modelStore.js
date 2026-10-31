// 模型下载与本地存储：.part 续传、按 urls 换源、sha256 校验、取消、删除。
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { modelsRoot } = require('./paths');

const TERMINAL_STATES = new Set(['ready', 'error', 'absent']);

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
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
    for (const model of catalog.list()) {
      this.states.set(model.id, { state: 'absent', received: 0, total: totalBytes(model), error: null });
    }
  }

  modelDir(id) { return path.join(this.rootDir, id); }
  filePath(id, name) { return path.join(this.modelDir(id), name); }
  partPath(id, name) { return `${this.filePath(id, name)}.part`; }

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

  /** 启动时只按文件大小判断已就绪，避免每次启动都哈希 230MB。 */
  refreshFromDisk() {
    for (const model of this.catalog.list()) {
      const job = this.jobs.get(model.id);
      if (job) continue;
      let ready = true;
      for (const file of model.files) {
        let size = -1;
        try { size = fs.statSync(this.filePath(model.id, file.name)).size; } catch (_) {}
        if (size !== file.bytes) { ready = false; break; }
      }
      this._set(model.id, {
        state: ready ? 'ready' : 'absent',
        received: this._installedBytes(model),
        total: totalBytes(model),
        error: null,
      });
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
        this._set(id, { state: 'ready', received: totalBytes(model), total: totalBytes(model), error: null });
        try { this.onReady(model); } catch (_) {}
      })
      .catch((error) => {
        if (job.cancelled || error?.code === 'ABORTED') {
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
    try { this.onRemove(model); } catch (_) {}
    await fsp.rm(this.modelDir(id), { recursive: true, force: true });
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
        if (job.cancelled || error?.code === 'ABORTED') throw error;
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    let size = -1;
    try { size = fs.statSync(part).size; } catch (_) {}
    if (size !== file.bytes) {
      throw makeError('SIZE_MISMATCH', `${file.name} 大小不符：${size} / ${file.bytes}`);
    }
    this._set(model.id, { state: 'verifying', received: completed + file.bytes });
    const digest = await sha256File(part);
    if (digest !== file.sha256) {
      try { fs.unlinkSync(part); } catch (_) {}
      throw makeError('SHA256_MISMATCH', `${file.name} 校验失败`);
    }
    const dest = this.filePath(model.id, file.name);
    try { fs.unlinkSync(dest); } catch (_) {}
    await fsp.rename(part, dest);
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
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        written += chunk.length;
        if (!out.write(chunk)) {
          await new Promise((resolve, reject) => {
            const onDrain = () => { out.off('error', onError); resolve(); };
            const onError = (error) => { out.off('drain', onDrain); reject(error); };
            out.once('drain', onDrain);
            out.once('error', onError);
          });
        }
        this._set(model.id, {
          state: 'downloading',
          received: completed + partSize + written,
          total: totalBytes(model),
        });
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (error) {
      out.destroy();
      if (job.cancelled) throw makeError('ABORTED', '已取消');
      throw error;
    }
    const size = fs.statSync(part).size;
    if (size !== file.bytes) {
      throw makeError('SIZE_MISMATCH', `${file.name} 大小不符：${size} / ${file.bytes}`);
    }
  }
}

module.exports = { ModelStore, sha256File, totalBytes, makeError, TERMINAL_STATES };


