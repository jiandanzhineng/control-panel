'use strict';

const { UsageError } = require('./errors');

// 需要读取下一个 token 作为值的选项；可附带 = 写法。
const VALUE_FLAGS = new Set([
  'api', 'base-url', 'b', 'format', 'f',
  'limit', 'cap-limit', 'lease-ttl',
  'input', 'params', 'param', 'device', 'reason',
  'types', 'count', 'timeout', 'max-width',
  'id', 'i', 'deviceId', 'd', 'key', 'k', 'value', 'v',
  'topic', 't', 'payload', 'p'
]);

const BOOLEAN_FLAGS = new Set([
  'json', 'jpeg', 'no-show', 'help', 'h', 'version'
]);

function normalizeName(raw) {
  if (raw === 'h') return 'help';
  if (raw === 'f') return 'format';
  if (raw === 'b') return 'base-url';
  if (raw === 'j') return 'json';
  if (raw === 'i') return 'id';
  if (raw === 'd') return 'deviceId';
  if (raw === 'k') return 'key';
  if (raw === 'v') return 'value';
  if (raw === 't') return 'topic';
  if (raw === 'p') return 'payload';
  return raw;
}

function isFlag(token) {
  return typeof token === 'string' && token.startsWith('-') && token !== '-';
}

/**
 * 通用 argv 解析：全局选项与命令选项不分先后。
 * 返回 { command, positionals, values, multi }，其中 values 只保留最后一次出现的值，
 * multi 收集可重复的 --param / --device。
 */
function parseArgv(argv) {
  const positionals = [];
  const values = Object.create(null);
  const multi = { param: [], device: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!isFlag(token)) {
      positionals.push(token);
      continue;
    }
    const raw = token.startsWith('--') ? token.slice(2) : token.slice(1);
    const eq = raw.indexOf('=');
    const name = normalizeName(eq >= 0 ? raw.slice(0, eq) : raw);
    if (!name) throw new UsageError(`无法识别的参数: ${token}`);
    let value = eq >= 0 ? raw.slice(eq + 1) : undefined;

    if (value === undefined) {
      if (BOOLEAN_FLAGS.has(name)) {
        value = true;
      } else if (VALUE_FLAGS.has(name)) {
        const next = argv[index + 1];
        if (next === undefined || isFlag(next)) {
          throw new UsageError(`选项 --${name} 需要提供值`);
        }
        value = next;
        index += 1;
      } else {
        // 未知选项按布尔处理，让命令层给出更具体的用法提示。
        value = true;
      }
    }

    if ((name === 'param' || name === 'device') && value !== true) {
      multi[name].push(String(value));
      continue;
    }
    values[name] = value;
  }

  return {
    command: positionals[0] || 'help',
    positionals: positionals.slice(1),
    values,
    multi
  };
}

module.exports = { parseArgv, VALUE_FLAGS, BOOLEAN_FLAGS };
