// 「语音开始」识别引擎：用 fixture wav 验证中英两个固定口令都能触发、普通语句与静音不触发。
// 真机（Node WASM）跑的是同一份模型与参数，因此这里直接加载 backend/voice-kws。
const fs = require('fs');
const os = require('os');
const path = require('path');
const sherpa = require('sherpa-onnx');
const voiceTrigger = require('../voice/voiceTriggerService');

const FIXTURES = path.join(__dirname, 'fixtures', 'voice');
const CHUNK = 1600; // 100ms @16k，与真机扫描脚本一致

jest.setTimeout(120000);

function loadWav(name) {
  const { samples, sampleRate } = sherpa.readWave(path.join(FIXTURES, name));
  expect(sampleRate).toBe(voiceTrigger.SAMPLE_RATE);
  return samples;
}

/** 按固定块长喂给一路识别流，返回识别到的口令标签数组。 */
function feed(session, samples, chunk = CHUNK) {
  const hits = [];
  for (let i = 0; i < samples.length; i += chunk) {
    const hit = session.accept(samples.subarray(i, i + chunk));
    if (hit) hits.push(hit.label);
  }
  return hits;
}

describe('voice trigger service', () => {
  let session = null;

  beforeEach(() => {
    voiceTrigger.resetForTest();
  });

  afterEach(() => {
    session?.close();
    session = null;
  });

  it('loads the KWS model from the development directory', async () => {
    const dir = voiceTrigger.modelDir();
    expect(fs.existsSync(path.join(dir, 'tokens.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'keywords.txt'))).toBe(true);
    const spotter = await voiceTrigger.ensureSpotter();
    expect(spotter).toBeTruthy();
    // 复用同一实例：第二次调用不再重新加载
    await expect(voiceTrigger.ensureSpotter()).resolves.toBe(spotter);
  });

  it('prefers the packaged resources directory when it holds the model', () => {
    // 打包态模型在 <resourcesPath>/voice-kws（见 package.json 的 extraResources）
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-resources-'));
    const dir = path.join(root, 'voice-kws');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'tokens.txt'), '<blk> 0\n');
    const original = process.resourcesPath;
    try {
      process.resourcesPath = root;
      expect(voiceTrigger.modelDir()).toBe(dir);
      // 打包目录没有模型时回落到开发目录，避免误报「模型未安装」
      process.resourcesPath = path.join(root, 'missing');
      expect(voiceTrigger.modelDir()).toBe(path.join(__dirname, '..', 'voice-kws'));
    } finally {
      if (original === undefined) delete process.resourcesPath;
      else process.resourcesPath = original;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['开始游戏', 'start-game.wav'],
    ['start the game', 'start-the-game.wav'],
  ])('detects the phrase %s', async (label, file) => {
    session = await voiceTrigger.createSession();
    expect(feed(session, loadWav(file))).toContain(label);
  });

  it('detects a phrase when audio arrives in small worklet frames', async () => {
    session = await voiceTrigger.createSession();
    // 前端 AudioWorklet 每帧 128 样本（约 8ms），与 100ms 块长结果应一致
    expect(feed(session, loadWav('start-game.wav'), 128)).toContain('开始游戏');
  });

  it('ignores ordinary speech and silence', async () => {
    session = await voiceTrigger.createSession();
    expect(feed(session, loadWav('plain-speech.wav'))).toEqual([]);
    expect(feed(session, loadWav('plain-speech-2.wav'))).toEqual([]);
    expect(feed(session, loadWav('plain-speech-en.wav'))).toEqual([]);
    expect(feed(session, loadWav('plain-speech-en-2.wav'))).toEqual([]);
    expect(feed(session, loadWav('silence.wav'))).toEqual([]);
  });

  it('stops accepting audio after close and can be closed twice', async () => {
    session = await voiceTrigger.createSession();
    session.close();
    session.close();
    expect(session.accept(loadWav('start-game.wav'))).toBeNull();
  });

  it('fails loudly when the model is missing', async () => {
    const original = process.resourcesPath;
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-missing-'));
    // modelDir 找不到模型时会回落到开发目录，这里临时把它改道到空目录，
    // 保证「模型未安装」分支真的被走到。
    const devDir = path.join(__dirname, '..', 'voice-kws');
    const renamed = `${devDir}.test-moved`;
    fs.renameSync(devDir, renamed);
    try {
      process.resourcesPath = missing;
      await expect(voiceTrigger.ensureSpotter()).rejects.toThrow(/语音模型未安装/);
    } finally {
      fs.renameSync(renamed, devDir);
      if (original === undefined) delete process.resourcesPath;
      else process.resourcesPath = original;
      fs.rmSync(missing, { recursive: true, force: true });
      voiceTrigger.resetForTest();
    }
  });
});
