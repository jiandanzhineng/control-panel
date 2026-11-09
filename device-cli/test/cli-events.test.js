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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSse(count, timeoutMs = 3000) {
  const started = Date.now();
  while (mock.state.sse.size < count) {
    if (Date.now() - started > timeoutMs) throw new Error('SSE 未连接');
    await delay(20);
  }
}

test('events --json 每条事件一行并忽略 hello/ping，达到 count 退出', async () => {
  const url = await mock.start();
  const child = runCli(['events', '--count', '2', '--timeout', '10', '--api', url, '--json'], { env: cleanEnv() });
  await waitForSse(1);
  mock.emit({ type: 'device.added', deviceId: 'pj-1' });
  mock.emit({ type: 'game.started', gameId: 'demo' });
  const { code, stdout } = await child;
  assert.equal(code, 0);
  const lines = stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const events = lines.map((line) => parseJson(line));
  assert.deepEqual(events.map((event) => event.type), ['device.added', 'game.started']);
  await mock.close();
});

test('events 表格模式输出 时间 类型 摘要，并按 --types 过滤', async () => {
  mock = createMockServer();
  const url = await mock.start();
  const child = runCli(['events', '--types', 'game', '--count', '1', '--timeout', '10', '--api', url], { env: cleanEnv() });
  await waitForSse(1);
  mock.emit({ type: 'device.added', deviceId: 'ignored' });
  await delay(100);
  mock.emit({ type: 'game.started', gameId: 'demo', carrier: 'host' });
  const { code, stdout } = await child;
  assert.equal(code, 0);
  assert.match(stdout, /\d{2}:\d{2}:\d{2} game\.started/);
  assert.match(stdout, /gameId=demo/);
  assert.doesNotMatch(stdout, /device\.added/);
  await mock.close();
});

test('events --timeout 到点退出 0', async () => {
  mock = createMockServer();
  const url = await mock.start();
  const startedAt = Date.now();
  const { code } = await runCli(['events', '--timeout', '0.6', '--api', url, '--json'], { env: cleanEnv() });
  const elapsed = Date.now() - startedAt;
  assert.equal(code, 0);
  assert.ok(elapsed >= 550 && elapsed < 5000, `耗时 ${elapsed}ms`);
  await mock.close();
});

test('events:recent 的 --limit 是条数', async () => {
  mock = createMockServer();
  const url = await mock.start();
  for (let i = 0; i < 5; i += 1) mock.emit({ type: 'device.updated', deviceId: `d${i}` });
  const { code, stdout } = await runCli(['events:recent', '--limit', '3', '--api', url, '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.count, 3);
  assert.equal(payload.limit, 3);
  assert.equal(mock.state.requests.some((item) => item.path === '/api/agent-control/lease'), false);
  await mock.close();
});
