'use strict';

const { UsageError } = require('./errors');

const DEFAULT_BASE_URL = 'http://127.0.0.1:5278/api';
const DEFAULT_CLIENT_ID = 'undersilicon-cli';
const DEFAULT_LEASE_TTL = 600;
const ALLOWED_CAPABILITIES = ['strength', 'shock', 'vibration', 'suction', 'estim', 'motors', 'pump'];

function normalizeBaseUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return DEFAULT_BASE_URL;
  let url = raw.replace(/\/+$/, '');
  if (!/\/api$/i.test(url)) url = `${url}/api`;
  return url;
}

function parsePercent(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 100) {
    throw new UsageError(`${label} 需要 0-100 的整数，收到: ${value}`);
  }
  return number;
}

function parseCapLimit(input) {
  const raw = String(input || '').trim();
  if (!raw) return {};
  const capabilities = {};
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const [name, value] = item.split('=');
    const key = String(name || '').trim();
    if (!ALLOWED_CAPABILITIES.includes(key)) {
      throw new UsageError(`--cap-limit 只支持: ${ALLOWED_CAPABILITIES.join(', ')}，收到: ${key}`);
    }
    if (value === undefined || value === '') {
      throw new UsageError(`--cap-limit 缺少 ${key} 的百分比，例如 ${key}=30`);
    }
    capabilities[key] = parsePercent(value, `--cap-limit ${key}`);
  }
  return capabilities;
}

function parseLeaseTtl(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 5 || number > 600) {
    throw new UsageError(`--lease-ttl 需要 5-600 的整数，收到: ${value}`);
  }
  return number;
}

/**
 * 合并命令行、环境变量与默认值。环境变量优先级低于命令行。
 */
function resolveConfig(parsed) {
  const values = parsed.values;
  const env = process.env;
  const apiInput =
    values.api || values['base-url'] || env.UNDERSILICON_API ||
    env.DEVICE_CLI_BASE_URL || env.API_BASE_URL || '';
  const json = values.json === true ||
    String(values.format || '').toLowerCase() === 'json';

  // events:recent 的 --limit 是条数，不是限幅百分比，命令层自行消费。
  const limitFlag = parsed.command === 'events:recent' ? undefined : values.limit;
  const limitInput = limitFlag !== undefined ? limitFlag : env.UNDERSILICON_LIMIT;
  const capInput = values['cap-limit'] !== undefined ? values['cap-limit'] : env.UNDERSILICON_CAP_LIMIT;
  const ttlInput = values['lease-ttl'] !== undefined ? values['lease-ttl'] : env.UNDERSILICON_LEASE_TTL;

  let limit = null;
  let capabilities = {};
  if (limitInput !== undefined && limitInput !== '' && limitInput !== null) {
    limit = parsePercent(limitInput, '--limit');
  }
  if (capInput !== undefined && capInput !== '') capabilities = parseCapLimit(capInput);
  if (limit === null && Object.keys(capabilities).length > 0) limit = 100;

  return {
    baseUrl: normalizeBaseUrl(apiInput),
    json,
    clientId: String(env.UNDERSILICON_CLIENT_ID || DEFAULT_CLIENT_ID).trim() || DEFAULT_CLIENT_ID,
    leaseTtl: ttlInput !== undefined && ttlInput !== '' ? parseLeaseTtl(ttlInput) : DEFAULT_LEASE_TTL,
    limits: limit === null ? null : { default: limit, capabilities }
  };
}

module.exports = {
  DEFAULT_BASE_URL, DEFAULT_CLIENT_ID, DEFAULT_LEASE_TTL, ALLOWED_CAPABILITIES,
  normalizeBaseUrl, parseCapLimit, resolveConfig
};
