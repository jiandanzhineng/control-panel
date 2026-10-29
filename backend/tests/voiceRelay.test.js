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

describe('voice relay', () => {
  let tempDir;
  let fetchMock;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-rel-'));
    process.env.VOICE_SETTINGS_PATH = path.join(tempDir, 'voice-settings.json');
    process.env.LOCAL_SESSION_PATH = path.join(tempDir, 'local-session.json');
    voiceSettings._resetForTests();
    localSession._resetForTests();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    delete process.env.VOICE_SETTINGS_PATH;
    delete process.env.LOCAL_SESSION_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function app() {
    const server = express();
    server.use('/v1', require('../routes/voiceCompletions'));
    return server;
  }

  it('forwards own_key to Xiaomi', async () => {
    voiceSettings.update({ route: 'own_key', api_key: 'sk-live-key' });
    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ ok: true }),
    });
    const res = await request(app()).post('/v1/chat/completions')
      .send({ model: 'mimo-v2.5', messages: [] });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    expect(opts.headers['api-key']).toBe('sk-live-key');
    expect(JSON.parse(opts.body).model).toBe('mimo-v2.6-flash');
  });

  it('forwards official route to mimo-relay with panel JWT', async () => {
    localSession.deposit('jwt-from-panel', { id: '1', email: 'a@b.com' });
    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ ok: true }),
    });
    const res = await request(app()).post('/v1/chat/completions')
      .send({ model: 'mimo-v2.5-tts', messages: [] });
    expect(res.status).toBe(200);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/v1\/chat\/completions$/);
    expect(url).not.toContain('xiaomimimo.com');
    expect(opts.headers.Authorization).toBe('Bearer jwt-from-panel');
    expect(JSON.parse(opts.body).model).toBe('mimo-v2.5-tts');
  });

  it('accepts v2.6-flash without changing the conversation or generation options', async () => {
    localSession.deposit('jwt-from-panel', { id: '1' });
    fetchMock.mockResolvedValue({
      status: 200, headers: { get: () => 'application/json' }, text: async () => '{}',
    });
    const body = { model: 'mimo-v2.6-flash', messages: [{ role: 'user', content: 'hello' }], thinking: { type: 'disabled' } };
    const res = await request(app()).post('/v1/chat/completions').send(body);
    expect(res.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(body);
  });

  it('pipes SSE chunks and stops when the client drops', async () => {
    voiceSettings.update({ route: 'own_key', api_key: 'sk-live-key' });
    const chunks = [
      new TextEncoder().encode('data: {"id":"1"}\n\n'),
      new TextEncoder().encode('data: [DONE]\n\n'),
    ];
    let i = 0;
    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader() {
          return {
            async read() {
              if (i >= chunks.length) return { done: true };
              return { done: false, value: chunks[i++] };
            },
            async cancel() { i = chunks.length; },
          };
        },
      },
    });
    const res = await request(app()).post('/v1/chat/completions')
      .send({ model: 'mimo-v2.5', stream: true, messages: [] });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('data: {"id":"1"}');
  });

  it('rejects non-loopback completions', async () => {
    jest.spyOn(localSession, 'isLoopback').mockReturnValue(false);
    const res = await request(app()).post('/v1/chat/completions')
      .send({ model: 'mimo-v2.5', messages: [] });
    expect(res.status).toBe(403);
    localSession.isLoopback.mockRestore();
  });

  it('preserves an upstream JSON error for a streaming request', async () => {
    localSession.deposit('jwt-from-panel', { id: '1' });
    fetchMock.mockResolvedValue({
      status: 502, headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: { code: 'UPSTREAM_AUTH_FAILED', message: 'contact administrator' } }),
    });
    const res = await request(app()).post('/v1/chat/completions')
      .send({ model: 'mimo-v2.5', stream: true, messages: [] });
    expect(res.status).toBe(502);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('UPSTREAM_AUTH_FAILED');
  });
});
