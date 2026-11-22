const fs = require('fs');
const path = require('path');
const vm = require('vm');

function setup() {
  const handlers = {};
  const captures = [];
  let ws;
  class Capture {
    constructor() { captures.push(this); }
    async start(onFrame) { this.onFrame = onFrame; this.stopped = false; return true; }
    stop() { this.stopped = true; }
  }
  class WebSocket {
    constructor() { ws = this; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
    send(raw) { this.sent.push(JSON.parse(raw)); }
  }
  const window = { VocabCommandAudio: Capture, addEventListener: (name, fn) => { handlers[name] = fn; } };
  const document = { hidden: false, getElementById: id => id === 'game-manifest' ? { textContent: '{"id":"vocab-game"}' } : null,
    addEventListener: (name, fn) => { handlers[name] = fn; } };
  const context = { window, document, WebSocket, URLSearchParams, Promise, Map, Date,
    location: { protocol: 'http:', host: 'localhost:5278', search: '', hash: '' }, setTimeout: jest.fn() };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/device-api-bridge.js'), 'utf8'), context);
  return { window, document, ws, handlers, captures };
}

test('KWS bridge filters stale/TTS/background events and releases/reopens capture', async () => {
  const { window, document, ws, handlers, captures } = setup();
  const commands = window.DeviceAPI.speech.commands;
  const callback = jest.fn();
  const pending = commands.start({ generation: 1, seq: 2, blockedUntil: 0 }, callback);
  const request = ws.sent.at(-1);
  ws.onmessage({ data: JSON.stringify({ id: request.id, result: { ready: true, mode: 'kws' } }) });
  await expect(pending).resolves.toMatchObject({ ready: true });
  const event = data => ws.onmessage({ data: JSON.stringify({ event: 'speechCommand', data }) });
  event({ generation: 0, seq: 2 });
  event({ generation: 1, seq: 1 });
  expect(callback).not.toHaveBeenCalled();
  event({ generation: 1, seq: 2, command: 'choice_2' });
  expect(callback).toHaveBeenCalledTimes(1);
  commands.update({ generation: 1, seq: 3, blockedUntil: Date.now() + 10000 });
  event({ generation: 1, seq: 3 });
  expect(callback).toHaveBeenCalledTimes(1);
  document.hidden = true;
  await handlers.visibilitychange();
  expect(captures[0].stopped).toBe(true);
  event({ generation: 1, seq: 3 });
  expect(callback).toHaveBeenCalledTimes(1);
  document.hidden = false;
  await handlers.visibilitychange();
  expect(captures).toHaveLength(2);
  const stopped = commands.stop(1);
  ws.onmessage({ data: JSON.stringify({ id: ws.sent.at(-1).id, result: { ok: true } }) });
  await stopped;
  expect(captures[1].stopped).toBe(true);
  expect(ws.sent.some(message => message.action === 'speechToText')).toBe(false);
});
