const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const logService = require('./logService');

// 根据操作系统选择MQTT broker
const isWindows = process.platform === 'win32';
let emqxService = null;
if (isWindows) {
  try {
    emqxService = require('./emqxService');
  } catch (error) {
    logService.error('Mqtt', `Failed to load EMQX service on Windows: ${error.message}`);
  }
}

// 内部状态，用于管理单例 mosquitto 进程
let state = { child: null, meta: null, tmpConfPath: null };

async function start({ port = 1883, bind = '0.0.0.0', configPath } = {}) {
  // Windows系统使用EMQX
  if (isWindows && emqxService) {
    try {
      logService.info('Mqtt', `Starting EMQX broker on Windows - Port: ${port}, Bind: ${bind}`);
      const result = await emqxService.startBroker();
      if (result.success) {
        state.meta = { port: 1883, bind: '0.0.0.0', broker: 'emqx' }; // EMQX默认端口
        return { running: true, broker: 'emqx', port: 1883, status: result.status };
      } else {
        logService.error('Mqtt', `Failed to start EMQX broker: ${result.error}`);
        throw new Error(result.error);
      }
    } catch (error) {
      logService.error('Mqtt', `EMQX startup error, falling back to mosquitto: ${error.message}`);
      // 如果EMQX启动失败，继续使用mosquitto逻辑
    }
  }

  // Linux/macOS系统或EMQX启动失败时使用mosquitto
  if (state.child && !state.child.killed) {
    return { running: true, pid: state.child.pid, port: state.meta?.port };
  }

  // 配置文件：优先使用传入路径，否则使用项目内默认配置
  let confPath = configPath
    ? path.resolve(configPath)
    : path.resolve(__dirname, '..', 'config', 'mosquitto.conf');

  // 如果提供了 port/bind 且未指定外部配置，则生成临时配置文件
  const useTemp = (!configPath) && (port !== undefined || bind !== undefined);
  if (useTemp) {
    const tmpConf = path.join(os.tmpdir(), `mosquitto_${Date.now()}.conf`);
    const confContent = `listener ${port} ${bind}\nallow_anonymous true\n`;
    fs.writeFileSync(tmpConf, confContent, 'utf8');
    logService.info('Mqtt', `Generated temporary config file - Path: ${tmpConf}, Content: ${confContent.trim()}`);
    confPath = tmpConf;
    state.tmpConfPath = tmpConf;
  } else {
    state.tmpConfPath = null;
  }

  const child = spawn('mosquitto', ['-c', confPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  state.child = child;
  state.meta = { port, bind, broker: 'mosquitto' };

  logService.info('Mqtt', `Starting mosquitto - Config: ${confPath}, Port: ${port}, Bind: ${bind}`);

  child.on('exit', (code, signal) => {
    state.child = null;
    if (state.tmpConfPath) {
      try { fs.unlinkSync(state.tmpConfPath); } catch (_) {}
      state.tmpConfPath = null;
    }
    logService.info('Mqtt', `mosquitto exited - Code: ${code}, Signal: ${signal || 'none'}`);
  });

  child.on('error', (err) => {
    if (state.tmpConfPath) {
      try { fs.unlinkSync(state.tmpConfPath); } catch (_) {}
      state.tmpConfPath = null;
    }
    state.child = null;
    logService.error('Mqtt', `mosquitto error: ${err?.message || err}`);
  });

  return { running: true, pid: child.pid, port, broker: 'mosquitto' };
}

async function status() {
  // 如果使用EMQX
  if (state.meta?.broker === 'emqx' && isWindows && emqxService) {
    try {
      const emqxStatus = await emqxService.checkStatus();
      return {
        running: emqxStatus.running,
        broker: 'emqx',
        port: 1883,
        status: emqxStatus.status,
        output: emqxStatus.output
      };
    } catch (error) {
      logService.error('Mqtt', `Failed to check EMQX status: ${error.message}`);
      return { running: false, broker: 'emqx', error: error.message };
    }
  }

  // mosquitto状态检查
  const running = !!(state.child && !state.child.killed);
  const payload = { running, broker: 'mosquitto' };
  if (running) {
    payload.pid = state.child.pid;
    payload.port = state.meta?.port;
  }
  return payload;
}

async function stop() {
  // 如果使用EMQX
  if (state.meta?.broker === 'emqx' && isWindows && emqxService) {
    try {
      logService.info('Mqtt', 'Stopping EMQX broker');
      const result = await emqxService.stopBroker();
      state.meta = null;
      return { running: false, broker: 'emqx', success: result.success };
    } catch (error) {
      logService.error('Mqtt', `Failed to stop EMQX broker: ${error.message}`);
      return { running: false, broker: 'emqx', error: error.message };
    }
  }

  // mosquitto停止
  if (state.child) {
    try { state.child.kill('SIGTERM'); } catch (_) {}
  }
  state.child = null;
  if (state.tmpConfPath) {
    try { fs.unlinkSync(state.tmpConfPath); } catch (_) {}
    state.tmpConfPath = null;
  }
  state.meta = null;
  return { running: false, broker: 'mosquitto' };
}

module.exports = { start, status, stop };