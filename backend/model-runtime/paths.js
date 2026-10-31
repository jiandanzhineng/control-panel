// 本地模型运行时的数据目录：与 voice settings 一样跟着 BACKEND_DATA_DIR 走。
const path = require('path');

function dataDir() {
  return process.env.BACKEND_DATA_DIR
    ? path.resolve(process.env.BACKEND_DATA_DIR)
    : path.join(__dirname, '..', 'data');
}

function modelsRoot() {
  return path.join(dataDir(), 'models');
}

function settingsPath() {
  return path.join(dataDir(), 'model-runtime-settings.json');
}

function acceleratorsPath() {
  return path.join(dataDir(), 'model-runtime-accelerators.json');
}

function catalogDir() {
  return process.env.MODEL_RUNTIME_CATALOG_DIR
    ? path.resolve(process.env.MODEL_RUNTIME_CATALOG_DIR)
    : path.join(__dirname, 'catalog', 'models');
}

module.exports = { dataDir, modelsRoot, settingsPath, acceleratorsPath, catalogDir };
