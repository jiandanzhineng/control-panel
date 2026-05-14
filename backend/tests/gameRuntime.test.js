const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BACKEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'game-runtime-data-'));

const mqttHandlers = [];
const publishedMessages = [];

jest.mock('../services/mqttClientService', () => ({
  init: jest.fn(),
  onMessage: jest.fn((handler) => {
    mqttHandlers.push(handler);
  }),
  publish: jest.fn((topic, message) => {
    publishedMessages.push({ topic, message });
  }),
}));

jest.mock('../services/logService', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const gameplayService = require('../services/gameplayService');
const deviceService = require('../services/deviceService');
const gameService = require('../services/gameService');
const deviceRegistry = require('../devices/registry');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/games', require('../routes/games'));
  app.use('/api/games', require('../routes/gameplay'));
  return app;
}

function initialDataForType(type) {
  const base = { device_type: type, battery: 95 };
  switch (type) {
    case 'QTZ':
      return { ...base, distance: 100, button0: 0, button1: 0, report_delay_ms: 1000, low_band: 60, high_band: 150 };
    case 'QIYA':
      return { ...base, pressure: 22, temperature: 25, report_delay_ms: 1000 };
    case 'DZC01':
      return { ...base, weight: 1000, report_delay_ms: 1000 };
    case 'DIANJI':
      return { ...base, voltage: 0, shock: 0 };
    case 'ZIDONGSUO':
      return { ...base, open: 0 };
    case 'CUNZHI01':
      return { ...base, power: 0, voltage: 0, pressure: 0, pressure1: 0, report_delay_ms: 1000 };
    default:
      return { ...base, power: 0 };
  }
}

function typeForRequirement(requirement) {
  const logicalId = String(requirement.logicalId || '').toLowerCase();
  const caps = Array.isArray(requirement.capabilities) ? requirement.capabilities : [];
  if (caps.includes('strength') && caps.includes('pressure')) return 'CUNZHI01';
  if (caps.includes('weight')) return 'DZC01';
  if (caps.includes('pressure')) return 'QIYA';
  if (caps.includes('distance') || caps.includes('buttonInput')) return 'QTZ';
  if (caps.includes('shock')) return 'DIANJI';
  if (caps.includes('lock')) return 'ZIDONGSUO';
  if (caps.includes('strength')) return logicalId.includes('pj01') ? 'PJ01' : 'TD01';
  return 'TD01';
}

function buildParameters(meta) {
  const params = {};
  for (const item of meta.parameter || []) {
    if (!item || !item.key) continue;
    if (Object.prototype.hasOwnProperty.call(item, 'default')) {
      params[item.key] = item.default;
    } else if (item.type === 'number') {
      params[item.key] = item.min ?? 0;
    } else if (item.type === 'boolean') {
      params[item.key] = false;
    } else if (item.type === 'enum') {
      params[item.key] = Array.isArray(item.enum) ? item.enum[0] : '';
    }
  }

  // Keep runtime tests short without breaking game-side minimum assumptions.
  if ('duration' in params) params.duration = 1;
  if ('durationSec' in params) params.durationSec = 10;
  if ('targetCount' in params) params.targetCount = 2;
  if ('idleTimeLimit' in params) params.idleTimeLimit = 5;
  if ('cycleTime' in params) params.cycleTime = 3;
  if ('shockDuration' in params) params.shockDuration = Math.max(1, Number(params.shockDuration) || 1);
  if ('vibratorDuration' in params) params.vibratorDuration = Math.max(5, Number(params.vibratorDuration) || 5);
  if ('pj01Duration' in params) params.pj01Duration = 1;
  return params;
}

