const levels = ['debug', 'info', 'warn', 'error'];
const currentLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const currentIdx = levels.indexOf(currentLevel) === -1 ? levels.indexOf('info') : levels.indexOf(currentLevel);

let logService = null;
try {
  logService = require('../services/logService');
} catch (e) {
  // logService not available yet
}

function emit(level, ...args) {
  const idx = levels.indexOf(level);
  if (idx < currentIdx) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  const out = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
  out(prefix, ...args);
  
  // 同时记录到日志服务
  if (logService) {
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    logService.log(level.toUpperCase(), 'System', message);
  }
}

function attachChild(name, child) {
  try {
    if (child && child.stdout && child.stdout.on) {
      child.stdout.on('data', (d) => emit('info', `[child:${name}:stdout]`, d.toString().trim()));
    }
    if (child && child.stderr && child.stderr.on) {
      child.stderr.on('data', (d) => emit('warn', `[child:${name}:stderr]`, d.toString().trim()));
    }
    if (child && child.on) {
      child.on('error', (err) => emit('error', `[child:${name}:error]`, err?.message || err));
      child.on('exit', (code, signal) => emit('info', `[child:${name}:exit] code=${code} signal=${signal || ''}`));
    }
  } catch (_) {
    // swallow attach errors to avoid impacting main flow
  }
}

module.exports = {
  debug: (...args) => emit('debug', ...args),
  info: (...args) => emit('info', ...args),
  warn: (...args) => emit('warn', ...args),
  error: (...args) => emit('error', ...args),
  attachChild,
};