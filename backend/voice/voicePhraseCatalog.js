// 「语音开始」固定口令目录：前后端共用同一份定义。
// 后端是唯一事实来源，前端经 GET /api/voice/phrases 取（不做自定义输入）。
//
// tokens 为 sherpa-onnx KWS 模型的 ppinyin 建模单元，由官方 CLI 离线生成后固化：
//   python -m sherpa_onnx.cli text2token 已废弃入口，实际用 text2token API：
//   from sherpa_onnx import text2token
//   text2token(['开始游戏'], tokens='backend/voice-kws/tokens.txt', tokens_type='ppinyin')
// 详见 docs/note.md。模型：sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01-mobile。
//
// 选型说明：芝麻开门在默认语速下漏检，故换成「启动游戏」；三个口令在 9 档语速
// （-4..+4）扫描下均 9/9 命中、0 误触发。

const VOICE_START_PHRASES = [
  { id: 'start_game', label: '开始游戏', tokens: 'k āi sh ǐ y óu x ì' },
  { id: 'start_challenge', label: '开始挑战', tokens: 'k āi sh ǐ t iǎo zh àn' },
  { id: 'launch_game', label: '启动游戏', tokens: 'q ǐ d òng y óu x ì' },
];

const DEFAULT_VOICE_PHRASE_ID = 'start_game';

function getPhrase(id) {
  const key = String(id || '');
  return VOICE_START_PHRASES.find((item) => item.id === key) || null;
}

function getDefaultPhrase() {
  return getPhrase(DEFAULT_VOICE_PHRASE_ID) || VOICE_START_PHRASES[0];
}

/** 给前端的口令列表（不含 tokens，避免前端耦合建模单元）。 */
function listPhrasesForApi() {
  return VOICE_START_PHRASES.map((item) => ({
    id: item.id,
    label: item.label,
    default: item.id === DEFAULT_VOICE_PHRASE_ID,
  }));
}

/** 供 KWS 使用的 keywords 文本：`<tokens> @<label>`，每行一条。 */
function buildKeywordsText() {
  return VOICE_START_PHRASES.map((item) => `${item.tokens} @${item.label}`).join('\n') + '\n';
}

/** 模型返回的 keyword 是 @ 后面的原文，据此反查口令。 */
function findPhraseByLabel(label) {
  const key = String(label || '').trim();
  return VOICE_START_PHRASES.find((item) => item.label === key) || null;
}

module.exports = {
  VOICE_START_PHRASES,
  DEFAULT_VOICE_PHRASE_ID,
  getPhrase,
  getDefaultPhrase,
  listPhrasesForApi,
  buildKeywordsText,
  findPhraseByLabel,
};
