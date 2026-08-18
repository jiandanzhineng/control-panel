// 本机 MiMo 中转：按面板设置把 chat/completions 转到官方 relay 或小米直连。
const voiceSettings = require('./voiceSettingsService');

const ALLOWED_MODELS = new Set([
  'mimo-v2.5',
  'mimo-v2.5-asr',
  'mimo-v2.5-tts',
]);

function sendJsonError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

async function pipeUpstream(upstream, res, stream) {
  res.status(upstream.status);
  const ct = upstream.headers.get('content-type');
  if (!stream) {
    if (ct) res.set('content-type', ct);
    res.send(await upstream.text());
    return;
  }
  res.set({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  let aborted = false;
  res.on('close', () => {
    aborted = true;
    reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || aborted) break;
      res.write(Buffer.from(value));
    }
  } catch (e) {
    if (!aborted) res.write(`data: {"error":${JSON.stringify(String(e.message))}}\n\n`);
  } finally {
    if (!aborted) res.end();
  }
}

async function chatCompletions(req, res) {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return sendJsonError(res, 400, 'BAD_BODY', '请求体必须是 JSON');
  }
  if (!ALLOWED_MODELS.has(body.model)) {
    return sendJsonError(res, 403, 'MODEL_NOT_ALLOWED', `不支持的模型: ${body.model}`);
  }
  let target;
  try {
    target = voiceSettings.resolve();
  } catch (e) {
    const status = e.code === 'NOT_SIGNED_IN' || e.code === 'NO_OWN_KEY' ? 401 : 400;
    return sendJsonError(res, status, e.code || 'VOICE_NOT_READY', e.message);
  }
  let upstream;
  try {
    upstream = await fetch(`${target.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...target.headers },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return sendJsonError(res, 502, 'UPSTREAM_UNREACHABLE', `上游不可达: ${e.message}`);
  }
  return pipeUpstream(upstream, res, Boolean(body.stream));
}

module.exports = { chatCompletions, ALLOWED_MODELS };
