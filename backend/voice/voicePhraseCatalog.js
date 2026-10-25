// 「语音开始」固定口令目录：前后端共用同一份定义。
// 后端是唯一事实来源，前端经 GET /api/voice/phrases 取（不做自定义输入）。
//
// tokens 为 sherpa-onnx KWS 模型的建模单元，由官方 CLI 离线生成后固化：
//   中文用 ppinyin，英文用 phone（CMU 音素），两者可混在同一次 text2token 里：
//   from sherpa_onnx import text2token
//   text2token(['开始游戏'], tokens='backend/voice-kws/tokens.txt', tokens_type='ppinyin')
//   text2token(['START THE GAME'], tokens='backend/voice-kws/tokens.txt',
//              tokens_type='phone+ppinyin', lexicon='<model>/en.phone')
// 详见 docs/note.md。模型：sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20（中英双语）。
//
// 选型说明：中英候选各在 -4..+4 九档语速下扫描，中文「开始游戏」与英文
// 「start the game」全部命中、0 误触发；「game start」在 21 条负样本上全部误触发，故弃用。
//
// 用户不需要选口令：模型一次装全部口令，命中哪条就回哪条（一条 vs 两条的召回/误触发
// 实测完全一致，耗时也无差异，见 docs/note.md）。这里的 default 只用于接口回显。
//
// keyword 是模型返回的原文（@ 后面的部分）。模型要求关键词里不能有空格
// （官方文档：replace spaces with underscores），所以英文口令的 keyword 用下划线，
// label 仍是给人看的英文原文。

const VOICE_START_PHRASES = [
  { id: 'start_game', label: '开始游戏', keyword: '开始游戏', tokens: 'k āi sh ǐ y óu x ì' },
  { id: 'start_the_game', label: 'start the game', keyword: 'START_THE_GAME', tokens: 'S T AA1 R T DH AH0 G EY1 M' },
];

const DEFAULT_VOICE_PHRASE_ID = 'start_game';

function getPhrase(id) {
  const key = String(id || '');
  return VOICE_START_PHRASES.find((item) => item.id === key) || null;
}

function getDefaultPhrase() {
  return getPhrase(DEFAULT_VOICE_PHRASE_ID) || VOICE_START_PHRASES[0];
}

/** 给前端的口令列表（不含 tokens/keyword，避免前端耦合建模单元）。 */
function listPhrasesForApi() {
  return VOICE_START_PHRASES.map((item) => ({
    id: item.id,
    label: item.label,
    default: item.id === DEFAULT_VOICE_PHRASE_ID,
  }));
}

/** 供 KWS 使用的 keywords 文本：`<tokens> @<keyword>`，每行一条。 */
function buildKeywordsText() {
  return VOICE_START_PHRASES.map((item) => `${item.tokens} @${item.keyword}`).join('\n') + '\n';
}

/** 模型返回的 keyword 是 @ 后面的原文，据此反查口令。 */
function findPhraseByLabel(label) {
  const key = String(label || '').trim();
  return VOICE_START_PHRASES.find((item) => item.keyword === key || item.label === key) || null;
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
