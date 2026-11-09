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

function lastWrite() {
  const writes = mock.state.requests.filter((item) => item.method === 'POST');
  return writes[writes.length - 1];
}

test('control 按严格类型解析 key=value', async () => {
  const { code, stdout } = await runCli(
    ['control', 'pj-1', 'strength', 'set', 'value=120', 'smooth=true', 'mode=fast', ...api(), '--json'],
    { env: cleanEnv() }
  );
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.deepEqual(payload.input, { value: 120, smooth: true, mode: 'fast' });
  const request = lastWrite();
  assert.equal(request.path, '/api/devices/pj-1/capabilities/strength/actions/set');
  assert.deepEqual(request.body, { input: { value: 120, smooth: true, mode: 'fast' } });
});

test('control 支持 --input JSON（--input 覆盖同名 key=value）', async () => {
  const { code, stdout } = await runCli(
    ['control', 'di-1', 'shock', 'start', '--input', '{"voltage":30}', 'voltage=40', ...api(), '--json'],
    { env: cleanEnv() }
  );
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.input.voltage, 30);
});

test('control 的 --input 非法 JSON 报用法错误', async () => {
  const { code, stderr } = await runCli(
    ['control', 'di-1', 'shock', 'start', '--input', '{bad', ...api()],
    { env: cleanEnv() }
  );
  assert.equal(code, 2);
  assert.match(stderr, /--input 需要合法的 JSON 对象/);
});

test('op 执行预置操作并发送 params', async () => {
  const { code, stdout } = await runCli(
    ['op', 'pj-1', 'start', 'speed=5', ...api(), '--json'],
    { env: cleanEnv() }
  );
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.operation, 'start');
  assert.deepEqual(payload.params, { speed: 5 });
  assert.equal(lastWrite().path, '/api/devices/pj-1/operations/start');
});

test('op 支持 --params JSON', async () => {
  const { code, stdout } = await runCli(
    ['op', 'pj-1', 'start', '--params', '{"level":3}', ...api(), '--json'],
    { env: cleanEnv() }
  );
  assert.equal(code, 0);
  assert.deepEqual(parseJson(stdout).params, { level: 3 });
});
