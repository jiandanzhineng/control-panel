'use strict';

const { spawn } = require('child_process');
const path = require('path');

const CLI = path.join(__dirname, '..', '..', 'cli.js');

/** 以子进程方式运行 CLI，返回退出码与输出。 */
function runCli(args, { env = {}, cwd = process.cwd(), input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env, NO_COLOR: '1' }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const BASE_ENV_KEYS = ['UNDERSILICON_API', 'DEVICE_CLI_BASE_URL', 'API_BASE_URL', 'UNDERSILICON_LIMIT', 'UNDERSILICON_CAP_LIMIT', 'UNDERSILICON_CLIENT_ID', 'UNDERSILICON_LEASE_TTL'];

/** 清掉可能影响测试的 CLI 环境变量。 */
function cleanEnv(overrides = {}) {
  const env = {};
  for (const key of BASE_ENV_KEYS) env[key] = '';
  return { ...env, ...overrides };
}

module.exports = { runCli, parseJson, cleanEnv, CLI };
