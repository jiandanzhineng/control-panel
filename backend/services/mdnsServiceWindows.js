/**
 * mDNS服务模块
 * 处理mDNS服务发布和管理
 */

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const logService = require('./logService');

class MDNSService {
  constructor() {
    this.mdnsProcess = null;
    this.mainWindow = null;
  }

  setMainWindow(window) {
    this.mainWindow = window;
  }

  // 获取本地IP地址
  getLocalIPAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const networkInterface of interfaces[name]) {
        // 跳过内部地址和IPv6地址
        if (networkInterface.family === 'IPv4' && !networkInterface.internal) {
          logService.info('Mdns', `Found local IP address: ${networkInterface.address} on interface ${name}`);
          return networkInterface.address;
        }
      }
    }
    logService.error('Mdns', 'No local IP address found');
    return null;
  }



  // 运行mDNS工具
  runMDNSTool(port) {
    return new Promise((resolve, reject) => {
      // 如果已有进程在运行，先停止它
      if (this.mdnsProcess && !this.mdnsProcess.killed) {
        logService.info('Mdns', `Stopping existing mDNS process (PID: ${this.mdnsProcess.pid}) before starting new one`);
        this.mdnsProcess.kill();
        this.mdnsProcess = null;
      }

      // 获取正确的工具路径
      let mdnsToolPath;
      if (process.env.NODE_ENV === 'development') {
        mdnsToolPath = path.join(__dirname, '..', 'inner-tools', 'mdns_tool.exe');
      } else {
        // 生产环境下，工具在 extraResources 中
        mdnsToolPath = path.join(process.resourcesPath, 'inner-tools', 'mdns_tool.exe');
      }
      
      logService.info('Mdns', `Starting mDNS tool at ${mdnsToolPath} with port ${port}`);
      
      this.mdnsProcess = spawn(mdnsToolPath, [port.toString()], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      
      let output = '';
      let errorOutput = '';
      let hasResolved = false;
      
      // 统一的数据处理函数
      const handleProcessData = (data, source = '') => {
        const dataStr = data.toString();
        output += dataStr;
        logService.info('Mdns', `mDNS Tool output${source}: ${dataStr.trim()} (PID: ${this.mdnsProcess.pid})`);
        
        // 实时发送输出到渲染进程
        if (this.mainWindow) {
          this.mainWindow.webContents.send('mdns-output', dataStr.trim());
        }
        
        // 如果还没有resolve，并且有输出，说明程序启动成功
        if (!hasResolved) {
          hasResolved = true;
          logService.info('Mdns', `mDNS Tool started successfully on port ${port} (PID: ${this.mdnsProcess.pid})`);
          resolve({ success: true, output: dataStr.trim(), processId: this.mdnsProcess.pid });
        }
      };
      
      this.mdnsProcess.stdout.on('data', (data) => {
        handleProcessData(data);
      });
      
      this.mdnsProcess.stderr.on('data', (data) => {
        handleProcessData(data, ' (from stderr)');
      });
      
      this.mdnsProcess.on('close', (code) => {
        logService.info('Mdns', `mDNS Tool process closed with code ${code} (port: ${port})`);
        this.mdnsProcess = null;
        
        // 通知渲染进程服务状态变化
        if (this.mainWindow) {
          this.mainWindow.webContents.send('mdns-status-change', 'stopped');
        }
        
        if (!hasResolved) {
          hasResolved = true;
          if (code === 0) {
            logService.info('Mdns', `mDNS Tool exited successfully on port ${port}`);
            resolve({ success: true, output: output.trim() });
          } else {
            logService.error('Mdns', `mDNS Tool exited with error code ${code} on port ${port}: ${errorOutput.trim()}`);
            resolve({ success: false, error: `Tool exited with code ${code}: ${errorOutput.trim()}` });
          }
        }
      });
      
      this.mdnsProcess.on('error', (error) => {
        logService.error('Mdns', `mDNS Tool process error on port ${port}: ${error.message}`);
        this.mdnsProcess = null;
        
        if (!hasResolved) {
          hasResolved = true;
          resolve({ success: false, error: `Failed to start tool: ${error.message}` });
        }
      });
      
      // 设置超时，如果3秒内没有输出，认为启动失败
      setTimeout(() => {
        if (!hasResolved) {
          hasResolved = true;
          logService.warn('Mdns', `mDNS tool startup timeout on port ${port} (no output within 3 seconds)`);
          if (this.mdnsProcess && !this.mdnsProcess.killed) {
            this.mdnsProcess.kill();
            this.mdnsProcess = null;
          }
          resolve({ success: false, error: 'mDNS tool startup timeout (no output within 3 seconds)' });
        }
      }, 3000);
    });
  }

  // 停止mDNS工具
  stopMDNSTool() {
    if (this.mdnsProcess && !this.mdnsProcess.killed) {
      const pid = this.mdnsProcess.pid;
      this.mdnsProcess.kill();
      this.mdnsProcess = null;
      logService.info('Mdns', `mDNS Tool process stopped (PID: ${pid})`);
      return true;
    }
    logService.warn('Mdns', 'Attempted to stop mDNS Tool but no process was running');
    return false;
  }

  // 检查mDNS工具状态
  getMDNSToolStatus() {
    const status = {
      running: this.mdnsProcess && !this.mdnsProcess.killed,
      processId: this.mdnsProcess ? this.mdnsProcess.pid : null
    };
    logService.debug('Mdns', `mDNS Tool status check: running=${status.running}, PID=${status.processId}`);
    return status;
  }

  // 停止mDNS服务
  stopService() {
    logService.info('Mdns', 'Stopping mDNS service');
    // 停止mDNS工具进程
    this.stopMDNSTool();
  }
}

module.exports = new MDNSService();