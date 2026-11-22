'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSseBlock, isControlPayload, consumeSse } = require('../lib/sse');

test('parseSseBlock 解析 id/data/event 并处理 CRLF', () => {
  const parsed = parseSseBlock('id: 42\r\ndata: {"type":"device.added"}\r\nevent: custom');
  assert.equal(parsed.id, '42');
  assert.equal(parsed.event, 'custom');
  assert.equal(parsed.data, '{"type":"device.added"}');
});

test('parseSseBlock 合并多行 data 并忽略注释', () => {
  const parsed = parseSseBlock(': ping\ndata: line1\ndata: line2');
  assert.equal(parsed.data, 'line1\nline2');
});

test('isControlPayload 识别 hello/ping', () => {
  assert.equal(isControlPayload({ type: 'hello', seq: 1 }), true);
  assert.equal(isControlPayload({ type: 'ping' }), true);
  assert.equal(isControlPayload({ type: 'device.added' }), false);
  assert.equal(isControlPayload(null), true);
});

test('consumeSse 逐条回调业务事件并跳过 hello 与注释心跳', async () => {
  const frames = [
    'data: {"type":"hello","seq":0,"mode":"local"}\n\n',
    ': ping\n\n',
    'id: 1\ndata: {"seq":1,"type":"device.added","deviceId":"a"}\n\n',
    'id: 2\ndata: {"seq":2,"type":"game.started","gameId":"g"}\n\n'
  ];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    }
  });
  const events = [];
  const hellos = [];
  await consumeSse(new Response(stream, { status: 200 }), {
    onHello: (hello) => hellos.push(hello),
    onEvent: (event) => events.push(event)
  });
  assert.equal(hellos.length, 1);
  assert.deepEqual(events.map((event) => event.type), ['device.added', 'game.started']);
});
