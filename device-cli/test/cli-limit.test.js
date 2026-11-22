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

function requestsTo(path) {
  return mock.state.requests.filter((item) => item.path === path);
}

test('未开启限幅时不建租约、不带 X-Agent-Client', async () => {
  mock.state.requests.length = 0;
  const { code, stdout } = await runCli(['control', 'pj-1', 'strength', 'set', 'value=10', ...api(), '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  assert.equal(requestsTo('/api/agent-control/lease').length, 0);
  const write = mock.state.requests.find((item) => item.path.includes('/capabilities/'));
  assert.equal(write.headers['x-agent-client'], undefined);
  assert.equal(parseJson(stdout).lease, null);
});

test('--limit 时先建租约，写请求带租约头并回传 fieldCaps', async () => {
  mock.state.requests.length = 0;
  const { code, stdout } = await runCli(
    ['control', 'pj-1', 'strength', 'set', 'value=120', '--limit', '50', ...api(), '--json'],
    { env: cleanEnv() }
  );
  assert.equal(code, 0);
  const lease = requestsTo('/api/agent-control/lease')[0];
  assert.ok(lease, '应先创建租约');
  assert.deepEqual(lease.body, {
    clientId: 'undersilicon-cli',
    ttlSec: 600,
    limits: { default: 50, capabilities: {} }
  });
  const write = mock.state.requests.find((item) => item.path.includes('/capabilities/'));
  assert.equal(write.headers['x-agent-client'], 'undersilicon-cli');
  const payload = parseJson(stdout);
  assert.equal(payload.lease.fieldCaps.power, 127);
  assert.equal(payload.scaling.requested, 120);
  assert.equal(payload.scaling.cap, 127);
  assert.equal(payload.scaling.capped, false);
});

test('超过上限时输出缩放信息', async () => {
  const { code, stdout } = await runCli(
    ['control', 'pj-1', 'strength', 'set', 'value=200', '--limit', '50', ...api(), '--json'],
    { env: cleanEnv() }
  );
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.scaling.capped, true);
  assert.equal(payload.scaling.applied, 127);
});

test('只给 --cap-limit 时租约 default=100', async () => {
  mock.state.requests.length = 0;
  const { code } = await runCli(
    ['control', 'di-1', 'shock', 'start', 'voltage=80', '--cap-limit', 'shock=30', ...api(), '--json'],
    { env: cleanEnv() }
  );
  assert.equal(code, 0);
  const lease = requestsTo('/api/agent-control/lease')[0];
  assert.deepEqual(lease.body.limits, { default: 100, capabilities: { shock: 30 } });
});

test('租约环境变量可覆盖 clientId、TTL 与限幅', async () => {
  mock.state.requests.length = 0;
  const { code } = await runCli(
    ['control', 'pj-1', 'strength', 'set', 'value=10', ...api(), '--json'],
    { env: cleanEnv({ UNDERSILICON_CLIENT_ID: 'agent-x', UNDERSILICON_LIMIT: '25', UNDERSILICON_LEASE_TTL: '30' }) }
  );
  assert.equal(code, 0);
  const lease = requestsTo('/api/agent-control/lease')[0];
  assert.deepEqual(lease.body, {
    clientId: 'agent-x', ttlSec: 30, limits: { default: 25, capabilities: {} }
  });
});

test('读命令即使用 --limit 也不建租约', async () => {
  mock.state.requests.length = 0;
  const { code } = await runCli(['devices', '--limit', '30', ...api(), '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  assert.equal(requestsTo('/api/agent-control/lease').length, 0);
  assert.equal(mock.state.requests[0].headers['x-agent-client'], undefined);
});

test('租约接口 404 时 fail-closed 并提示升级', async () => {
  const legacy = createMockServer({ unsupportedLease: true });
  const legacyUrl = await legacy.start();
  try {
    const { code, stdout } = await runCli(
      ['control', 'pj-1', 'strength', 'set', 'value=10', '--limit', '50', '--api', legacyUrl, '--json'],
      { env: cleanEnv() }
    );
    assert.equal(code, 1);
    const payload = parseJson(stdout);
    assert.equal(payload.error.code, 'AGENT_LIMIT_UNSUPPORTED');
    assert.match(payload.error.message, /当前客户端不支持限幅，请升级/);
    const writes = legacy.state.requests.filter((item) => item.path.includes('/capabilities/'));
    assert.equal(writes.length, 0, '不能在不限幅的情况下继续写设备');
  } finally {
    await legacy.close();
  }
});

test('急停不建租约、不受限幅影响', async () => {
  mock.state.requests.length = 0;
  const { code } = await runCli(['stop', '--limit', '10', ...api(), '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  assert.equal(requestsTo('/api/agent-control/lease').length, 0);
  const stopAll = mock.state.requests.find((item) => item.path === '/api/device-watchdog/stop-all');
  assert.equal(stopAll.headers['x-agent-client'], undefined);
  assert.equal(stopAll.body.clientId, 'undersilicon-cli');
});
