const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const logger = require('./utils/logger');
const deviceService = require('./services/deviceService');
const deviceWatchdogService = require('./services/deviceWatchdogService');
const mqttService = require('./services/mqttService');
const mdnsService = require('./services/mdnsService');
const logService = require('./services/logService');
const bridgeService = require('./services/bridgeService');
const gameService = require('./services/gameService');
const gameCacheService = require('./services/gameCacheService');
const localAppProcessService = require('./services/localAppProcessService');
const { BRIDGE_INTERNAL_HEADER } = require('./constants/bridgeAccess');
const { browserApiCors } = require('./middleware/browserApiAccess');
const externalGameAccessService = require('./services/externalGameAccessService');
const serialConnectionService = require('./services/serialConnectionService');
const remoteProjectionService = require('./services/remoteProjectionService');

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
app.use('/v1', require('./routes/voiceCompletions'));
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

let runtimeServicesStartPromise = null;
let runtimeServicesStopPromise = null;
let backendShutdownPromise = null;

function startRuntimeServices() {
  if (runtimeServicesStartPromise) return runtimeServicesStartPromise;

  runtimeServicesStartPromise = Promise.all([
    mqttService.start()
      .then((result) => {
        if (result.running) {
          logger.info('MQTT service started successfully', {
            broker: result.broker, pid: result.pid, port: result.port || 1883,
          });
        }
        return result;
      })
      .catch((error) => {
        logger.warn('Failed to start MQTT service, continuing without it', { error: error.message });
        return { running: false, error: error.message };
      }),
    mdnsService.publish()
      .then((result) => {
        if (result.running) {
          logger.info('mDNS service started', { pid: result.pid, ip: result.ip });
        }
        return result;
      })
      .catch((error) => {
        logger.warn('mDNS service start failed', error?.message || error);
        return { running: false, error: error?.message || String(error) };
      }),
    serialConnectionService.start()
      .catch((error) => {
        logger.warn('Serial connection service start failed', error?.message || error);
        return { autoConnect: false, error: error?.message || String(error) };
      }),
  ]).then(([mqtt, mdns, serial]) => ({ mqtt, mdns, serial }));

  return runtimeServicesStartPromise;
}

function stopRuntimeServices() {
  if (runtimeServicesStopPromise) return runtimeServicesStopPromise;

  runtimeServicesStopPromise = (async () => {
    if (runtimeServicesStartPromise) await runtimeServicesStartPromise;
    const serial = await serialConnectionService.shutdown()
      .then(() => ({ running: false }))
      .catch((error) => ({ running: false, error: error?.message || String(error) }));
    const [mqtt, mdns] = await Promise.all([
      mqttService.stop({ onlyOwned: true }).catch(() => ({ running: false })),
      mdnsService.unpublish().catch(() => ({ running: false })),
    ]);
    runtimeServicesStartPromise = null;
    return { mqtt, mdns, serial };
  })().finally(() => {
    runtimeServicesStopPromise = null;
  });

  return runtimeServicesStopPromise;
}

