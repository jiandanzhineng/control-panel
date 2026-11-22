// 推理子进程入口：按环境变量加载引擎与模型，通过 IPC 串行接活。
// 由 workerHost 用 process.execPath + ELECTRON_RUN_AS_NODE=1 启动。
const fs = require('fs');

function send(message) {
  if (process.send) process.send(message);
}

function fatal(error) {
  send({ type: 'fatal', message: error?.message || String(error), stack: error?.stack });
  process.exit(1);
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

function readWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw Object.assign(new Error('不是 WAV'), { code: 'BAD_AUDIO' });
  let offset = 12;
  let channels = 1;
  let sampleRate = 16000;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
    }
    if (id === 'data') { data = buffer.subarray(offset + 8, offset + 8 + size); break; }
    offset += 8 + size + (size % 2);
  }
  if (!data) throw Object.assign(new Error('WAV 缺少 data'), { code: 'BAD_AUDIO' });
  const n = Math.floor(data.length / 2 / channels);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
    samples[i] = sum / channels / 32768;
  }
  return { samples, sampleRate, channels };
}

let recognizer = null;

function buildRecognizer() {
  const config = JSON.parse(process.env.MR_ENGINE_CONFIG || '{}');
  const provider = process.env.MR_PROVIDER || 'cpu';
  const numThreads = Number(process.env.MR_NUM_THREADS) || 2;
  if (config.type !== 'sense_voice') throw new Error(`未知模型类型: ${config.type}`);
  const sherpa = require('sherpa-onnx-node');
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: config.model,
        language: config.language || 'zh',
        useInverseTextNormalization: config.useInverseTextNormalization ? 1 : 0,
      },
      tokens: config.tokens,
      numThreads,
      provider,
      debug: 0,
    },
  });
}

function transcribe(id, audioBase64) {
  const started = Date.now();
  try {
    if (!recognizer) throw new Error('模型尚未加载');
    const wav = readWav(Buffer.from(String(audioBase64 || ''), 'base64'));
    if (wav.channels !== 1 || wav.sampleRate !== 16000) {
      throw Object.assign(new Error(`只支持 16kHz 单声道，收到 ${wav.sampleRate}Hz/${wav.channels}ch`), { code: 'BAD_AUDIO' });
    }
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: wav.samples, sampleRate: wav.sampleRate });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    send({ id, ok: true, text: String(result?.text || '').trim(), ms: Date.now() - started });
  } catch (error) {
    send({ id, ok: false, code: error?.code || 'LOCAL_INFERENCE_FAILED', message: error?.message || String(error), ms: Date.now() - started });
  }
}

function start() {
  try {
    recognizer = buildRecognizer();
    send({ type: 'ready', engine: 'sherpa-onnx', provider: process.env.MR_PROVIDER || 'cpu', pid: process.pid });
  } catch (error) {
    fatal(error);
  }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'transcribe') transcribe(message.id, message.audio);
});

start();
