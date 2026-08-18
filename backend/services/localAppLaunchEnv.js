const fs = require('fs');
const path = require('path');
const localSessionService = require('./localSessionService');

const LINE_MAX = 500;
const TAIL_MAX = 8;

function backendUrl() {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL.replace(/\/+$/, '');
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

function envPathKey(env) {
  if (process.platform !== 'win32') return 'PATH';
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
}

function stripPythonVars(env) {
  const drop = new Set(['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP']);
  for (const key of Object.keys(env)) {
    if (drop.has(key.toUpperCase())) delete env[key];
  }
}

function launchEnv(launch, cwd) {
  const extra = launch.env && typeof launch.env === 'object' ? launch.env : {};
  const env = {
    ...process.env,
    ...extra,
    DIGITAL_HUMAN_NO_BROWSER: '1',
    DIGITAL_HUMAN_PLAY_URL: backendUrl(),
    MIMO_RELAY_URL: localSessionService.getRelayUrl(),
  };
  stripPythonVars(env);
  const binDir = path.resolve(cwd, 'bin');
  const key = envPathKey(env);
  env[key] = `${binDir}${path.delimiter}${env[key] || ''}`;
  return env;
}

function clipLine(line) {
  if (line.length <= LINE_MAX) return line;
  return `${line.slice(0, LINE_MAX)}…`;
}

function pushTail(tail, line) {
  tail.push(line);
  if (tail.length > TAIL_MAX) tail.splice(0, tail.length - TAIL_MAX);
}

function attachOutput(child, cwd, tail) {
  const logPath = path.join(cwd, 'tmp_launch.log');
  try { fs.writeFileSync(logPath, ''); } catch (_) {}
  let logService = null;
  try { logService = require('./logService'); } catch (_) {}
  function handle(chunk, level) {
    const text = String(chunk);
    try { fs.appendFileSync(logPath, text); } catch (_) {}
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (!line) continue;
      const clipped = clipLine(line);
      pushTail(tail, clipped);
      if (logService) {
        try { logService.log(level, 'DigitalHuman', clipped); } catch (_) {}
      }
    }
  }
  if (child.stdout) child.stdout.on('data', (buf) => handle(buf, 'INFO'));
  if (child.stderr) child.stderr.on('data', (buf) => handle(buf, 'WARN'));
}

function exitHint(exitCode, tail) {
  const extra = tail.length ? `：${tail.slice(-4).join(' | ')}` : '';
  return `进程提前退出 (${exitCode})${extra}`;
}

module.exports = {
  launchEnv,
  envPathKey,
  stripPythonVars,
  attachOutput,
  exitHint,
  LINE_MAX,
  TAIL_MAX,
};
