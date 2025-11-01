/**
 * mDNS服务模块
 * 处理mDNS服务发布和管理
 */

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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
          console.log(`Found local IP address: ${networkInterface.address}`);
          return networkInterface.address;
        }
      }
    }
    console.error('No local IP address found');
    return null;
  }



  // 运行mDNS工具
  runMDNSTool(port) {
    return new Promise((resolve, reject) => {
      // 如果已有进程在运行，先停止它
      if (this.mdnsProcess && !this.mdnsProcess.killed) {
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
        console.log(`mDNS Tool output${source}:`, dataStr.trim());
        
        // 实时发送输出到渲染进程
        if (this.mainWindow) {
          this.mainWindow.webContents.send('mdns-output', dataStr.trim());
        }
        
        // 如果还没有resolve，并且有输出，说明程序启动成功
        if (!hasResolved) {
          hasResolved = true;
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
        console.log(`mDNS Tool process closed with code ${code}`);
        this.mdnsProcess = null;
        
        // 通知渲染进程服务状态变化
        if (this.mainWindow) {
          this.mainWindow.webContents.send('mdns-status-change', 'stopped');
        }
        
        if (!hasResolved) {
          hasResolved = true;
          if (code === 0) {
            resolve({ success: true, output: output.trim() });
          } else {
            resolve({ success: false, error: `Tool exited with code ${code}: ${errorOutput.trim()}` });
          }
        }
      });
      
      this.mdnsProcess.on('error', (error) => {
        console.error('mDNS Tool process error:', error);
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
      this.mdnsProcess.kill();
      this.mdnsProcess = null;
      console.log('mDNS Tool process stopped');
      return true;
    }
    return false;
  }

  // 检查mDNS工具状态
  getMDNSToolStatus() {
    return {
      running: this.mdnsProcess && !this.mdnsProcess.killed,
      processId: this.mdnsProcess ? this.mdnsProcess.pid : null
    };
  }

  // 停止mDNS服务
  stopService() {
    // 停止mDNS工具进程
    this.stopMDNSTool();
  }
}

module.exports = new MDNSService();