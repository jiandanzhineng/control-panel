'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCli, parseJson, cleanEnv } = require('./support/helpers');

test('--version 输出版本号', async () => {
  const { code, stdout } = await runCli(['--version'], { env: cleanEnv() });
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('帮助列出全部命令', async () => {
  const { code, stdout } = await runCli(['--help'], { env: cleanEnv() });
  assert.equal(code, 0);
  for (const name of ['status', 'devices', 'device', 'control', 'op', 'stop', 'games', 'game:start', 'window', 'routes', 'open', 'screenshot', 'events', 'events:recent', 'lease:release', 'mqtt:publish']) {
    assert.ok(stdout.includes(name), `help 应包含 ${name}`);
  }
});

test('help <命令> 显示用法与示例', async () => {
  const { code, stdout } = await runCli(['help', 'control'], { env: cleanEnv() });
  assert.equal(code, 0);
  assert.match(stdout, /用法: undersilicon control/);
  assert.match(stdout, /示例:/);
});

test('未知命令退出码 2 并打印用法提示', async () => {
  const { code, stderr, stdout } = await runCli(['nope'], { env: cleanEnv() });
  assert.equal(code, 2);
  assert.match(`${stderr}${stdout}`, /未知命令: nope/);
});

test('缺参数退出码 2 并打印该命令用法', async () => {
  const { code, stderr } = await runCli(['control', 'dev01'], { env: cleanEnv() });
  assert.equal(code, 2);
  assert.match(stderr, /用法: undersilicon control/);
});

test('连不上后端时给出友好提示并退出 1', async () => {
  const { code, stderr } = await runCli(['devices', '--api', 'http://127.0.0.1:1'], { env: cleanEnv() });
  assert.equal(code, 1);
  assert.match(stderr, /连不上硅基之下控制中心/);
});

test('--json 模式下错误输出统一形状', async () => {
  const { code, stdout } = await runCli(['devices', '--api', 'http://127.0.0.1:1', '--json'], { env: cleanEnv() });
  assert.equal(code, 1);
  const payload = parseJson(stdout);
  assert.equal(payload.ok, false);
  assert.equal(typeof payload.error.code, 'string');
  assert.equal(typeof payload.error.message, 'string');
  assert.equal(typeof payload.error.status, 'number');
});
