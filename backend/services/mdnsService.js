const { spawn } = require('child_process');
const path = require('path');
const logger = require('../utils/logger');

const table = new Map();
function makeId() {
  return `mdns_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function publish({ ip }) {
  if (!ip) throw new Error('Missing ip');
  const scriptPath = path.resolve(__dirname, '..', '..', 'mdns', 'mdns_register_ip.py');
  const args = [scriptPath, '--ip', ip];
  const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'] };
  logger.debug('mdns publish input', { ip });
  const venvPython = path.resolve(__dirname, '..', '..', 'mdns', '.venv', 'bin', 'python');
  logger.info('Spawning venv python for mDNS', { cmd: venvPython, args, spawnOpts });
  const child = spawn(venvPython, args, spawnOpts);
  
  const id = makeId();
  table.set(id, { id, ip, child });

  logger.info('Starting mDNS publisher', { scriptPath, ip, id });
  logger.attachChild(`mdns:${id}`, child);

  child.on('exit', (code, signal) => {
    const entry = table.get(id);
    if (entry) entry.child = null;
    logger.info(`mdns child exited: ${id}`, { code, signal });
  });
  child.on('error', (err) => {
    table.delete(id);
    logger.error(`mdns child error: ${id}`, err?.message || err);
  });

  logger.info('mdns child started', { id, pid: child.pid, ip });
  return { id, pid: child.pid, running: true, ip };
}

function unpublish(id) {
  const entry = table.get(id);
  if (!entry) return { id, running: false };
  if (entry.child) {
    try { entry.child.kill('SIGTERM'); logger.info('mdns child kill sent', { id }); } catch (e) { logger.warn('mdns child kill failed', { id, err: e?.message || e }); }
  }
  table.delete(id);
  logger.info('mdns unpublish', { id });
  return { id, running: false };
}

function status() {
  const rows = [];
  for (const [id, entry] of table.entries()) {
    const row = { id, ip: entry.ip, pid: entry.child?.pid, running: !!(entry.child && !entry.child.killed) };
    rows.push(row);
  }
  logger.debug('mdns status rows', rows);
  return rows;
}

module.exports = { publish, unpublish, status };