function closeHttpServer() {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function shutdownBackend(reason = 'backend-shutdown', {
  closeServer = true,
  beforeTransportShutdown = null,
} = {}) {
  if (backendShutdownPromise) return backendShutdownPromise;

  backendShutdownPromise = (async () => {
    await deviceWatchdogService.shutdown(reason);
    await localAppProcessService.stopAll().catch(() => ({ ok: false }));
    await remoteProjectionService.shutdown();
    if (typeof beforeTransportShutdown === 'function') {
      await beforeTransportShutdown();
    }
    await stopRuntimeServices();
    deviceService.cleanup();
    if (closeServer) await closeHttpServer();
  })().finally(() => {
    backendShutdownPromise = null;
  });

  return backendShutdownPromise;
}

function requireInternalBridgeAccess(req, res, next) {
  if (req.get(BRIDGE_INTERNAL_HEADER) === '1') return next();
  // 同源 <script src> 不发送 Origin，因此开发模式需回退到浏览器控制的 Referer。
  // 显式 Origin 始终优先，避免用可信 Referer 覆盖不受信的跨源请求。
  const origin = externalGameAccessService.normalizeOrigin(req.get('Origin'));
  const sourceOrigin = origin
    || externalGameAccessService.normalizeOrigin(req.get('Referer'));
  if (sourceOrigin) {
    try {
      if (externalGameAccessService.isTrustedDevOrigin(sourceOrigin)) {
        if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', origin ? 'Origin' : 'Referer');
        return next();
      }
    } catch (_) {}
  }
  res.status(403).json({ error: 'Bridge script access denied' });
}

// Static: bridge script and game files
app.use('/bridge-api', requireInternalBridgeAccess, express.static(path.join(__dirname, 'public')));
// 第三方游戏前缀反向代理（须在静态 /games 之前，避免被 static 捕获）
app.use('/games/proxy', require('./routes/gameProxy'));
app.use('/games/cache', express.static(gameCacheService.getCacheRoot()));
app.use('/games', express.static(gameService.getGameRoot()));

// Routes
app.use('/api/mqtt', require('./routes/mqtt'));
app.use('/api/network', require('./routes/network'));
app.use('/api/mdns', require('./routes/mdns'));
app.use('/api/mqtt-client', require('./routes/mqttClient'));
app.use('/api/devices', require('./routes/devices'));
app.use('/api/serial', require('./routes/serialConnections'));
app.use('/api/wired-flash', require('./routes/wiredFlash'));
app.use('/api/device-watchdog', require('./routes/deviceWatchdog'));
app.use('/api/device-types', require('./routes/deviceTypes'));
app.use('/api/device-capabilities', require('./routes/deviceCapabilities'));
app.use('/api/games', require('./routes/games'));
app.use('/api/game-registry', require('./routes/gameRegistry'));
app.use('/api/game-cache', require('./routes/gameCache'));
app.use('/api/local-apps', require('./routes/localApps'));
app.use('/api/plugins', require('./routes/plugins'));
app.use('/api/logs', require('./routes/logs'));
app.use('/api/test', require('./routes/test'));
app.use('/api/virtual-devices', require('./routes/virtualDevices'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/voice', require('./routes/voice'));
app.use('/api/remote-projection', require('./routes/remoteProjection'));
app.use('/api/dev-access', require('./routes/devAccess'));

app.get('/api/hello', (req, res) => { res.json({ message: 'Hello from Express backend!' }); });
app.get('/api', (req, res) => { res.send('Backend is running'); });

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err?.message || err);
  next(err);
});

const server = http.createServer(app);
bridgeService.init(server);
server.on('listening', () => {
  startRuntimeServices();
});
server.on('close', () => {
  if (!backendShutdownPromise) {
    void shutdownBackend('server-close', { closeServer: false });
  }
});

if (require.main === module) {
  logService.cleanOldLogs();
  server.listen(PORT, () => {
    logger.info(`Backend server running at http://localhost:${PORT}`);
  });
}

async function handleTerminationSignal(signal) {
  logger.info(`Received ${signal}, cleaning up...`);
  try {
    await shutdownBackend(signal.toLowerCase());
    process.exit(0);
  } catch (error) {
    logger.error('Backend shutdown failed', error?.message || error);
    process.exit(1);
  }
}

if (require.main === module) {
  process.on('SIGINT', () => { void handleTerminationSignal('SIGINT'); });
  process.on('SIGTERM', () => { void handleTerminationSignal('SIGTERM'); });
}

// 默认导出仍是 express app（supertest、api.test.js 依赖此）。
// 额外挂上 server：它是 http.createServer(app) 且已 bridgeService.init(server) 挂好 /bridge WS。
// electron 场景必须 listen 这个 server（而非对 app 重新 listen），否则新建的 server 不带 WS，
// 导致 /bridge 握手 404、插件设备连不上。
module.exports = app;
module.exports.server = server;
module.exports.startRuntimeServices = startRuntimeServices;
module.exports.stopRuntimeServices = stopRuntimeServices;
module.exports.shutdownBackend = shutdownBackend;
module.exports.BRIDGE_INTERNAL_HEADER = BRIDGE_INTERNAL_HEADER;
