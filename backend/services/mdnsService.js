const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');

let currentInstance = null;

function publish({ ip }) {
  if (!ip) throw new Error('Missing ip');
  
  if (currentInstance) {
    unpublish();
  }
  
  let child;
  const isWindows = os.platform() === 'win32';
  
  if (isWindows) {
    const mdnsToolPath = path.resolve(__dirname, '..', 'inner-tools', 'mdns_tool.exe');
    const port = '8080';
    const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
    
    logger.debug('mdns publish input (Windows)', { ip, port });
    logger.info('Spawning Windows mDNS tool', { cmd: mdnsToolPath, args: [port], spawnOpts });
    child = spawn(mdnsToolPath, [port], spawnOpts);
  } else {
    const scriptPath = path.resolve(__dirname, '..', '..', 'mdns', 'mdns_register_ip.py');
    const args = [scriptPath, '--ip', ip];
    const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'] };
    const venvPython = path.resolve(__dirname, '..', '..', 'mdns', '.venv', 'bin', 'python');
    
    logger.debug('mdns publish input (Linux)', { ip });
    logger.info('Spawning venv python for mDNS', { cmd: venvPython, args, spawnOpts });
    child = spawn(venvPython, args, spawnOpts);
  }
  
  currentInstance = { ip, child };

  logger.info('Starting mDNS publisher', { platform: isWindows ? 'Windows' : 'Linux', ip });
  logger.attachChild('mdns', child);

  child.on('exit', (code, signal) => {
    if (currentInstance) currentInstance.child = null;
    logger.info('mdns child exited', { code, signal });
  });
  child.on('error', (err) => {
    currentInstance = null;
    logger.error('mdns child error', err?.message || err);
  });

  logger.info('mdns child started', { pid: child.pid, ip, platform: isWindows ? 'Windows' : 'Linux' });
  return { pid: child.pid, running: true, ip };
}

function unpublish() {
  if (!currentInstance) return { running: false };
  if (currentInstance.child) {
    try { 
      currentInstance.child.kill('SIGTERM'); 
      logger.info('mdns child kill sent'); 
    } catch (e) { 
      logger.warn('mdns child kill failed', { err: e?.message || e }); 
    }
  }
  currentInstance = null;
  logger.info('mdns unpublish');
  return { running: false };
}

function status() {
  if (!currentInstance) return { running: false };
  return { 
    ip: currentInstance.ip, 
    pid: currentInstance.child?.pid, 
    running: !!(currentInstance.child && !currentInstance.child.killed) 
  };
}

module.exports = { publish, unpublish, status };