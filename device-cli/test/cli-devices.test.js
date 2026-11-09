'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCli, parseJson, cleanEnv } = require('./support/helpers');
const { createMockServer } = require('./support/mock-server');

let mock;
let baseUrl;

test.before(async () => {
  mock = createMockServer();
  baseUrl = await mock.start();
});

test.after(() => mock.close());

function api() {
  return ['--api', baseUrl];
}

test('devices 表格输出设备列表', async () => {
  const { code, stdout } = await runCli(['devices', ...api()], { env: cleanEnv() });
  assert.equal(code, 0);
  assert.match(stdout, /设备列表（3 台/);
  assert.match(stdout, /pj-1/);
  assert.match(stdout, /在线/);
});

test('devices:list 作为别名输出 JSON', async () => {
  const { code, stdout } = await runCli(['devices:list', ...api(), '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.count, 3);
  assert.equal(payload.devices[0].id, 'pj-1');
});

test('device 显示能力动作参数与预置操作', async () => {
  const { code, stdout } = await runCli(['device', 'pj-1', ...api()], { env: cleanEnv() });
  assert.equal(code, 0);
  assert.match(stdout, /可用能力与动作参数/);
  assert.match(stdout, /strength/);
  assert.match(stdout, /value:0\.\.255/);
  assert.match(stdout, /启动/);
});

test('device 对无能力设备正常输出', async () => {
  const { code, stdout } = await runCli(['device', 'hr-1', ...api()], { env: cleanEnv() });
  assert.equal(code, 0);
  assert.match(stdout, /预置操作/);
});

test('devices:get 支持点号路径与整机输出', async () => {
  const single = await runCli(['devices:get', 'pj-1', 'data.power', ...api()], { env: cleanEnv() });
  assert.equal(single.code, 0);
  assert.equal(single.stdout.trim(), '0');
  const whole = await runCli(['devices:get', 'pj-1', ...api(), '--json'], { env: cleanEnv() });
  const payload = parseJson(whole.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.device.id, 'pj-1');
});

test('devices:set 写入属性并返回当前值', async () => {
  const { code, stdout } = await runCli(['devices:set', 'pj-1', 'name', '新名字', ...api(), '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.key, 'name');
  assert.equal(payload.value, '新名字');
  assert.equal(payload.updated, '新名字');
});

test('设备不存在时透传后端错误码', async () => {
  const { code, stdout } = await runCli(['devices:get', 'missing', ...api(), '--json'], { env: cleanEnv() });
  assert.equal(code, 1);
  const payload = parseJson(stdout);
  assert.equal(payload.error.code, 'DEVICE_NOT_FOUND');
  assert.equal(payload.error.status, 404);
});
