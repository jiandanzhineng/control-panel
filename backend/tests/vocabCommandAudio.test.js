const Capture = require('../public/vocab-command-audio');

test('stopping while microphone permission is pending closes the late stream', async () => {
  let grant;
  const stop = jest.fn();
  const capture = new Capture({ navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } } });
  const started = capture.start(jest.fn(), jest.fn());
  capture.stop();
  grant({ getTracks: () => [{ stop }] });
  await expect(started).resolves.toBe(false);
  expect(stop).toHaveBeenCalledTimes(1);
});

test('stream capture sends little-endian PCM16 and releases microphone, context and worklet', async () => {
  const track = { stop: jest.fn() };
  let node;
  const context = {
    sampleRate: 16000, state: 'running', destination: {},
    audioWorklet: { addModule: jest.fn(async () => {}) },
    createMediaStreamSource: () => ({ connect: jest.fn(), disconnect: jest.fn() }),
    createGain: () => ({ gain: {}, connect: jest.fn(), disconnect: jest.fn() }),
    resume: jest.fn(async () => {}), close: jest.fn(async () => {}),
  };
  const env = {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } },
    AudioContext: function () { return context; },
    AudioWorkletNode: function () { node = { port: {}, connect: jest.fn(), disconnect: jest.fn() }; return node; },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: jest.fn() },
    Blob: class {}, btoa: data => Buffer.from(data, 'binary').toString('base64'),
  };
  const frames = [];
  const capture = new Capture(env);
  await expect(capture.start(data => frames.push(Buffer.from(data, 'base64')), jest.fn())).resolves.toBe(true);
  node.port.onmessage({ data: new Float32Array([-1, 0, 1]) });
  expect([...frames[0]]).toEqual([0, 128, 0, 0, 255, 127]);
  capture.stop();
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(context.close).toHaveBeenCalledTimes(1);
  expect(node.port.onmessage).toBeNull();
});
