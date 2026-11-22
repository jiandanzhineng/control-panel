// sherpa-onnx 引擎适配（宿主侧）：声明能力、生成子进程配置、校验模型文件。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENGINE_NAME = 'sherpa-onnx';

function readVersion() {
  try {
    return require('sherpa-onnx-node/package.json').version;
  } catch (_) {
    return null;
  }
}

// 默认发行的是 CPU 构建；如果以后加了 GPU 构建，用环境变量或安装描述文件声明。
function supportedProviders() {
  const raw = String(process.env.MR_SHERPA_PROVIDERS || '').trim();
  if (raw) {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.includes('cpu')) list.push('cpu');
    return list;
  }
  return ['cpu'];
}

function buildInfo() {
  return { name: ENGINE_NAME, version: readVersion(), providers: supportedProviders() };
}

function cpuThreads() {
  const cores = os.cpus()?.length || 2;
  return Math.min(4, Math.max(1, Math.floor(cores / 2)));
}

function validateModel(model) {
  const errors = [];
  const config = model?.engineConfig || {};
  if (config.type !== 'sense_voice') errors.push(`不支持的 engineConfig.type: ${config.type}`);
  if (!config.model) errors.push('engineConfig.model 缺失');
  if (!config.tokens) errors.push('engineConfig.tokens 缺失');
  const names = new Set((model?.files || []).map((file) => file.name));
  for (const name of [config.model, config.tokens]) {
    if (name && !names.has(name)) errors.push(`模型文件未在 catalog.files 中声明: ${name}`);
  }
  return errors;
}

/** 子进程加载配置（写进环境变量，避免命令行转义问题）。 */
function workerEnv(model, modelDir, provider) {
  const config = {
    type: model.engineConfig.type,
    model: path.join(modelDir, model.engineConfig.model),
    tokens: path.join(modelDir, model.engineConfig.tokens),
    language: model.engineConfig.language || 'zh',
    useInverseTextNormalization: model.engineConfig.useInverseTextNormalization ? 1 : 0,
  };
  return {
    MR_ENGINE: ENGINE_NAME,
    MR_MODEL_ID: model.id,
    MR_MODEL_DIR: modelDir,
    MR_ENGINE_CONFIG: JSON.stringify(config),
    MR_PROVIDER: provider || 'cpu',
    MR_NUM_THREADS: String(cpuThreads()),
  };
}

function missingFiles(model, modelDir) {
  return (model?.files || []).filter((file) => {
    try { return fs.statSync(path.join(modelDir, file.name)).size !== file.bytes; } catch (_) { return true; }
  }).map((file) => file.name);
}

module.exports = {
  ENGINE_NAME,
  supportedProviders,
  buildInfo,
  cpuThreads,
  validateModel,
  workerEnv,
  missingFiles,
};
