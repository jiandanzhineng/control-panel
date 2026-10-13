// 「语音开始」识别引擎：sherpa-onnx 的 Node（WASM）版做流式关键词检测（KWS）。
//
// 懒加载：只有第一次真的有人连上 /voice-trigger 时才初始化模型（首次约 1~2 秒，
// 之后复用同一 KeywordSpotter 实例，每个连接只建一条 stream）。
// 模型目录：开发态 backend/voice-kws，打包态 resources/voice-kws（见 package.json 的
// build.extraResources）。WASM 本身来自 node_modules/sherpa-onnx。
const fs = require('fs');
const path = require('path');
const logService = require('../services/logService');
const phraseCatalog = require('./voicePhraseCatalog');

const SAMPLE_RATE = 16000;
// 参数来自真机扫描：score=2.0 提高口令本身的路径分，threshold=0.15 抗噪。
// 扫描结果见 docs/note.md（9 档语速 × 三个口令 9/9 命中，0 误触发）。
const KEYWORDS_SCORE = 2.0;
const KEYWORDS_THRESHOLD = 0.15;

let spotter = null;
let loading = null;

function modelDir() {
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, 'voice-kws')
    : '';
  if (packaged && fs.existsSync(path.join(packaged, 'tokens.txt'))) return packaged;
  return path.join(__dirname, '..', 'voice-kws');
}

function pickModel(dir, prefix) {
  const files = fs.readdirSync(dir);
  const int8 = files.find((f) => f.startsWith(prefix) && f.endsWith('.int8.onnx'));
  if (int8) return path.join(dir, int8);
  const plain = files.find((f) => f.startsWith(prefix) && f.endsWith('.onnx'));
  if (!plain) throw new Error(`语音模型缺少 ${prefix}*.onnx`);
  return path.join(dir, plain);
}

function buildConfig(dir) {
  return {
    featConfig: { samplingRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: pickModel(dir, 'encoder'),
        decoder: pickModel(dir, 'decoder'),
        joiner: pickModel(dir, 'joiner'),
      },
      tokens: path.join(dir, 'tokens.txt'),
      numThreads: 1,
      provider: 'cpu',
      modelType: '',
      modelingUnit: 'cjkchar',
      bpeVocab: '',
      debug: 0,
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: KEYWORDS_SCORE,
    keywordsThreshold: KEYWORDS_THRESHOLD,
    keywords: phraseCatalog.buildKeywordsText(),
  };
}

/** 懒加载并复用 KeywordSpotter；并发调用共享同一次初始化。 */
async function ensureSpotter() {
  if (spotter) return spotter;
  if (loading) return loading;
  loading = (async () => {
    const dir = modelDir();
    if (!fs.existsSync(path.join(dir, 'tokens.txt'))) {
      throw new Error(`语音模型未安装：${dir}`);
    }
    const sherpa = require('sherpa-onnx');
    const started = Date.now();
    const instance = sherpa.createKws(buildConfig(dir));
    spotter = instance;
    logService.info('VoiceTrigger', `KWS 模型加载完成（${Date.now() - started}ms）`);
    return instance;
  })().catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

/** 为一路音频建流（每个 WS 连接一条），只监听目录里的固定口令。 */
async function createSession() {
  const instance = await ensureSpotter();
  const stream = instance.createStream();
  let closed = false;
  return {
    /** 喂一段 16kHz 单声道 Float32 PCM，返回本次检测到的口令（没有则 null）。 */
    accept(samples) {
      if (closed) return null;
      stream.acceptWaveform(SAMPLE_RATE, samples);
      let hit = null;
      while (instance.isReady(stream)) {
        instance.decode(stream);
        const result = instance.getResult(stream);
        if (result && result.keyword) {
          instance.reset(stream);
          const phrase = phraseCatalog.findPhraseByLabel(result.keyword);
          if (phrase) hit = phrase;
        }
      }
      return hit;
    },
    close() {
      if (closed) return;
      closed = true;
      try { stream.free(); } catch (_) {}
    },
  };
}

/** 预热（可选）：后台把模型加载好，避免第一次连接等太久。 */
function warmUp() {
  ensureSpotter().catch((error) => {
    logService.warn('VoiceTrigger', `KWS 预热失败：${error?.message || error}`);
  });
}

function resetForTest() {
  spotter = null;
  loading = null;
}

module.exports = {
  SAMPLE_RATE,
  KEYWORDS_SCORE,
  KEYWORDS_THRESHOLD,
  ensureSpotter,
  createSession,
  warmUp,
  modelDir,
  resetForTest,
};
