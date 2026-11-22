'use strict';

// 真实后端实测中发现的问题的回归测试。
const test = require('node:test');
const assert = require('node:assert/strict');
const { runCli, parseJson, cleanEnv } = require('./support/helpers');
const { createMockServer } = require('./support/mock-server');
const { renderTable } = require('../lib/output');

let mock;
let baseUrl;

test.before(async () => {
  mock = createMockServer();
  baseUrl = await mock.start();
});

test.after(() => mock.close());

function lastNavigate() {
  const hits = mock.state.requests.filter((r) => r.path === '/api/client/navigate');
  return hits[hits.length - 1];
}

test('后端 {error:{code,message}} 错误能显示出 message 与 code', async () => {
  const { code, stderr } = await runCli(['control', 'nope', 'strength', 'set', 'value=1', '--api', baseUrl], { env: cleanEnv() });
  assert.equal(code, 1);
  assert.match(stderr, /设备不存在/);
  assert.match(stderr, /DEVICE_NOT_FOUND/);
  assert.doesNotMatch(stderr, /object Object/);
});

test('open 支持不带斜杠的路径', async () => {
  const { code } = await runCli(['open', 'devices', '--api', baseUrl, '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  assert.equal(lastNavigate().body.path, '/devices');
});

test('open 还原被 Git Bash 改写成 Windows 路径的路由', async () => {
  const { code, stdout } = await runCli(['open', 'C:/Program Files/Git/devices', '--api', baseUrl, '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  assert.equal(parseJson(stdout).path, '/devices');
  assert.equal(lastNavigate().body.path, '/devices');
});

test('open 改写路径匹配不到清单时给出用法错误', async () => {
  const { code, stderr } = await runCli(['open', 'C:/Program Files/Git/nosuch', '--api', baseUrl], { env: cleanEnv() });
  assert.equal(code, 2);
  assert.match(stderr, /undersilicon open plays/);
});

test('表格按中文显示宽度对齐，超长单元格截断', () => {
  const text = renderTable([{ a: '中文', b: 'x' }, { a: 'ab', b: 'y'.repeat(300) }], ['a', 'b']);
  const lines = text.split('\n');
  assert.ok(lines[2].startsWith('中文 |'));
  assert.ok(lines[3].startsWith('ab   |'));
  assert.ok(lines[3].endsWith('…'));
  assert.ok(lines[3].length < 140);
});
