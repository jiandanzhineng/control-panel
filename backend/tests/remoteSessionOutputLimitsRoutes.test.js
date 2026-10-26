const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../services/remoteSessionService', () => ({
  getStatus: jest.fn(() => ({ active: false })),
}));

const express = require('express');
const request = require('supertest');
const router = require('../routes/remoteSession');
const settings = require('../services/remoteOutputSettingsService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/remote-session', router);
  return app;
}

describe('remote session output limit routes', () => {
  let tempDir;
  let previousPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-session-limits-'));
    previousPath = process.env.REMOTE_OUTPUT_SETTINGS_PATH;
    process.env.REMOTE_OUTPUT_SETTINGS_PATH = path.join(tempDir, 'remote-output-settings.json');
    settings.resetCache();
  });

  afterEach(() => {
    if (previousPath === undefined) delete process.env.REMOTE_OUTPUT_SETTINGS_PATH;
    else process.env.REMOTE_OUTPUT_SETTINGS_PATH = previousPath;
    settings.resetCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('reads the owner-set cap with its range and defaults', async () => {
    const response = await request(createApp()).get('/api/remote-session/output-limits').expect(200);
    expect(response.body).toMatchObject({
      voltage: 20,
      range: { min: 0, max: 100 },
      limits: { voltage: 20, power: 128, intensity: 50 },
    });
  });

  test('saves the cap, clamps out-of-range input, and rejects non-numbers', async () => {
    const app = createApp();
    const saved = await request(app)
      .put('/api/remote-session/output-limits')
      .send({ voltage: 60 })
      .expect(200);
    expect(saved.body).toMatchObject({ voltage: 60, limits: { voltage: 60, intensity: 60 } });
    expect(JSON.parse(fs.readFileSync(process.env.REMOTE_OUTPUT_SETTINGS_PATH, 'utf8')))
      .toEqual({ voltage: 60 });

    const clamped = await request(app)
      .put('/api/remote-session/output-limits')
      .send({ voltage: 130 })
      .expect(200);
    expect(clamped.body.voltage).toBe(100);

    const invalid = await request(app)
      .put('/api/remote-session/output-limits')
      .send({ voltage: 'abc' })
      .expect(400);
    expect(invalid.body.error).toMatchObject({ code: 'OUTPUT_LIMIT_INVALID' });
    expect(settings.getLimits().voltage).toBe(100);
  });
});
