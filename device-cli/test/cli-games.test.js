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

test('games 合并页面游戏与 HostRuntime 游戏并标注载体', async () => {
  const url = await mock.start();
  const { code, stdout } = await runCli(['games', '--api', url, '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.count, 3);
  const byId = Object.fromEntries(payload.games.map((game) => [game.id, game]));
  assert.equal(byId.demo.carrier, 'iframe');
  assert.equal(byId['host-demo'].carrier, 'host');
  assert.equal(byId.shared.carrier, 'iframe/host');
  const table = await runCli(['games', '--api', url], { env: cleanEnv() });
  assert.match(table.stdout, /演示玩法/);
  await mock.close();
});

test('game:start 走客户端 launch，并传 deviceMap/parameters/show', async () => {
  mock = createMockServer();
  const url = await mock.start();
  mock.state.requests.length = 0;
  const { code, stdout } = await runCli([
    'game:start', 'demo', '--device', 'motor=pj-1,di-1', '--param', 'speed=5',
    '--param', 'mode=fast', '--params', '{"duration":30}', '--no-show', '--api', url, '--json'
  ], { env: cleanEnv() });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.via, 'client');
  assert.equal(payload.show, false);
  const launch = mock.state.requests.find((item) => item.path === '/api/client/games/demo/launch');
  assert.deepEqual(launch.body.deviceMap, { motor: ['pj-1', 'di-1'] });
  assert.deepEqual(launch.body.parameters, { duration: 30, speed: 5, mode: 'fast' });
  assert.equal(launch.body.show, false);
  await mock.close();
});

test('客户端不可用时 game:start 回退 /games/:id/start 并改用 deviceMapping', async () => {
  mock = createMockServer({ clientAvailable: false });
  const url = await mock.start();
  mock.state.requests.length = 0;
  const { code, stdout } = await runCli([
    'game:start', 'demo', '--device', 'motor=pj-1', '--param', 'speed=5', '--api', url, '--json'
  ], { env: cleanEnv() });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.via, 'backend');
  const start = mock.state.requests.find((item) => item.path === '/api/games/demo/start');
  assert.ok(start, '应回退到后端启动');
  assert.deepEqual(start.body.deviceMapping, { motor: 'pj-1' });
  assert.deepEqual(start.body.parameters, { speed: 5 });
  assert.equal(start.body.defer, false);
  await mock.close();
});

test('旧版客户端没有 launch 接口（404）时 game:start 回退后端启动', async () => {
  mock = createMockServer({ legacyClient: true });
  const url = await mock.start();
  const { code, stdout } = await runCli([
    'game:start', 'demo', '--device', 'motor=pj-1', '--api', url, '--json'
  ], { env: cleanEnv() });
  assert.equal(code, 0);
  assert.equal(parseJson(stdout).via, 'backend');
  assert.ok(mock.state.requests.find((item) => item.path === '/api/games/demo/start'));
  await mock.close();
});

test('游戏不存在（GAME_NOT_FOUND）时 game:start 不回退', async () => {
  mock = createMockServer();
  const url = await mock.start();
  const { code } = await runCli(['game:start', 'missing', '--api', url], { env: cleanEnv() });
  assert.equal(code, 1);
  assert.ok(!mock.state.requests.find((item) => item.path === '/api/games/missing/start'));
  await mock.close();
});

test('game:start 缺游戏 ID 时报用法错误', async () => {
  const { code, stderr } = await runCli(['game:start', '--api', 'http://127.0.0.1:1'], { env: cleanEnv() });
  assert.equal(code, 2);
  assert.match(stderr, /用法: undersilicon game:start/);
});

test('game:stop 与 game:status', async () => {
  mock = createMockServer();
  const url = await mock.start();
  mock.state.game = { id: 'demo', source: 'client-launch' };
  const status = await runCli(['game:status', '--api', url, '--json'], { env: cleanEnv() });
  assert.equal(status.code, 0);
  assert.equal(parseJson(status.stdout).status.gameId, 'demo');
  const stop = await runCli(['game:stop', '--api', url, '--json'], { env: cleanEnv() });
  assert.equal(stop.code, 0);
  assert.equal(parseJson(stop.stdout).ok, true);
  assert.ok(mock.state.requests.some((item) => item.path === '/api/games/stop-current'));
  await mock.close();
});
