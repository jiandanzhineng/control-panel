// 「语音开始」WebSocket 端点：/voice-trigger?phrase=<id>
//
// 与 bridge 共用同一个 http server，因此也复用 bridge 的访问控制规则
// （只放行本机来源）并在 server 的 upgrade 事件里按路径分发——两个带 path 的
// WebSocketServer 会互相 abortHandshake(400)，必须 noServer（见 bridgeService.init）。
//
// 协议：
//   连上 → 服务端发 {"type":"ready"}
//   收到前端二进制 16kHz 单声道 Float32 PCM 帧 → 检测
//   检测到 → 服务端发 {"type":"detected","phrase":"开始游戏"}
//   出错 → 服务端发 {"type":"error","message":"..."} 并关闭
// 远程会话（主控端远程模式）期间拒绝连接：本机麦克风与识别不参与远控。
const { WebSocketServer } = require('ws');
const logService = require('./logService');
const bridgeService = require('./bridgeService');
const wsUpgradeRouter = require('./wsUpgradeRouter');
const remoteSession = require('./remoteSessionService');
const phraseCatalog = require('../voice/voicePhraseCatalog');
const voiceTrigger = require('../voice/voiceTriggerService');

const VOICE_TRIGGER_PATH = '/voice-trigger';
// 单连接最长存活：等待页/测试弹窗都远短于此，超时兜底避免前端异常退出后残留识别流。
const MAX_SESSION_MS = 10 * 60 * 1000;

let wss = null;

function isVoiceTriggerUpgradePath(url) {
  const raw = String(url || '');
  const index = raw.indexOf('?');
  const pathname = index === -1 ? raw : raw.slice(0, index);
  return pathname === VOICE_TRIGGER_PATH;
}

function parsePhraseId(url) {
  try {
    const parsed = new URL(String(url || ''), 'http://127.0.0.1');
    return parsed.searchParams.get('phrase') || '';
  } catch (_) {
    return '';
  }
}

function sendJson(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function handleConnection(ws, req) {
  // 远程会话期间本机不提供语音开始（入口也已在界面隐藏）。
  if (remoteSession.isOperatorRemoteMode()) {
    sendJson(ws, { type: 'error', code: 'REMOTE_LOCKED', message: '远程控制中不可用，断开后可用' });
    ws.close();
    return;
  }

  const requested = parsePhraseId(req?.url);
  const phrase = phraseCatalog.getPhrase(requested) || phraseCatalog.getDefaultPhrase();

  // 模型一次装全部口令（KeywordSpotter 不支持按流换词），所以这里拿到的命中可能是
  // 另一个口令；只回本连接选定的那个，避免「选了英文口令却被中文口令触发」。
  const wanted = phrase.label;

  let session = null;
  let closed = false;
  const timer = setTimeout(() => {
    sendJson(ws, { type: 'error', code: 'TIMEOUT', message: '语音识别超时' });
    ws.close();
  }, MAX_SESSION_MS);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    try { session?.close(); } catch (_) {}
    session = null;
  }

  voiceTrigger.createSession().then((created) => {
    if (closed) { created.close(); return; }
    session = created;
    sendJson(ws, { type: 'ready', phrase: { id: phrase.id, label: phrase.label } });
  }).catch((error) => {
    logService.warn('VoiceTrigger', `识别流创建失败：${error?.message || error}`);
    sendJson(ws, { type: 'error', code: 'MODEL_UNAVAILABLE', message: '语音模型不可用' });
    ws.close();
  });

  ws.on('message', (raw, isBinary) => {
    if (closed || !session) return;
    if (!isBinary) return; // 只接受二进制 PCM
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (buf.length < 4) return;
    // 前端按 Float32 小端发送；Node Buffer 可能未对齐，先复制到对齐缓冲再建视图。
    const aligned = Buffer.from(buf);
    const samples = new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.length / 4));
    try {
      const hit = session.accept(samples);
      if (hit && hit.label === wanted) {
        sendJson(ws, { type: 'detected', phrase: hit.label, phraseId: hit.id });
        ws.close();
      }
    } catch (error) {
      logService.warn('VoiceTrigger', `识别失败：${error?.message || error}`);
      sendJson(ws, { type: 'error', code: 'DECODE_FAILED', message: '语音识别失败' });
      ws.close();
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

function init(server) {
  if (wss) return wss;
  wss = new WebSocketServer({
    noServer: true,
    verifyClient: bridgeService.verifyBridgeClient,
  });
  wss.on('connection', handleConnection);

  // 与 /bridge 共用 wsUpgradeRouter：谁都不认领的路径由分发器回 400 并销毁 socket。
  wsUpgradeRouter.register('voice-trigger', isVoiceTriggerUpgradePath, (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
  });
  wsUpgradeRouter.attach(server);
  return wss;
}

function closeAll() {
  if (!wss) return;
  for (const client of wss.clients) {
    try { client.close(); } catch (_) {}
  }
}

module.exports = {
  VOICE_TRIGGER_PATH,
  isVoiceTriggerUpgradePath,
  parsePhraseId,
  init,
  closeAll,
};
