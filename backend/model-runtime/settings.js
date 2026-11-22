// 每个任务的本地模型设置：是否启用、首选模型、推理设备。
const fs = require('fs');
const path = require('path');
const { settingsPath } = require('./paths');

const PROVIDER_RE = /^(auto|[a-z0-9_-]{1,32})$/;
const PROVIDERS = ['auto', 'cuda', 'directml', 'npu', 'cpu'];
const TASK_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
let memory;

function defaults() {
  return { tasks: Object.create(null) };
}

function isTaskName(task) { return TASK_RE.test(String(task || '')); }

function ensureTask(state, task) {
  if (!Object.hasOwn(state.tasks, task)) {
    state.tasks[task] = { localEnabled: false, model: null, provider: 'auto', configured: false };
  }
  return state.tasks[task];
}

function load() {
  if (memory !== undefined) return memory;
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {};
    memory = defaults();
    for (const [task, value] of Object.entries(saved.tasks || {})) {
      if (!isTaskName(task)) continue;
      const entry = ensureTask(memory, task);
      if (typeof value.localEnabled === 'boolean') entry.localEnabled = value.localEnabled;
      if (value.model === null || typeof value.model === 'string') entry.model = value.model || null;
      if (PROVIDER_RE.test(String(value.provider || ''))) entry.provider = value.provider;
      if (value.configured === true) entry.configured = true;
    }
  } catch {
    memory = defaults();
  }
  return memory;
}

function persist() {
  const dest = settingsPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(load(), null, 2)}\n`, 'utf8');
}

function get(task) {
  if (!isTaskName(task)) return { localEnabled: false, model: null, provider: 'auto', configured: false };
  return { ...ensureTask(load(), task) };
}

function all() {
  const state = load();
  const out = Object.create(null);
  for (const [task, value] of Object.entries(state.tasks)) out[task] = { ...value };
  return out;
}

function update(task, patch = {}) {
  if (!isTaskName(task)) {
    const error = new Error(`非法任务名: ${task}`);
    error.code = 'INVALID_TASK';
    throw error;
  }
  const entry = ensureTask(load(), task);
  if (typeof patch.localEnabled === 'boolean') entry.localEnabled = patch.localEnabled;
  if (patch.model === null || typeof patch.model === 'string') entry.model = patch.model || null;
  if (PROVIDER_RE.test(String(patch.provider || ''))) entry.provider = patch.provider;
  if (patch.localEnabled !== undefined || patch.model !== undefined || patch.provider !== undefined) {
    entry.configured = true;
  }
  persist();
  return { ...entry };
}

/** 模型下载完成后：这个任务还没被用户设置过，就自动启用本地。 */
function markDownloaded(task) {
  const entry = ensureTask(load(), task);
  if (entry.configured) return { ...entry };
  entry.localEnabled = true;
  entry.configured = true;
  persist();
  return { ...entry };
}

function resetForTests() { memory = undefined; }

module.exports = { PROVIDERS, PROVIDER_RE, TASK_RE, isTaskName, get, all, update, markDownloaded, resetForTests };
