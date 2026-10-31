// 模型目录：每个模型一个 JSON，启动时校验格式；目录只描述「有什么」，不含状态。
const fs = require('fs');
const path = require('path');
const { catalogDir } = require('../paths');

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateFile(file, errors, where) {
  if (!file || typeof file !== 'object') return errors.push(`${where}: file 必须是对象`);
  if (!isNonEmptyString(file.name)) errors.push(`${where}: file.name 缺失`);
  if (!Number.isInteger(file.bytes) || file.bytes <= 0) errors.push(`${where}: file.bytes 必须是正整数`);
  if (!HASH_RE.test(String(file.sha256 || ''))) errors.push(`${where}: file.sha256 必须是 64 位小写十六进制`);
  if (!Array.isArray(file.urls) || file.urls.length === 0) errors.push(`${where}: file.urls 不能为空`);
  for (const url of file.urls || []) {
    if (!/^https?:\/\//i.test(String(url))) errors.push(`${where}: 非法下载地址 ${url}`);
  }
}

function validateModel(model) {
  const errors = [];
  if (!model || typeof model !== 'object') return ['模型条目必须是对象'];
  if (!ID_RE.test(String(model.id || ''))) errors.push('id 只能是小写字母数字和 ._-，最长 64');
  if (!isNonEmptyString(model.task)) errors.push('task 缺失');
  if (!isNonEmptyString(model.title?.zh) || !isNonEmptyString(model.title?.en)) errors.push('title 需要中英文');
  if (!isNonEmptyString(model.engine)) errors.push('engine 缺失');
  if (!model.engineConfig || typeof model.engineConfig !== 'object') errors.push('engineConfig 缺失');
  if (!isNonEmptyString(model.engineConfig?.type)) errors.push('engineConfig.type 缺失');
  if (!Array.isArray(model.files) || model.files.length === 0) errors.push('files 不能为空');
  (model.files || []).forEach((file, i) => validateFile(file, errors, `files[${i}]`));
  if (!Array.isArray(model.providers) || model.providers.length === 0) errors.push('providers 不能为空');
  if (!model.license || !isNonEmptyString(model.license.name)) errors.push('license.name 缺失');
  if (typeof model.recommended !== 'boolean') errors.push('recommended 必须是布尔值');
  return errors;
}

function loadCatalog(dir = catalogDir()) {
  const models = [];
  const invalid = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (error) {
    return { models, invalid: [{ file: dir, errors: [error.message] }] };
  }
  for (const file of files.sort()) {
    const full = path.join(dir, file);
    let model;
    try {
      model = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (error) {
      invalid.push({ file, errors: [`JSON 解析失败: ${error.message}`] });
      continue;
    }
    const errors = validateModel(model);
    if (errors.length) invalid.push({ file, errors });
    else models.push(model);
  }
  return { models, invalid };
}

module.exports = { validateModel, loadCatalog, ID_RE, HASH_RE };