function prepareDevices(meta) {
  const mapping = {};
  const devices = [];
  const typeCounters = {};

  for (const requirement of meta.requiredDevices || []) {
    const type = typeForRequirement(requirement);
    if (!deviceRegistry.hasCapabilities(type, requirement.capabilities || [])) {
      throw new Error(`test fixture type ${type} does not satisfy ${requirement.logicalId}`);
    }
    typeCounters[type] = (typeCounters[type] || 0) + 1;
    const id = `${type.toLowerCase()}-${typeCounters[type]}-${String(requirement.logicalId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    mapping[requirement.logicalId] = [id];
    devices.push({
      id,
      name: `${type}-${requirement.logicalId}`,
      type,
      connected: true,
      lastReport: Date.now(),
      data: initialDataForType(type),
    });
  }

  deviceService.state.devices = devices;
  return mapping;
}

async function emitVirtualMessage(deviceId, payload) {
  const text = JSON.stringify(payload);
  const message = {
    topic: `/dpub/${deviceId}`,
    text,
    payload: Buffer.from(text, 'utf8'),
  };
  await deviceService.handleDeviceMessage(message);
  for (const handler of mqttHandlers) {
    handler(message);
  }
}

async function emitRepresentativeReports(mapping) {
  for (const [logicalId, ids] of Object.entries(mapping)) {
    const deviceId = ids[0];
    const device = deviceService.getDeviceById(deviceId);
    if (!device) continue;

    switch (device.type) {
      case 'QTZ':
        await emitVirtualMessage(deviceId, { method: 'report', ...initialDataForType('QTZ') });
        await emitVirtualMessage(deviceId, { method: 'update', button0: 1, button1: 1, distance: 45 });
        await emitVirtualMessage(deviceId, { method: 'low' });
        await emitVirtualMessage(deviceId, { method: 'high' });
        break;
      case 'QIYA':
        await emitVirtualMessage(deviceId, { method: 'report', ...initialDataForType('QIYA') });
        await emitVirtualMessage(deviceId, { method: 'update', pressure: 24.5, temperature: 25.5 });
        break;
      case 'DZC01':
        await emitVirtualMessage(deviceId, { method: 'report', ...initialDataForType('DZC01') });
        await emitVirtualMessage(deviceId, { method: 'update', weight: 980 });
        break;
      case 'CUNZHI01':
        await emitVirtualMessage(deviceId, { method: 'report', ...initialDataForType('CUNZHI01') });
        await emitVirtualMessage(deviceId, { method: 'update', pressure: 120, pressure1: 180 });
        break;
      default:
        await emitVirtualMessage(deviceId, { method: 'report', ...initialDataForType(device.type) });
        break;
    }

    expect(deviceService.getDeviceById(deviceId)?.connected).toBe(true);
    expect(logicalId).toBeTruthy();
  }
}

function supportedActionForTitle(title) {
  if (title === 'Demo — Embedded HTML + SSE') return { action: 'add', payload: { delta: 2 } };
  if (title === '喝水/憋尿解锁玩法') return { action: 'stop', payload: {} };
  return { action: 'pause', payload: {} };
}

describe('built-in game runtime with virtual device protocol', () => {
  beforeAll(() => {
    gameService.reloadGames();
  });

  beforeEach(() => {
    gameplayService.endGameplay();
    deviceService.stopOfflineCheck();
    deviceService.state.devices = [];
    publishedMessages.length = 0;
  });

  afterEach(() => {
    gameplayService.endGameplay();
    deviceService.stopOfflineCheck();
    deviceService.state.devices = [];
    publishedMessages.length = 0;
  });

  afterAll(() => {
    gameplayService.endGameplay();
    deviceService.stopOfflineCheck();
    try { fs.rmSync(process.env.BACKEND_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  });

  it('keeps /api/games/status distinct from /api/games/:id', async () => {
    const res = await request(createApp()).get('/api/games/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ running: false });
  });

  it('starts every built-in game, handles virtual reports, runs an action, and stops cleanly', async () => {
    const games = gameService.listGames();
    expect(games.length).toBeGreaterThanOrEqual(7);

    const failedGames = [];
    for (const game of games) {
      try {
        const meta = gameplayService.getGameplayMeta(game.configPath);
        const mapping = prepareDevices(meta);
        const parameters = buildParameters(meta);

        const started = gameplayService.startGameplay(game.configPath, mapping, parameters);
        expect(started).toMatchObject({ ok: true, title: meta.title });
        expect(gameplayService.status()).toMatchObject({ running: true, title: meta.title });
        expect(gameplayService.getHtmlString()).toContain('<!DOCTYPE html>');

        await emitRepresentativeReports(mapping);

        const { action, payload } = supportedActionForTitle(meta.title);
        const actionResult = gameplayService.performAction(action, payload);
        expect(actionResult).toBeDefined();

        expect(publishedMessages.length).toBeGreaterThan(0);
        for (const item of publishedMessages) {
          expect(item.topic).toMatch(/^\/drecv\/.+/);
          expect(item.message).toEqual(expect.objectContaining({ method: expect.any(String) }));
        }
      } catch (error) {
        failedGames.push({ name: game.name, configPath: game.configPath, error: error?.stack || String(error) });
      } finally {
        gameplayService.stopGameplay();
        expect(gameplayService.status().running).toBe(false);
        deviceService.state.devices = [];
        publishedMessages.length = 0;
      }
    }

    expect(failedGames).toEqual([]);
  });
});
