'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgv } = require('../lib/args');
const { resolveConfig, normalizeBaseUrl, parseCapLimit } = require('../lib/config');
const { UsageError } = require('../lib/errors');

function withEnv(env, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('parseArgv 支持 --api=、别名与全局 json', () => {
  const parsed = parseArgv(['devices', '--api=http://127.0.0.1:5330', '--json']);
  assert.equal(parsed.command, 'devices');
  assert.equal(parsed.values.api, 'http://127.0.0.1:5330');
  assert.equal(parsed.values.json, true);
});

test('parseArgv 支持 -b、--base-url 与 -f json', () => {
  const a = parseArgv(['devices', '-b', 'http://h:1']);
  assert.equal(a.values['base-url'], 'http://h:1');
  const b = parseArgv(['devices', '--base-url', 'http://h:2']);
  assert.equal(b.values['base-url'], 'http://h:2');
  const c = parseArgv(['devices', '-f', 'json']);
  assert.equal(c.values.format, 'json');
});

test('parseArgv 保留 key=value 位置参数', () => {
  const parsed = parseArgv(['control', 'dev01', 'strength', 'set', 'value=120', 'flag=false']);
  assert.deepEqual(parsed.positionals, ['dev01', 'strength', 'set', 'value=120', 'flag=false']);
});

test('parseArgv 缺少选项值时报用法错误', () => {
  assert.throws(() => parseArgv(['devices', '--api']), UsageError);
});

test('normalizeBaseUrl 自动补 /api', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:5330'), 'http://127.0.0.1:5330/api');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:5330/'), 'http://127.0.0.1:5330/api');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:5330/api/'), 'http://127.0.0.1:5330/api');
  assert.equal(normalizeBaseUrl(''), 'http://127.0.0.1:5278/api');
});

test('resolveConfig 读取环境变量并兼容旧变量名', () => {
  withEnv({ UNDERSILICON_API: 'http://a:1', DEVICE_CLI_BASE_URL: 'http://b:2', API_BASE_URL: 'http://c:3' }, () => {
    assert.equal(resolveConfig(parseArgv(['devices'])).baseUrl, 'http://a:1/api');
  });
  withEnv({ UNDERSILICON_API: undefined, DEVICE_CLI_BASE_URL: 'http://b:2', API_BASE_URL: undefined }, () => {
    assert.equal(resolveConfig(parseArgv(['devices'])).baseUrl, 'http://b:2/api');
  });
});

test('限幅：只给 cap-limit 时 default=100', () => {
  withEnv({ UNDERSILICON_LIMIT: undefined, UNDERSILICON_CAP_LIMIT: undefined }, () => {
    const parsed = parseArgv(['control', 'd', 'shock', 'start', '--cap-limit', 'shock=30']);
    const config = resolveConfig(parsed);
    assert.deepEqual(config.limits, { default: 100, capabilities: { shock: 30 } });
  });
});

test('限幅：--limit 与 cap-limit 同时生效', () => {
  const parsed = parseArgv(['control', 'd', 'shock', 'start', '--limit', '50', '--cap-limit=strength=60']);
  const config = resolveConfig(parsed);
  assert.deepEqual(config.limits, { default: 50, capabilities: { strength: 60 } });
  assert.equal(config.leaseTtl, 600);
});

test('限幅：非法能力名与越界百分比报用法错误', () => {
  assert.throws(() => parseCapLimit('foo=30'), UsageError);
  assert.throws(() => parseCapLimit('shock=130'), UsageError);
  assert.throws(() => resolveConfig(parseArgv(['control', '--limit', '101', 'd', 'x', 'y'])), UsageError);
});

test('events:recent 的 --limit 不当作限幅', () => {
  const config = resolveConfig(parseArgv(['events:recent', '--limit', '20']));
  assert.equal(config.limits, null);
});
