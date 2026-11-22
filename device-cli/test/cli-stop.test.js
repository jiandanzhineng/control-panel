'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCli, parseJson, cleanEnv } = require('./support/helpers');
const { createMockServer } = require('./support/mock-server');

let mock;

test.before(async () => {
  mock = createMockServer();
});

test.after(() => mock.close());

test('stop 依次执行 stop-all 与 stop-current', async () => {
  const url = await mock.start();
  mock.state.requests.length = 0;
  const { code, stdout } = await runCli(['stop', '--reason', '测试结束', '--api', url, '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.reason, '测试结束');
  assert.deepEqual(payload.steps.map((step) => step.step), ['device-watchdog/stop-all', 'games/stop-current']);
  const stopAll = mock.state.requests.find((item) => item.path === '/api/device-watchdog/stop-all');
  assert.equal(stopAll.body.reason, '测试结束');
  await mock.close();
});

test('stop-all 返回 423 时回退远程急停', async () => {
  mock = createMockServer({ remoteMode: true });
  const url = await mock.start();
  mock.state.requests.length = 0;
  const { code, stdout } = await runCli(['stop', '--api', url, '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.deepEqual(payload.steps.map((step) => [step.step, step.ok]), [
    ['remote-session/emergency-stop', true],
    ['games/stop-current', true]
  ]);
  assert.ok(mock.state.requests.some((item) => item.path === '/api/remote-session/emergency-stop'));
  await mock.close();
});

test('急停任一失败时退出码非 0', async () => {
  mock = createMockServer({ failStopCurrent: true });
  const url = await mock.start();
  const { code, stdout } = await runCli(['stop', '--api', url, '--json'], { env: cleanEnv() });
  assert.notEqual(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.steps[1].ok, false);
  assert.equal(payload.steps[1].error.code, 'GAME_STOP_FAILED');
  await mock.close();
});
