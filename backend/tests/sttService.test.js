const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

jest.mock('../services/logService', () => ({
  info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const localSession = require('../services/localSessionService');
const voiceSettings = require('../services/voiceSettingsService');
const sttService = require('../services/sttService');

// 1 字节的假 WAV 头足够走通整条链路（上游是本地假服务）。
const TINY_WAV = Buffer.from('RIFF....WAVEfmt ').toString('base64');

function startUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

describe('sttService', () => {
  let tempDir;
  let upstream;
  let seen;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
    process.env.VOICE_SETTINGS_PATH = path.join(tempDir, 'voice-settings.json');
    process.env.LOCAL_SESSION_PATH = path.join(tempDir, 'local-session.json');
    voiceSettings._resetForTests();
    localSession._resetForTests();
    seen = [];
    upstream = await startUpstream(async (req, res) => {
      const body = await readBody(req);
      seen.push({
        url: req.url,
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: body.toString('utf8'),
      });
      const reply = upstream.reply || { status: 200, body: { text: '你好' } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    process.env.STT_DIRECT_BASE_URL = upstream.base;
    process.env.STT_RELAY_BASE_URL = upstream.base;
  });

  afterEach(async () => {
    delete process.env.VOICE_SETTINGS_PATH;
    delete process.env.LOCAL_SESSION_PATH;
    delete process.env.STT_DIRECT_BASE_URL;
    delete process.env.STT_RELAY_BASE_URL;
    await new Promise((resolve) => upstream.server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses the own SiliconFlow key directly when configured', async () => {
    voiceSettings.update({ siliconflow_api_key: 'sk-own-123456' });
    const result = await sttService.transcribe({ audio: TINY_WAV, format: 'wav' });
    expect(result.mode).toBe('own_key');
    expect(result.text).toBe('你好');
    expect(typeof result.latencyMs).toBe('number');
    expect(seen[0].url).toBe('/v1/audio/transcriptions');
    expect(seen[0].auth).toBe('Bearer sk-own-123456');
    expect(seen[0].contentType).toContain('multipart/form-data');
    expect(seen[0].body).toContain('FunAudioLLM/SenseVoiceSmall');
    expect(seen[0].body).toContain('name="file"');
  });

  it('falls back to the relay with the account JWT when no own key', async () => {
    localSession.deposit('jwt-account-token', { id: 'u1', email: 'a@b.c' });
    const result = await sttService.transcribe({ audio: TINY_WAV });
    expect(result.mode).toBe('relay');
    expect(seen[0].url).toBe('/v1/audio/transcriptions');
    expect(seen[0].auth).toBe('Bearer jwt-account-token');
  });

  it('reports NOT_SIGNED_IN when there is neither key nor login', async () => {
    expect(sttService.status()).toEqual({ ready: false, mode: 'none', reason: 'NOT_SIGNED_IN' });
    await expect(sttService.transcribe({ audio: TINY_WAV })).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' });
    expect(seen).toHaveLength(0);
  });

  it('reports ready relay mode when signed in', () => {
    localSession.deposit('jwt-account-token', { id: 'u1' });
    expect(sttService.status()).toEqual({ ready: true, mode: 'relay' });
    voiceSettings.update({ siliconflow_api_key: 'sk-own-123456' });
    expect(sttService.status()).toEqual({ ready: true, mode: 'own_key' });
  });

  it('rejects decoded audio over 1MB with BAD_AUDIO before calling upstream', async () => {
    localSession.deposit('jwt-account-token', { id: 'u1' });
    const big = Buffer.alloc(1024 * 1024 + 1, 1).toString('base64');
    await expect(sttService.transcribe({ audio: big })).rejects.toMatchObject({ code: 'BAD_AUDIO' });
    await expect(sttService.transcribe({ audio: '' })).rejects.toMatchObject({ code: 'BAD_AUDIO' });
    expect(seen).toHaveLength(0);
  });

  it('maps upstream failures to the agreed error codes', async () => {
    localSession.deposit('jwt-account-token', { id: 'u1' });
    const cases = [
      // 中转模式下 401 是账号登录失效
      [401, 'NOT_SIGNED_IN'],
      [403, 'UPSTREAM_AUTH_FAILED'],
      [429, 'RATE_LIMITED'],
      [413, 'BAD_AUDIO'],
      [504, 'TIMEOUT'],
      [500, 'UPSTREAM_500'],
    ];
    for (const [status, code] of cases) {
      upstream.reply = { status, body: { message: 'upstream says no' } };
      // eslint-disable-next-line no-await-in-loop
      await expect(sttService.transcribe({ audio: TINY_WAV })).rejects.toMatchObject({ code });
    }
    // 中转自己的厂商 key 失效：502 + error.code
    upstream.reply = { status: 502, body: { error: { code: 'UPSTREAM_AUTH_FAILED', message: 'x' } } };
    await expect(sttService.transcribe({ audio: TINY_WAV })).rejects.toMatchObject({ code: 'UPSTREAM_AUTH_FAILED' });
  });

  it('maps a 401 from SiliconFlow to UPSTREAM_AUTH_FAILED when using the own key', async () => {
    voiceSettings.update({ siliconflow_api_key: 'sk-own-test' });
    upstream.reply = { status: 401, body: { message: 'Invalid token' } };
    await expect(sttService.transcribe({ audio: TINY_WAV })).rejects.toMatchObject({ code: 'UPSTREAM_AUTH_FAILED' });
  });

  it('aborts the upstream request when the timeout elapses', async () => {
    localSession.deposit('jwt-account-token', { id: 'u1' });
    const slow = await startUpstream(() => { /* 永不响应，等客户端中止 */ });
    process.env.STT_RELAY_BASE_URL = slow.base;
    try {
      const startedAt = Date.now();
      await expect(sttService.transcribe({ audio: TINY_WAV, timeoutMs: 1000 }))
        .rejects.toMatchObject({ code: 'TIMEOUT' });
      // 请求被真正中止：函数在钳制后的 3s 左右返回，而不是一直挂着。
      expect(Date.now() - startedAt).toBeLessThan(6000);
    } finally {
      await new Promise((resolve) => slow.server.close(resolve));
    }
  }, 15000);
});
