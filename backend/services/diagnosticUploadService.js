const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const logService = require('./logService');
const localSessionService = require('./localSessionService');
const localAppService = require('./localAppService');
const accountService = require('./accountService');

const MAX_LOGS = 500;
const MAX_BYTES = 384 * 1024;
const MSG_MAX = 4096;
const UPLOAD_TIMEOUT_MS = 25000;

function dataDir() {
  if (process.env.BACKEND_DATA_DIR) return path.resolve(process.env.BACKEND_DATA_DIR);
  return path.resolve(__dirname, '..', 'data');
}

function redact(text) {
  return String(text).replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
}

function mapLevel(raw) {
  const value = String(raw || '').toLowerCase();
  if (value === 'warn' || value === 'warning') return 'warning';
  if (value === 'error') return 'error';
  if (value === 'debug') return 'debug';
  return 'info';
}

function parseLogLine(line) {
  const match = String(line).match(/^\[([^\]]+)\] \[([^\]]+)\] \[([^\]]+)\] (.*)$/);
  if (!match) return null;
  const time = new Date(match[1]);
  if (Number.isNaN(time.getTime())) return null;
  return {
    time: time.toISOString(),
    level: mapLevel(match[2]),
    category: String(match[3]).slice(0, 64),
    event: 'log_line',
    message: redact(match[4] || '').slice(0, MSG_MAX),
  };
}

function getAnonymousId() {
  const dest = path.join(dataDir(), 'diagnostic-anonymous-id.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
    if (parsed && parsed.id) return String(parsed.id).slice(0, 128);
  } catch (_) {}
  const id = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify({ id }, null, 2)}\n`);
  return id;
}

function fitLogs(entries) {
  const sliced = entries.slice(-MAX_LOGS);
  while (sliced.length > 1 && Buffer.byteLength(JSON.stringify(sliced)) > MAX_BYTES) {
    sliced.shift();
  }
  return sliced;
}

function collectPanelLogs() {
  const files = logService.getLogFiles().slice(0, 2).reverse();
  const entries = [];
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(logService.getLogFilePath(file.filename), 'utf8'); } catch (_) {}
    for (const line of text.split(/\r?\n/)) {
      const entry = parseLogLine(line);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function collectLaunchLog() {
  try {
    const filePath = path.join(localAppService.currentDir('digital-human'), 'tmp_launch.log');
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-80).map((line) => ({
      time: new Date().toISOString(),
      level: 'info',
      category: 'DigitalHuman',
      event: 'launch_output',
      message: redact(line).slice(0, MSG_MAX),
    }));
  } catch (_) {
    return [];
  }
}

function appVersion() {
  try { return require('../../package.json').version; } catch (_) { return 'unknown'; }
}

function digitalHumanContext() {
  try {
    const { meta, launch } = localAppService.getCurrentLaunch('digital-human');
    return { version: meta.version || null, exe: launch && launch.exe };
  } catch (_) {
    return { installed: false };
  }
}

function buildBundle(panelLogs, launchLogs) {
  let logs = fitLogs([...(panelLogs || []), ...(launchLogs || [])]);
  if (logs.length === 0) {
    logs = [{
      time: new Date().toISOString(),
      level: 'info',
      category: 'telemetry',
      event: 'empty_log_bundle',
    }];
  }
  return {
    anonymousId: getAnonymousId(),
    reason: 'user_report',
    logs,
    metrics: { uploadedLogs: logs.length },
    context: {
      app: 'control-panel',
      version: appVersion(),
      platform: process.platform,
      hostname: os.hostname(),
      digitalHuman: digitalHumanContext(),
    },
    clientTime: new Date().toISOString(),
  };
}

async function postBundle(body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const resp = await fetch(`${accountService.getBaseUrl()}/telemetry/log-bundles`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const err = new Error((data && data.error && data.error.message) || `上传失败 ${resp.status}`);
      err.status = resp.status;
      err.code = (data && data.error && data.error.code) || 'UPLOAD_FAILED';
      throw err;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeout = new Error('上传超时');
      timeout.status = 504;
      timeout.code = 'UPLOAD_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function uploadDiagnostics() {
  const body = buildBundle(collectPanelLogs(), collectLaunchLog());
  const session = localSessionService.get();
  const result = await postBundle(body, session && session.token);
  return { id: result.id, anonymousId: body.anonymousId };
}

module.exports = {
  parseLogLine, redact, mapLevel, fitLogs, getAnonymousId, buildBundle,
  collectPanelLogs, collectLaunchLog, uploadDiagnostics, postBundle,
  MAX_LOGS, MAX_BYTES,
};
