'use strict';

const { UsageError } = require('./errors');

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function parseValueToken(input) {
  const text = String(input);
  if (NUMBER_RE.test(text)) return Number(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text;
}

/** 把 ["value=120", "mode=fast"] 解析成 {value:120, mode:"fast"}。 */
function parseKeyValueTokens(tokens, label = '参数') {
  const result = {};
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq <= 0) throw new UsageError(`${label} 需要 key=value 形式，收到: ${token}`);
    const key = token.slice(0, eq).trim();
    result[key] = parseValueToken(token.slice(eq + 1));
  }
  return result;
}

function parseJsonObject(input, label) {
  if (input === undefined || input === null || input === true) return {};
  try {
    const value = JSON.parse(String(input));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch {
    throw new UsageError(`${label} 需要合法的 JSON 对象，收到: ${input}`);
  }
}

function getProperty(data, keyPath) {
  return String(keyPath).split('.').reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    return current[key];
  }, data);
}

function pickPositional(positionals, index, fallbacks = [], values = {}) {
  for (const name of fallbacks) {
    const value = values[name];
    if (value !== undefined && value !== true && value !== '') return String(value);
  }
  const value = positionals[index];
  return value === undefined ? '' : String(value);
}

function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 事件一行摘要：类型 + 最有信息量的字段。 */
function summarizeEvent(event) {
  const type = event.type || '';
  const parts = [];
  for (const key of ['deviceId', 'gameId', 'gameName', 'path', 'action', 'mode', 'role', 'reason', 'clientId']) {
    if (event[key] !== undefined && event[key] !== null && event[key] !== '') {
      parts.push(`${key}=${event[key]}`);
    }
  }
  if (event.window) parts.push(`window=${JSON.stringify(event.window)}`);
  return parts.length ? `${type} ${parts.join(' ')}` : type;
}

function parseIdList(input) {
  return String(input || '').split(',').map((item) => item.trim()).filter(Boolean);
}

module.exports = {
  parseValueToken, parseKeyValueTokens, parseJsonObject, getProperty,
  pickPositional, timestamp, formatTime, summarizeEvent, parseIdList
};
