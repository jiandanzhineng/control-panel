const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const logger = require('./logService');

let currentInstance = null;

function publish() {
  
  if (currentInstance) {
    unpublish();
  }
  
  let child;
  const isWindows = os.platform() === 'win32';
  
  if (isWindows) {
    const mdnsToolPath = path.resolve(__dirname, '..', 'inner-tools', 'mdns_tool.exe');
    const port = '8080';
    const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
    logger.debug('Mdns', `Windows mDNS publish - Port: ${port}, Tool: ${mdnsToolPath}`);
    logger.info('Mdns', `Starting Windows mDNS tool - Command: ${mdnsToolPath}, Args: [${port}]`);
    child = spawn(mdnsToolPath, [port], spawnOpts);
  } else {
    // 等待后续实现（Linux 下 mDNS 发布）
    child = null;
    logger.info('Mdns', 'Linux mDNS publish requested - not implemented');
  }
  
  currentInstance = { child };

  logger.info('Mdns', `mDNS publisher start requested - Platform: ${isWindows ? 'Windows' : 'Linux'}`);

  if (child) {
    child.on('exit', (code, signal) => {
      if (currentInstance) currentInstance.child = null;
      logger.info('Mdns', `mDNS child process exited - Code: ${code}, Signal: ${signal}`);
    });
    child.on('error', (err) => {
      currentInstance = null;
      logger.error('Mdns', `mDNS child process error - ${err?.message || err}`);
    });
  }

  logger.info('Mdns', `mDNS child process handle - PID: ${child?.pid || 'N/A'}, Platform: ${isWindows ? 'Windows' : 'Linux'}`);
  return { pid: child?.pid, running: !!(child && !child.killed) };
}

function unpublish() {
  if (!currentInstance) return { running: false };
  if (currentInstance.child) {
    try { 
      currentInstance.child.kill('SIGTERM'); 
      logger.info('Mdns', `mDNS child process kill signal sent - PID: ${currentInstance.child.pid}`); 
    } catch (e) { 
      logger.warn('Mdns', `mDNS child process kill failed - Error: ${e?.message || e}`); 
    }
  }
  currentInstance = null;
  logger.info('Mdns', 'mDNS service unpublished');
  return { running: false };
}

function status() {
  if (!currentInstance) return { running: false };
  return { 
    pid: currentInstance.child?.pid, 
    running: !!(currentInstance.child && !currentInstance.child.killed) 
  };
}

module.exports = { publish, unpublish, status };