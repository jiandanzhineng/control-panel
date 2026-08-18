const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../utils/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(),
}));

const localSession = require('../services/localSessionService');
const voiceSettings = require('../services/voiceSettingsService');

describe('voice settings', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-set-'));
    process.env.VOICE_SETTINGS_PATH = path.join(tempDir, 'voice-settings.json');
    process.env.LOCAL_SESSION_PATH = path.join(tempDir, 'local-session.json');
    voiceSettings._resetForTests();
    localSession._resetForTests();
  });

  afterEach(() => {
    delete process.env.VOICE_SETTINGS_PATH;
    delete process.env.LOCAL_SESSION_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function app() {
    const server = express();
    server.use(express.json());
    server.use('/api/voice', require('../routes/voice'));
    return server;
  }

  it('defaults to official panel route before user saves', async () => {
    const res = await request(app()).get('/api/voice/status');
    expect(res.status).toBe(200);
    expect(res.body.route).toBe('panel');
    expect(res.body.route_chosen).toBe(false);
    expect(res.body.ready).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/sk-/);
  });

  it('keeps own_key after the user saves it', async () => {
    const saved = await request(app()).post('/api/voice/settings')
      .send({ route: 'own_key', api_key: 'sk-abcdefghijklmnop' });
    expect(saved.status).toBe(200);
    expect(saved.body.route_chosen).toBe(true);
    expect(saved.body.route).toBe('own_key');
    expect(saved.body.ready).toBe(true);
    expect(saved.body.key_masked).toMatch(/^sk-a/);
    expect(JSON.stringify(saved.body)).not.toContain('sk-abcdefghijklmnop');

    voiceSettings._resetForTests();
    const again = await request(app()).get('/api/voice/status');
    expect(again.body.route).toBe('own_key');
    expect(again.body.ready).toBe(true);
  });

  it('rejects unknown route', async () => {
    const res = await request(app()).post('/api/voice/settings').send({ route: 'silicon' });
    expect(res.status).toBe(400);
  });
});
