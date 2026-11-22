'use strict';

const { ApiError } = require('./errors');

/** 解析一个 SSE 事件块（不含结尾空行）。 */
function parseSseBlock(block) {
  const result = { data: '', id: undefined, event: undefined, retry: undefined };
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') result.data = result.data ? `${result.data}\n${value}` : value;
    else if (field === 'id') result.id = value;
    else if (field === 'event') result.event = value;
    else if (field === 'retry') result.retry = value;
  }
  return result;
}

/** 是否属于应忽略的控制帧（hello / ping）。 */
function isControlPayload(payload) {
  if (!payload || typeof payload !== 'object') return true;
  if (payload.type === 'hello' || payload.hello === true) return true;
  if (payload.type === 'ping' || payload.event === 'ping') return true;
  return false;
}

/**
 * 消费 SSE 流直到结束或 signal 中止。每个业务事件回调 onEvent。
 * @returns {Promise<'ended'|'aborted'>}
 */
async function consumeSse(response, { onEvent, onHello, signal } = {}) {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(`事件流连接失败：HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`, {
      code: 'EVENT_STREAM_FAILED',
      status: response.status,
      path: '/events/stream'
    });
  }
  if (!response.body) {
    throw new ApiError('事件流没有响应内容', { code: 'EVENT_STREAM_NO_BODY', path: '/events/stream' });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const abort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (!block.trim() || block.startsWith(':')) continue;
        const parsed = parseSseBlock(block);
        if (!parsed.data) continue;
        let payload;
        try { payload = JSON.parse(parsed.data); } catch { continue; }
        if (isControlPayload(payload)) {
          if (payload.type === 'hello') onHello?.(payload);
          continue;
        }
        const event = { ...payload };
        if (parsed.id !== undefined && event.seq === undefined) event.seq = Number(parsed.id);
        onEvent?.(event);
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock?.();
  }
}

/** 打开事件流并消费。返回 'ended' | 'aborted'。 */
async function streamEvents({ api, types = [], timeoutMs = 15000, signal, onEvent, onHello }) {
  const query = types.length ? { types: types.join(',') } : undefined;
  let response;
  try {
    const result = await api.request('GET', '/events/stream', {
      query,
      raw: true,
      timeoutMs,
      headers: { accept: 'text/event-stream', 'cache-control': 'no-cache' }
    });
    response = result.response;
  } catch (error) {
    if (signal?.aborted) return 'aborted';
    throw error;
  }
  try {
    await consumeSse(response, { onEvent, onHello, signal });
  } catch (error) {
    if (signal?.aborted) return 'aborted';
    throw error;
  }
  return signal?.aborted ? 'aborted' : 'ended';
}

module.exports = { parseSseBlock, isControlPayload, consumeSse, streamEvents };
