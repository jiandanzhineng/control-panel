const http = require('http');
const express = require('express');
const request = require('supertest');
const eventBus = require('../services/eventBus');

function createApp() {
  const app = express();
  app.use('/api/events', require('../routes/events'));
  return app;
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function parseSseChunk(chunk) {
  const event = {};
  for (const line of chunk.split('\n')) {
    if (line.startsWith('id: ')) event.id = line.slice(4);
    else if (line.startsWith('data: ')) {
      try { event.data = JSON.parse(line.slice(6)); } catch (_) { event.data = line.slice(6); }
    }
  }
  return event;
}

async function openStream(url, headers = {}) {
  const response = await fetch(url, { headers });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];

  async function readUntil(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(events)) return events;
      const remaining = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('SSE read timeout')), remaining);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        // 注释帧（retry / : ping）没有 data，不纳入事件列表
        if (chunk.includes('data: ')) events.push(parseSseChunk(chunk));
        index = buffer.indexOf('\n\n');
      }
    }
    if (predicate(events)) return events;
    throw new Error(`SSE wait failed: ${JSON.stringify(events)}`);
  }

  return {
    events,
    readUntil,
    async close() {
      try { await reader.cancel(); } catch (_) {}
    },
  };
}

describe('events routes', () => {
  let server;
  let baseUrl;

  beforeEach(async () => {
    eventBus._resetForTests();
    server = await startServer(createApp());
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    eventBus._resetForTests();
    await new Promise((resolve) => server.close(resolve));
  });

  it('returns recent events with type filtering and limit', async () => {
    eventBus.publish('device.added', { deviceId: 'd1' });
    eventBus.publish('game.started', { gameId: 'g1' });
    eventBus.publish('device.removed', { deviceId: 'd1' });

    const all = await request(createApp()).get('/api/events/recent?limit=2');
    expect(all.status).toBe(200);
    expect(all.body.map((event) => event.type)).toEqual(['game.started', 'device.removed']);

    const filtered = await request(createApp()).get('/api/events/recent?types=device');
    expect(filtered.body.map((event) => event.type)).toEqual(['device.added', 'device.removed']);
  });

  it('sends hello then live events over SSE', async () => {
    const stream = await openStream(`${baseUrl}/api/events/stream`);
    try {
      await stream.readUntil((events) => events.some((event) => event.data?.type === 'hello'));
      const hello = stream.events.find((event) => event.data?.type === 'hello');
      expect(hello.data).toMatchObject({ type: 'hello', seq: 0, mode: 'local' });

      eventBus.publish('device.added', { deviceId: 'd1', device: { id: 'd1' } });
      await stream.readUntil((events) => events.some((event) => event.data?.type === 'device.added'));
      const added = stream.events.find((event) => event.data?.type === 'device.added');
      expect(added.id).toBe('1');
      expect(added.data).toMatchObject({ type: 'device.added', seq: 1, deviceId: 'd1' });
    } finally {
      await stream.close();
    }
  });

  it('filters by types prefix and honours Last-Event-ID backfill', async () => {
    const first = eventBus.publish('device.added', { deviceId: 'd1' });
    eventBus.publish('game.started', { gameId: 'g1' });
    const third = eventBus.publish('game.state', { gameId: 'g1' });

    const stream = await openStream(`${baseUrl}/api/events/stream?types=game`, {
      'Last-Event-ID': String(first.seq),
    });
    try {
      await stream.readUntil((events) => events.some((event) => event.data?.type === 'game.state'));
      const types = stream.events.filter((event) => event.data?.type !== 'hello').map((event) => event.data.type);
      expect(types).toEqual(['game.started', 'game.state']);
      expect(stream.events.some((event) => event.data?.type === 'device.added')).toBe(false);
      const last = stream.events.find((event) => event.data?.type === 'game.state');
      expect(last.id).toBe(String(third.seq));
    } finally {
      await stream.close();
    }
  });
});
