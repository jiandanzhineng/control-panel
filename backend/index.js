const express = require('express');
const cors = require('cors');
const logger = require('./utils/logger');
// 引入设备服务（原 deviceStore 重构后）
const deviceService = require('./services/deviceService');
// 引入 MQTT 服务
const mqttService = require('./services/mqttService');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS：允许所有来源（用于桌面壳/不同源访问）
app.use(cors());
app.use(express.json());

// 请求日志（简易版）：方法、路径、耗时
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// 先初始化 MQTT 客户端单例（自动连接）
try {
  const mqttClient = require('./services/mqttClientService');
  mqttClient.init();
  // 注册设备消息处理器
  mqttClient.onMessage(deviceService.handleDeviceMessage);
} catch (e) {
  logger.warn('MQTT client init failed', e?.message || e);
}

// 初始化设备列表（加载持久化数据并启动离线检查循环）
deviceService.initDeviceList();

// 自动启动 MQTT 服务（mosquitto broker）
try {
  const result = mqttService.start();
  if (result.running) {
    logger.info('MQTT service started successfully', { 
      pid: result.pid, 
      port: result.port || 1883 
    });
  }
} catch (error) {
  logger.warn('Failed to start MQTT service, continuing without it', { 
    error: error.message 
  });
}

// 路由：将实现与接口分离
app.use('/api/mqtt', require('./routes/mqtt'));
app.use('/api/network', require('./routes/network'));
app.use('/api/mdns', require('./routes/mdns'));
app.use('/api/mqtt-client', require('./routes/mqttClient'));
// 设备管理与设备类型
app.use('/api/devices', require('./routes/devices'));
app.use('/api/device-types', require('./routes/deviceTypes'));
// 游戏列表管理
app.use('/api/games', require('./routes/games'));
// 玩法运行期接口（嵌入式HTML + SSE）
app.use('/api/games', require('./routes/gameplay'));

// 健康检查与示例接口
app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from Express backend!' });
});
app.get('/api', (req, res) => { res.send('Backend is running'); });

// 全局错误兜底日志（保持响应由各路由处理）
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err?.message || err);
  next(err);
});

// 测试时仅导出 app，不启动监听；直接运行该文件时才监听
if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`Backend server running at http://localhost:${PORT}`);
  });
}

// 进程退出清理设备服务定时器
// 进程退出时的清理工作
process.on('SIGINT', () => {
  logger.info('Received SIGINT, cleaning up...');
  
  // 清理设备服务
  deviceService.cleanup();
  
  // 停止 MQTT 服务
  try {
    mqttService.stop();
    logger.info('MQTT service stopped');
  } catch (error) {
    logger.warn('Error stopping MQTT service', { error: error.message });
  }
  
  process.exit(0);
});

module.exports = app;