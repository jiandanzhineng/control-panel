// 游戏用语音识别（STT）：自备 SiliconFlow key 直连官方，否则走 mimo 中转。
// 两条通道请求格式完全一致（multipart: file + model），只有 base URL 与授权头不同，
// 约定见 docs/plans/reading-game.md §3.2。
const localSession = require('./localSessionService');
const voiceSettings = require('./voiceSettingsService');
const logService = require('./logService');
const modelRuntime = require('../model-runtime');

const DIRECT_BASE_DEFAULT = 'https://api.siliconflow.cn';
const MODEL = 'FunAudioLLM/SenseVoiceSmall';
const DEFAULT_TIMEOUT_MS = 10000;
const MIN_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 20000;
const MAX_AUDIO_BYTES = 1024 * 1024;
// 游戏只发 16kHz 单声道 WAV；其余格式直接判 BAD_AUDIO，避免把不确定的字节丢给上游。
const FORMATS = { wav: 'audio/wav' };

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.sttCode = code;
  return error;
}

function trimSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// base URL 可用环境变量覆盖（单测打本地假上游）。
function directBase() {
  return trimSlash(process.env.STT_DIRECT_BASE_URL || DIRECT_BASE_DEFAULT);
}

function relayBase() {
  let url = trimSlash(process.env.STT_RELAY_BASE_URL || localSession.getRelayUrl());
  if (url && !/\/v1$/.test(url)) url = `${url}/v1`;
  return url;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

/**
 * 选择通道：自备 key 直连，否则用账号 JWT 走中转。
 * 返回的 headers 含密钥，调用方不得记日志或回传。
 */
function resolveChannels() {
  const channels = [];
  const key = String(voiceSettings.getSiliconFlowKey() || '').trim();
  if (key) {
    channels.push({
      mode: 'own_key',
      url: `${directBase()}/v1/audio/transcriptions`,
      headers: { Authorization: `Bearer ${key}` },
    });
  }
  const session = localSession.get();
  const token = session && session.token;
  if (token) {
    const base = relayBase();
    if (base) {
      channels.push({
        mode: 'relay',
        url: `${base}/audio/transcriptions`,
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  }
  if (!channels.length) {
    throw makeError('NOT_SIGNED_IN', '未登录控制面板，请先登录或填写自己的 SiliconFlow key');
  }
  return channels;
}

function resolveChannel() {
  return resolveChannels()[0];
}

const LOCAL_TASK = 'asr.transcribe';

function status() {
  try {
    const local = modelRuntime.localStatus(LOCAL_TASK);
    if (local) return local;
  } catch (_) {}
  try {
    const channel = resolveChannel();
    return { ready: true, mode: channel.mode };
  } catch (error) {
    const mode = voiceSettings.sttMode() === 'relay' ? 'relay' : 'none';
    return { ready: false, mode, reason: error.code || 'NO_STT' };
  }
}

function clampTimeout(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(ms)));
}

// audio 是 base64（约定不带 data: 前缀，这里顺手兼容一下）。
function decodeAudio(audio) {
  const raw = typeof audio === 'string' ? audio.trim() : '';
  const body = raw.replace(/^data:[^,]*,/, '');
  if (!body) throw makeError('BAD_AUDIO', '音频为空');
  const buffer = Buffer.from(body, 'base64');
  if (!buffer.length) throw makeError('BAD_AUDIO', '音频不是合法的 base64');
  if (buffer.length > MAX_AUDIO_BYTES) throw makeError('BAD_AUDIO', '音频超过 1MB');
  return buffer;
}

function mapUpstreamError(status, data, mode) {
  const detail = data && typeof data === 'object' ? (data.message || data.error?.message || data.error) : '';
  const suffix = typeof detail === 'string' && detail ? `：${detail}` : '';
  // 走中转时 401 是账号 JWT 失效（中转自己的厂商 key 失效会回 502 UPSTREAM_AUTH_FAILED）。
  if (mode === 'relay' && status === 401) {
    return makeError('NOT_SIGNED_IN', '登录已失效，请重新登录或填写自己的 SiliconFlow key');
  }
  const relayCode = mode === 'relay' && data && data.error && data.error.code;
  if (relayCode === 'UPSTREAM_AUTH_FAILED' || relayCode === 'STT_KEY_NOT_CONFIGURED') {
    return makeError('UPSTREAM_AUTH_FAILED', `官方语音识别服务暂不可用${suffix}`);
  }
  if (relayCode === 'RATE_LIMITED') return makeError('RATE_LIMITED', `语音识别请求过于频繁，请稍后再试${suffix}`);
  if (relayCode === 'UPSTREAM_TIMEOUT') return makeError('TIMEOUT', '语音识别上游超时');
  if (status === 401 || status === 403) {
    return makeError('UPSTREAM_AUTH_FAILED', `语音识别密钥无效或未授权${suffix}`);
  }
  if (status === 429) return makeError('RATE_LIMITED', `语音识别请求过于频繁，请稍后再试${suffix}`);
  if (status === 413) return makeError('BAD_AUDIO', '音频超过服务端 1MB 限制');
  if (status === 408 || status === 504) return makeError('TIMEOUT', '语音识别上游超时');
  return makeError(`UPSTREAM_${status}`, `语音识别失败（HTTP ${status}）${suffix}`);
}

/**
 * 云端通道请求。失败 reject Error，带 code：NOT_SIGNED_IN | NO_STT | TIMEOUT |
 * RATE_LIMITED | UPSTREAM_* | BAD_AUDIO。日志只记通道、状态码和耗时。
 */
async function requestChannel(channel, buffer, fmt, timeout, startedAt) {
  const mime = FORMATS[fmt];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let statusCode = 0;
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), `audio.${fmt}`);
    form.append('model', MODEL);
    const upstream = await fetch(channel.url, {
      method: 'POST',
      headers: channel.headers,
      body: form,
      signal: controller.signal,
    });
    statusCode = upstream.status;
    const raw = await upstream.text();
    const data = parseJson(raw);
    if (!upstream.ok) throw mapUpstreamError(upstream.status, data, channel.mode);
    const text = data && typeof data.text === 'string' ? data.text : '';
    const latencyMs = Date.now() - startedAt;
    logService.debug('VoiceSTT', `mode=${channel.mode} status=${statusCode} ms=${latencyMs}`);
    return { text, mode: channel.mode, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    // 只认自己造的带 code 错误；fetch 的异常（AbortError 等）不读 .code，
    // 某些运行时读取 DOMException.code 会抛 TypeError。
    const mapped = error && error.sttCode
      ? error
      : (controller.signal.aborted
        ? makeError('TIMEOUT', '语音识别超时')
        : makeError('UPSTREAM_UNREACHABLE', `语音识别上游不可达: ${error?.message || error}`));
    logService.warn('VoiceSTT', `mode=${channel.mode} status=${statusCode} ms=${latencyMs} code=${mapped.code}`);
    throw mapped;
  } finally {
    clearTimeout(timer);
  }
}

