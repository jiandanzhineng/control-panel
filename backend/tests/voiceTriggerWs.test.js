// 「语音开始」WS 端点：/voice-trigger 的握手、ready/detected 协议、未知口令、
// 远程会话拒绝，以及与 /bridge 在同一 http server 上按路径分发、互不干扰。
//
// 这里用真实 http server + 真实 ws 客户端跑，才能覆盖 noServer + upgrade 分发。
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const sherpa = require('sherpa-onnx');

jest.mock('../services/remoteSessionService', () => ({
  isOperatorRemoteMode: jest.fn(() => false),
}));

jest.mock('../services/logService', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  log: jest.fn(),
  cleanOldLogs: jest.fn(),
}));

const bridgeService = require('../services/bridgeService');
const voiceTriggerWs = require('../services/voiceTriggerWs');
const voiceTrigger = require('../voice/voiceTriggerService');
const remoteSession = require('../services/remoteSessionService');

const FIXTURE = path.join(__dirname, 'fixtures', 'voice', 'start-game.wav');

jest.setTimeout(120000);

let server = null;
let port = 0;
const opened = [];

function open(pathname) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`);
  ws.messages = [];
  ws.on('message', (raw) => {
    try { ws.messages.push(JSON.parse(raw.toString())); } catch (_) {}
  });
  opened.push(ws);
  return ws;
}

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function waitClosed(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve();
    ws.once('close', resolve);
  });
}

/** 等到 ws 收到满足条件的消息（模型懒加载需要 1~2 秒）。 */
async function waitMessage(ws, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = ws.messages.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`等待消息超时，已收到：${JSON.stringify(ws.messages)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function sendWav(ws, file) {
  const { samples } = sherpa.readWave(file);
  const chunk = 1600;
  for (let i = 0; i < samples.length; i += chunk) {
    const part = samples.subarray(i, i + chunk);
    ws.send(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
  }
}

beforeAll(async () => {
  server = http.createServer();
  bridgeService.init(server);
  voiceTriggerWs.init(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  for (const ws of opened) {
    try { ws.terminate(); } catch (_) {}
  }
  voiceTriggerWs.closeAll();
  voiceTrigger.resetForTest();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  remoteSession.isOperatorRemoteMode.mockReturnValue(false);
});

describe('voice trigger upgrade path', () => {
  it('only claims its own path', () => {
    expect(voiceTriggerWs.isVoiceTriggerUpgradePath('/voice-trigger')).toBe(true);
    expect(voiceTriggerWs.isVoiceTriggerUpgradePath('/voice-trigger?phrase=start_game')).toBe(true);
    expect(voiceTriggerWs.isVoiceTriggerUpgradePath('/bridge')).toBe(false);
    expect(voiceTriggerWs.isVoiceTriggerUpgradePath('/voice-trigger-extra')).toBe(false);
    expect(voiceTriggerWs.isVoiceTriggerUpgradePath('')).toBe(false);
    expect(bridgeService.isBridgeUpgradePath('/bridge')).toBe(true);
    expect(bridgeService.isBridgeUpgradePath('/voice-trigger')).toBe(false);
  });

  it('reads the phrase id from the query string', () => {
    expect(voiceTriggerWs.parsePhraseId('/voice-trigger?phrase=start_the_game')).toBe('start_the_game');
    expect(voiceTriggerWs.parsePhraseId('/voice-trigger')).toBe('');
    expect(voiceTriggerWs.parsePhraseId('')).toBe('');
    expect(voiceTriggerWs.parsePhraseId('/voice-trigger?phrase=%E5%BC%80')).toBe('开');
  });
});

describe('voice trigger websocket protocol', () => {
  it('sends ready then detected for the requested phrase', async () => {
    const ws = open('/voice-trigger?phrase=start_game');
    await waitOpen(ws);
    const ready = await waitMessage(ws, (m) => m.type === 'ready');
    expect(ready.phrase).toEqual({ id: 'start_game', label: '开始游戏' });

    sendWav(ws, FIXTURE);
    const detected = await waitMessage(ws, (m) => m.type === 'detected');
    expect(detected.phrase).toBe('开始游戏');
    expect(detected.phraseId).toBe('start_game');
    await waitClosed(ws);
  });

  it('honours the phrase chosen for this connection', async () => {
    const ws = open('/voice-trigger?phrase=start_the_game');
    await waitOpen(ws);
    const ready = await waitMessage(ws, (m) => m.type === 'ready');
    expect(ready.phrase).toEqual({ id: 'start_the_game', label: 'start the game' });
    ws.close();
  });

  it('detects the english phrase on its own connection', async () => {
    const ws = open('/voice-trigger?phrase=start_the_game');
    await waitOpen(ws);
    await waitMessage(ws, (m) => m.type === 'ready');
    sendWav(ws, path.join(__dirname, 'fixtures', 'voice', 'start-the-game.wav'));
    const detected = await waitMessage(ws, (m) => m.type === 'detected');
    expect(detected.phrase).toBe('start the game');
    expect(detected.phraseId).toBe('start_the_game');
    await waitClosed(ws);
  });

  it('falls back to the default phrase for an unknown id', async () => {
    const ws = open('/voice-trigger?phrase=zhimakaimen');
    await waitOpen(ws);
    const ready = await waitMessage(ws, (m) => m.type === 'ready');
    expect(ready.phrase).toEqual({ id: 'start_game', label: '开始游戏' });
    ws.close();
  });

  it('falls back to the default for phrase ids removed from the catalog', async () => {
    // 老版本前端 / 用户 localStorage 里可能还留着已删除的口令 id
    for (const stale of ['start_challenge', 'launch_game']) {
      const ws = open(`/voice-trigger?phrase=${stale}`);
      await waitOpen(ws);
      const ready = await waitMessage(ws, (m) => m.type === 'ready');
      expect(ready.phrase).toEqual({ id: 'start_game', label: '开始游戏' });
      ws.close();
      await waitClosed(ws);
    }
  });

  it('ignores non-binary and empty frames', async () => {
    const ws = open('/voice-trigger?phrase=start_game');
    await waitOpen(ws);
    await waitMessage(ws, (m) => m.type === 'ready');
    ws.send('{"hello":"world"}');
    ws.send(Buffer.alloc(2));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ws.messages.filter((m) => m.type !== 'ready')).toEqual([]);
    expect(ws.readyState).toBe(ws.OPEN);
    ws.close();
  });

  it('refuses the connection during a remote operator session', async () => {
    remoteSession.isOperatorRemoteMode.mockReturnValue(true);
    const ws = open('/voice-trigger?phrase=start_game');
    await waitOpen(ws);
    const error = await waitMessage(ws, (m) => m.type === 'error');
    expect(error.code).toBe('REMOTE_LOCKED');
    await waitClosed(ws);
  });
});

describe('voice trigger shares the http server with the bridge', () => {
  it('serves /bridge and /voice-trigger on the same server without interfering', async () => {
    const bridge = open('/bridge');
    await waitOpen(bridge);
    // 两个带 path 的 WebSocketServer 会互相 abortHandshake(400)，改成 noServer 后
    // 两条 upgrade 都必须成功握手。
    const voice = open('/voice-trigger?phrase=start_the_game');
    await waitOpen(voice);
    expect(bridge.readyState).toBe(bridge.OPEN);

    const ready = await waitMessage(voice, (m) => m.type === 'ready');
    expect(ready.phrase).toEqual({ id: 'start_the_game', label: 'start the game' });

    // 桥连接还开着时，语音链路照样能识别并回 detected
    sendWav(voice, path.join(__dirname, 'fixtures', 'voice', 'start-the-game.wav'));
    const detected = await waitMessage(voice, (m) => m.type === 'detected');
    expect(detected.phraseId).toBe('start_the_game');
    expect(bridge.readyState).toBe(bridge.OPEN);

    bridge.close();
    voice.close();
  });

  it('leaves the bridge connection untouched by voice traffic', async () => {
    const bridge = open('/bridge');
    await waitOpen(bridge);
    const voice = open('/voice-trigger?phrase=start_game');
    await waitOpen(voice);
    await waitMessage(voice, (m) => m.type === 'ready');
    voice.close();
    await waitClosed(voice);
    // 语音连接关闭不应影响桥连接
    expect(bridge.readyState).toBe(bridge.OPEN);
    expect(bridge.messages).toEqual([]);
    bridge.close();
  });
});
