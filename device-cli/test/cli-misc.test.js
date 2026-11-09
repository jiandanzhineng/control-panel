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

test('status 汇总客户端、模式、游戏与租约', async () => {
  const url = await mock.start();
  mock.state.leases.set('agent-1', {
    limits: { default: 30, capabilities: {} },
    ttlSec: 60, expiresAtMs: Date.now() + 60000,
    fieldCaps: { power: 76 }
  });
  const { code, stdout } = await runCli(['status', '--api', url, '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.client.available, true);
  assert.equal(payload.mode, 'local');
  assert.equal(payload.agentLease.active, true);
  assert.equal(payload.agentLease.leases[0].clientId, 'agent-1');
  const table = await runCli(['status', '--api', url], { env: cleanEnv() });
  assert.match(table.stdout, /客户端/);
  assert.match(table.stdout, /Agent 租约/);
  await mock.close();
});

test('status 对 404 的 agent 接口显示不支持而不失败', async () => {
  mock = createMockServer({ unsupportedAgent: true });
  const url = await mock.start();
  const { code, stdout } = await runCli(['status', '--api', url, '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.clientSupported, false);
  assert.equal(payload.agentLeaseSupported, false);
  const table = await runCli(['status', '--api', url], { env: cleanEnv() });
  assert.match(table.stdout, /不支持/);
  await mock.close();
});

test('lease:release 调用 DELETE 并回显停止的玩法', async () => {
  mock = createMockServer();
  const url = await mock.start();
  mock.state.leases.set('undersilicon-cli', { limits: {}, ttlSec: 600, expiresAtMs: Date.now() + 60000, fieldCaps: {} });
  const { code, stdout } = await runCli(['lease:release', '--api', url, '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.clientId, 'undersilicon-cli');
  assert.equal(payload.result.released, true);
  assert.deepEqual(payload.result.stopped, ['host']);
  const call = mock.state.requests.find((item) => item.method === 'DELETE' && item.path === '/api/agent-control/lease/undersilicon-cli');
  assert.ok(call);
  await mock.close();
});

test('lease:release 不会先建租约', async () => {
  mock = createMockServer();
  const url = await mock.start();
  mock.state.requests.length = 0;
  const { code } = await runCli(['lease:release', '--limit', '20', '--api', url, '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  assert.equal(mock.state.requests.filter((item) => item.method === 'POST').length, 0);
  await mock.close();
});

test('mqtt:publish 自动 topic 时按 JSON 发原始报文', async () => {
  mock = createMockServer();
  const url = await mock.start();
  mock.state.requests.length = 0;
  const { code } = await runCli(['mqtt:publish', 'pj-1', '{"method":"stop"}', '--api', url, '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const call = mock.state.requests.find((item) => item.path === '/api/mqtt-client/publish');
  assert.deepEqual(call.body, { topic: '/drecv/pj-1', message: { method: 'stop' } });
  await mock.close();
});

test('mqtt:publish 支持自定义 topic', async () => {
  mock = createMockServer();
  const url = await mock.start();
  mock.state.requests.length = 0;
  const { code } = await runCli(['mqtt:publish', 'pj-1', '/custom/topic', 'hello', '--api', url, '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const call = mock.state.requests.find((item) => item.path === '/api/mqtt-client/publish');
  assert.deepEqual(call.body, { topic: '/custom/topic', message: 'hello' });
  await mock.close();
});
