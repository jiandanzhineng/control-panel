const express = require('express');
const eventBus = require('../services/eventBus');
const remoteSession = require('../services/remoteSessionService');

const router = express.Router();
const HEARTBEAT_MS = 15 * 1000;

function parseTypes(value) {
  if (Array.isArray(value)) return value.flatMap((item) => parseTypes(item));
  const text = String(value || '').trim();
  if (!text) return [];
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function writeEvent(res, event) {
  res.write(`id: ${event.seq}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeSseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
}

router.get('/stream', (req, res) => {
  const types = parseTypes(req.query.types);
  const lastEventId = req.get('Last-Event-ID') || req.query.lastEventId;
  writeSseHeaders(res);

  // hello 用普通 data 帧（type:'hello'），默认 onmessage 也能收到；
  // 之后每条事件带 id: seq，浏览器/插件重连会自动回传 Last-Event-ID。
  res.write(`data: ${JSON.stringify({
    type: 'hello',
    seq: eventBus.getSeq(),
    mode: typeof remoteSession.getMode === 'function' ? remoteSession.getMode() : 'local',
  })}\n\n`);

  let lastSeq = Number(lastEventId);
  // 没有 Last-Event-ID 的新连接只收连上之后的事件；带 id（含 0）才补发环形缓冲。
  if (!Number.isFinite(lastSeq) || lastSeq < 0) lastSeq = eventBus.getSeq();

  let replaying = true;
  const queue = [];
  const deliver = (event) => {
    if (!event || event.seq <= lastSeq) return;
    lastSeq = event.seq;
    if (!eventBus.matchesTypes(event.type, types)) return;
    try { writeEvent(res, event); } catch (_) { /* 客户端断开 */ }
  };
  const unsubscribe = eventBus.subscribe((event) => {
    if (replaying) queue.push(event);
    else deliver(event);
  });

  // 先补发环形缓冲，再排空订阅期间收到的事件，保证顺序且不丢事件。
  for (const event of eventBus.since(lastSeq)) deliver(event);
  replaying = false;
  for (const event of queue) deliver(event);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, HEARTBEAT_MS);
  if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();

  const cleanup = () => {
    clearInterval(heartbeat);
    try { unsubscribe(); } catch (_) {}
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

router.get('/recent', (req, res) => {
  const limit = Math.max(0, Math.min(eventBus.RING_SIZE, Number(req.query.limit) || 100));
  res.json(eventBus.recent({ limit, types: parseTypes(req.query.types) }));
});

module.exports = router;
module.exports.parseTypes = parseTypes;
