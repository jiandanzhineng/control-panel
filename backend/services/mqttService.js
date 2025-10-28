const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// 内部状态，用于管理单例 mosquitto 进程
let state = { child: null, meta: null, tmpConfPath: null };

function start({ port = 1883, bind = '0.0.0.0', configPath } = {}) {
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
    logger.info('Generated temporary config file', { tmpConf, confContent });
    confPath = tmpConf;
    state.tmpConfPath = tmpConf;
  } else {
    state.tmpConfPath = null;
  }

  const child = spawn('mosquitto', ['-c', confPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  state.child = child;
  state.meta = { port, bind };

  logger.info('Starting mosquitto', { confPath, port, bind });
  logger.attachChild('mosquitto', child);

  child.on('exit', () => {
    state.child = null;
    if (state.tmpConfPath) {
      try { fs.unlinkSync(state.tmpConfPath); } catch (_) {}
      state.tmpConfPath = null;
    }
    logger.info('mosquitto exited');
  });

  child.on('error', (err) => {
    if (state.tmpConfPath) {
      try { fs.unlinkSync(state.tmpConfPath); } catch (_) {}
      state.tmpConfPath = null;
    }
    state.child = null;
    logger.error('mosquitto error', err?.message || err);
  });

  return { running: true, pid: child.pid, port };
}

function status() {
  const running = !!(state.child && !state.child.killed);
  const payload = { running };
  if (running) {
    payload.pid = state.child.pid;
    payload.port = state.meta?.port;
  }
  return payload;
}

function stop() {
  if (state.child) {
    try { state.child.kill('SIGTERM'); } catch (_) {}
  }
  state.child = null;
  if (state.tmpConfPath) {
    try { fs.unlinkSync(state.tmpConfPath); } catch (_) {}
    state.tmpConfPath = null;
  }
  return { running: false };
}

module.exports = { start, status, stop };