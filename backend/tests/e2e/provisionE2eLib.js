// 真机 E2E：串口自动供给流水线（探测 → 烧录 → 再探测 → 自动开测）
//
// 需要真实 ESP32 插在串口上，默认从环境变量读参数：
//   E2E_PORT       目标串口，如 COM17（必填）
//   E2E_DEVICE_TYPE 烧录型号，默认 CUNZHI01
//   BACKEND_URL    被测后端地址，默认 http://127.0.0.1:3100
//
// 用法见 docs/test/autotest-provision-e2e.md。脚本不启后端，由调用方先起好。
const BASE = process.env.BACKEND_URL || 'http://127.0.0.1:3100';
const PORT_PATH = process.env.E2E_PORT || '';
const DEVICE_TYPE = process.env.E2E_DEVICE_TYPE || 'CUNZHI01';

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function provisionState() {
  return (await api('/api/test/provision')).body;
}

function portEntry(state, path) {
  return state?.ports?.find((port) => port.path === path) || null;
}

// 轮询等待端口进入某个阶段，顺带打印阶段流转，方便看烧录进度。
async function waitForStage(path, stages, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  let last = '';
  while (Date.now() < deadline) {
    const entry = portEntry(await provisionState(), path);
    if (entry) {
      const line = `${entry.stage}${entry.flashProgress !== null ? ` ${entry.flashProgress}%` : ''} ${entry.message}`;
      if (line !== last) {
        last = line;
        seen.push(entry.stage);
        console.log(`      [${path}] ${line}`);
      }
      if (stages.includes(entry.stage)) return { entry, seen };
    }
    await sleep(500);
  }
  throw new Error(`等待 ${label} 超时（${timeoutMs}ms），最后状态: ${last || '无'}`);
}

module.exports = { BASE, PORT_PATH, DEVICE_TYPE, results, check, api, sleep, provisionState, portEntry, waitForStage };
