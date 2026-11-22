'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

test('window 合法动作成功，非法动作退出码 2', async () => {
  const ok = await runCli(['window', 'hide', ...api(), '--json'], { env: cleanEnv() });
  assert.equal(ok.code, 0);
  assert.equal(parseJson(ok.stdout).action, 'hide');
  const bad = await runCli(['window', 'explode', ...api()], { env: cleanEnv() });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /用法: undersilicon window/);
});

test('routes 列出可导航页面', async () => {
  const { code, stdout } = await runCli(['routes', ...api(), '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.count, 2);
  assert.equal(payload.routes[0].path, '/devices');
});

test('open 传 path 与 show', async () => {
  mock.state.requests.length = 0;
  const { code, stdout } = await runCli(['open', '/games', '--no-show', ...api(), '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const navigate = mock.state.requests.find((item) => item.path === '/api/client/navigate');
  assert.deepEqual(navigate.body, { path: '/games', show: false });
  assert.equal(parseJson(stdout).show, false);
});

test('screenshot 默认文件名落盘并输出宽高', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-cli-shot-'));
  const { code, stdout } = await runCli(['screenshot', ...api(), '--json'], { env: cleanEnv(), cwd: dir });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.width, 1);
  assert.equal(payload.height, 1);
  assert.match(path.basename(payload.file), /^undersilicon-\d{8}-\d{6}\.png$/);
  assert.ok(fs.existsSync(payload.file));
  assert.ok(fs.statSync(payload.file).size > 0);
  assert.equal(path.dirname(payload.file), dir);
});

test('screenshot --jpeg --max-width 指定文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-cli-shot-'));
  mock.state.requests.length = 0;
  const target = path.join(dir, 'shot.jpg');
  const { code, stdout } = await runCli(['screenshot', target, '--jpeg', '--max-width', '640', ...api(), '--json'], { env: cleanEnv() });
  assert.equal(code, 0);
  const payload = parseJson(stdout);
  assert.equal(payload.file, target);
  assert.equal(payload.mime, 'image/jpeg');
  assert.ok(fs.existsSync(target));
  const call = mock.state.requests.find((item) => item.path === '/api/client/screenshot');
  assert.deepEqual(call.body, { format: 'jpeg', maxWidth: 640 });
});

test('agent 接口 404 时提示更新客户端', async () => {
  const legacy = createMockServer({ unsupportedAgent: true });
  const legacyUrl = await legacy.start();
  try {
    const { code, stdout } = await runCli(['routes', '--api', legacyUrl, '--json'], { env: cleanEnv() });
    assert.equal(code, 1);
    const payload = parseJson(stdout);
    assert.equal(payload.error.status, 404);
    assert.match(payload.error.message, /请把硅基之下控制中心更新到最新版本/);
  } finally {
    await legacy.close();
  }
});