/** 云端回退：自备 key 直连失败后再试官方中转。 */
async function transcribeCloud(input = {}, opts = {}) {
  const buffer = input.buffer || decodeAudio(input.audio);
  const fmt = String(input.format || 'wav').toLowerCase();
  if (!FORMATS[fmt]) throw makeError('BAD_AUDIO', `不支持的音频格式: ${input.format}`);
  const timeout = clampTimeout(opts.timeoutMs);
  const channels = resolveChannels();
  let lastError = null;
  for (const channel of channels) {
    try {
      return await requestChannel(channel, buffer, fmt, timeout, Date.now());
    } catch (error) {
      lastError = error;
      if (channels.length > 1) {
        logService.warn('VoiceSTT', `mode=${channel.mode} failed code=${error?.code || 'ERROR'}, trying next channel`);
      }
    }
  }
  throw lastError;
}

/**
 * 转写一段音频：{ audio(base64), format, timeoutMs } → { text, mode, latencyMs }。
 * 先走本地模型运行时；本地失败时 taskRouter 会回退到云端。
 */
async function transcribe({ audio, format = 'wav', timeoutMs } = {}) {
  const buffer = decodeAudio(audio);
  const fmt = String(format || 'wav').toLowerCase();
  if (!FORMATS[fmt]) throw makeError('BAD_AUDIO', `不支持的音频格式: ${format}`);
  return modelRuntime.run(LOCAL_TASK, {
    audio: buffer.toString('base64'),
    buffer,
    format: fmt,
  }, { timeoutMs: clampTimeout(timeoutMs) });
}

modelRuntime.registerCloudHandler(LOCAL_TASK, transcribeCloud);

module.exports = {
  status,
  resolveChannel,
  resolveChannels,
  transcribe,
  transcribeCloud,
  clampTimeout,
  MODEL,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_AUDIO_BYTES,
};
