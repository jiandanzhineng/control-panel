const path = require('path');
const sherpa = require('sherpa-onnx');
const { VocabCommandSession } = require('../voice/vocabCommandSession');

jest.setTimeout(120000);
const dir = path.join(__dirname, 'fixtures', 'voice');

function pcm(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  return buffer.toString('base64');
}

function feed(session, file, advance) {
  const { samples } = sherpa.readWave(path.join(dir, file));
  const input = new Float32Array(samples.length + 16000);
  input.set(samples);
  for (let i = 0; i < input.length; i += 512) {
    advance(32);
    session.accept({ generation: session.generation, seq: session.seq, audio: pcm(input.subarray(i, i + 512)) });
  }
}

test('real KWS recognizes all twelve Chinese/English commands in one continuous session', async () => {
  let now = 10000;
  const events = [];
  const session = new VocabCommandSession({ send: event => events.push(event.data), now: () => now });
  try {
    await session.start({ generation: 1, seq: 1 });
    const expected = ['choice_1', 'choice_2', 'choice_3', 'choice_4', 'continue', 'unknown'];
    for (const prefix of ['command', 'en']) for (let i = 1; i <= 6; i++) {
      const before = events.length;
      feed(session, `vocab/${prefix}-${i}.wav`, ms => { now += ms; });
      expect(events.slice(before).map(event => event.command)).toEqual([expected[i - 1]]);
    }
    expect(events).toHaveLength(12);
    expect(events.every(event => event.mode === 'kws')).toBe(true);
  } finally { session.dispose(); }
});

test('real KWS ignores ordinary speech, silence, and the separate start-game keyword', async () => {
  let now = 10000;
  const events = [];
  const session = new VocabCommandSession({ send: event => events.push(event), now: () => now });
  try {
    await session.start({ generation: 1, seq: 1 });
    for (const file of ['vocab/plain-speech-zh.wav', 'plain-speech-en.wav', 'start-game.wav', 'start-the-game.wav', 'silence.wav']) {
      feed(session, file, ms => { now += ms; });
    }
    expect(events).toEqual([]);
  } finally { session.dispose(); }
});

test('blocks TTS audio, resets acoustic history on unblock/next question, and rejects stale frames', async () => {
  let now = 10000;
  const stream = { accept: jest.fn(() => ({ id: 'choice_1', label: '第一个' })), reset: jest.fn(), close: jest.fn() };
  const send = jest.fn();
  const session = new VocabCommandSession({ send, now: () => now, createSession: async () => stream });
  await session.start({ generation: 1, seq: 1, blockedUntil: 11000 });
  const frame = { generation: 1, seq: 1, audio: pcm(new Float32Array(1600)) };
  session.accept(frame);
  expect(stream.accept).not.toHaveBeenCalled();
  now = 12000;
  session.accept(frame);
  expect(send).toHaveBeenCalledTimes(1);
  expect(stream.reset).toHaveBeenCalledTimes(2);
  session.update({ generation: 1, seq: 2 });
  session.accept(frame);
  session.accept({ ...frame, generation: 0, seq: 2 });
  expect(stream.accept).toHaveBeenCalledTimes(1);
  expect(stream.reset).toHaveBeenCalledTimes(3);
  session.dispose();
});

test('late model startup after stop or replacement cannot reactivate a session', async () => {
  let finish;
  const stream = { close: jest.fn() };
  const session = new VocabCommandSession({ send: jest.fn(), createSession: () => new Promise(resolve => { finish = resolve; }) });
  const started = session.start({ generation: 1, seq: 1 });
  session.stop(1);
  finish(stream);
  await expect(started).resolves.toMatchObject({ ready: false });
  expect(stream.close).toHaveBeenCalledTimes(1);
  session.dispose();
});

test('old generation stop does not terminate a new session; malformed PCM is ignored', async () => {
  const stream = { accept: jest.fn(), reset: jest.fn(), close: jest.fn() };
  const session = new VocabCommandSession({ send: jest.fn(), createSession: async () => stream });
  await session.start({ generation: 2, seq: 1 });
  session.stop(1);
  for (const audio of ['', 'AA==', 'x'.repeat(30000)]) session.accept({ generation: 2, seq: 1, audio });
  expect(stream.accept).not.toHaveBeenCalled();
  expect(session.requested).toBe(true);
  session.stop(2);
  expect(stream.close).toHaveBeenCalledTimes(1);
});
