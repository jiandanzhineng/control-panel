const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const logger = require('./logService');

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
    
    logger.debug('Mdns', `Windows mDNS publish - IP: ${ip}, Port: ${port}, Tool: ${mdnsToolPath}`);
    logger.info('Mdns', `Starting Windows mDNS tool - Command: ${mdnsToolPath}, Args: [${port}]`);
    child = spawn(mdnsToolPath, [port], spawnOpts);
  } else {
    const scriptPath = path.resolve(__dirname, '..', '..', 'mdns', 'mdns_register_ip.py');
    const args = [scriptPath, '--ip', ip];
    const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'] };
    const venvPython = path.resolve(__dirname, '..', '..', 'mdns', '.venv', 'bin', 'python');
    
    logger.debug('Mdns', `Linux mDNS publish - IP: ${ip}, Script: ${scriptPath}`);
    logger.info('Mdns', `Starting venv python for mDNS - Command: ${venvPython}, Args: [${args.join(', ')}]`);
    child = spawn(venvPython, args, spawnOpts);
  }
  
  currentInstance = { ip, child };

  logger.info('Mdns', `mDNS publisher started - Platform: ${isWindows ? 'Windows' : 'Linux'}, IP: ${ip}`);

  child.on('exit', (code, signal) => {
    if (currentInstance) currentInstance.child = null;
    logger.info('Mdns', `mDNS child process exited - Code: ${code}, Signal: ${signal}, IP: ${currentInstance?.ip || 'unknown'}`);
  });
  child.on('error', (err) => {
    currentInstance = null;
    logger.error('Mdns', `mDNS child process error - ${err?.message || err}`);
  });

  logger.info('Mdns', `mDNS child process started - PID: ${child.pid}, IP: ${ip}, Platform: ${isWindows ? 'Windows' : 'Linux'}`);
  return { pid: child.pid, running: true, ip };
}

function unpublish() {
  if (!currentInstance) return { running: false };
  if (currentInstance.child) {
    try { 
      currentInstance.child.kill('SIGTERM'); 
      logger.info('Mdns', `mDNS child process kill signal sent - PID: ${currentInstance.child.pid}, IP: ${currentInstance.ip}`); 
    } catch (e) { 
      logger.warn('Mdns', `mDNS child process kill failed - Error: ${e?.message || e}, IP: ${currentInstance.ip}`); 
    }
  }
  const previousIp = currentInstance.ip;
  currentInstance = null;
  logger.info('Mdns', `mDNS service unpublished - Previous IP: ${previousIp}`);
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