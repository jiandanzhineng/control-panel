const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const logger = require('./utils/logger');
const deviceService = require('./services/deviceService');
const mqttService = require('./services/mqttService');
const mdnsService = require('./services/mdnsService');
const logService = require('./services/logService');
const bridgeService = require('./services/bridgeService');
const gameCacheService = require('./services/gameCacheService');
const { BRIDGE_INTERNAL_HEADER } = require('./constants/bridgeAccess');
const { browserApiCors } = require('./middleware/browserApiAccess');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    return callback(null, false);
  },
  credentials: false,
  preflightContinue: true,
}));
app.use('/api', browserApiCors);
app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

try {
  const mqttClient = require('./services/mqttClientService');
  mqttClient.init();
  mqttClient.onMessage(deviceService.handleDeviceMessage);
} catch (e) {
  logger.warn('MQTT client init failed', e?.message || e);
}

deviceService.initDeviceList();

(async () => {
  try {
    const result = await mqttService.start();
    if (result.running) {
      logger.info('MQTT service started successfully', {
        broker: result.broker, pid: result.pid, port: result.port || 1883,
      });
    }
  } catch (error) {
    logger.warn('Failed to start MQTT service, continuing without it', { error: error.message });
  }
})();

function requireInternalBridgeAccess(req, res, next) {
  if (req.get(BRIDGE_INTERNAL_HEADER) === '1') return next();
  res.status(403).json({ error: 'Bridge script access denied' });
}

// Static: bridge script and game files
app.use('/bridge-api', requireInternalBridgeAccess, express.static(path.join(__dirname, 'public')));
// 第三方游戏前缀反向代理（须在静态 /games 之前，避免被 static 捕获）
app.use('/games/proxy', require('./routes/gameProxy'));
app.use('/games/cache', express.static(gameCacheService.getCacheRoot()));
app.use('/games', express.static(path.join(__dirname, 'games')));

// Routes
app.use('/api/mqtt', require('./routes/mqtt'));
app.use('/api/network', require('./routes/network'));
app.use('/api/mdns', require('./routes/mdns'));
app.use('/api/mqtt-client', require('./routes/mqttClient'));
app.use('/api/devices', require('./routes/devices'));
app.use('/api/device-types', require('./routes/deviceTypes'));
app.use('/api/device-capabilities', require('./routes/deviceCapabilities'));
app.use('/api/games', require('./routes/games'));
app.use('/api/game-registry', require('./routes/gameRegistry'));
app.use('/api/game-cache', require('./routes/gameCache'));
app.use('/api/plugins', require('./routes/plugins'));
app.use('/api/logs', require('./routes/logs'));
app.use('/api/test', require('./routes/test'));
app.use('/api/virtual-devices', require('./routes/virtualDevices'));

app.get('/api/hello', (req, res) => { res.json({ message: 'Hello from Express backend!' }); });
app.get('/api', (req, res) => { res.send('Backend is running'); });

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err?.message || err);
  next(err);
});

const server = http.createServer(app);
bridgeService.init(server);

if (require.main === module) {
  logService.cleanOldLogs();
  server.listen(PORT, () => {
    logger.info(`Backend server running at http://localhost:${PORT}`);
    if (process.platform === 'win32') {
      try {
        const res = mdnsService.publish();
        if (res.running) logger.info('mDNS service started', { pid: res.pid });
      } catch (e) {
        logger.warn('mDNS service start failed', e?.message || e);
      }
    }
  });
}

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, cleaning up...');
  deviceService.cleanup();
  try {
    await mqttService.stop();
  } catch (_) {}
  if (process.platform === 'win32') {
    try { mdnsService.unpublish(); } catch (_) {}
  }
  process.exit(0);
});

// 默认导出仍是 express app（supertest、api.test.js 依赖此）。
// 额外挂上 server：它是 http.createServer(app) 且已 bridgeService.init(server) 挂好 /bridge WS。
// electron 场景必须 listen 这个 server（而非对 app 重新 listen），否则新建的 server 不带 WS，
// 导致 /bridge 握手 404、插件设备连不上。
module.exports = app;
module.exports.server = server;
module.exports.BRIDGE_INTERNAL_HEADER = BRIDGE_INTERNAL_HEADER;
