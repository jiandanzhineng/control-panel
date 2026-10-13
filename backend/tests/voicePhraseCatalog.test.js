// 「语音开始」口令目录：前后端共用的唯一事实来源。
const catalog = require('../voice/voicePhraseCatalog');

describe('voice phrase catalog', () => {
  it('lists the fixed phrases for the API without leaking tokens', () => {
    const list = catalog.listPhrasesForApi();
    expect(list.map((item) => item.id)).toEqual(['start_game', 'start_challenge', 'launch_game']);
    expect(list.map((item) => item.label)).toEqual(['开始游戏', '开始挑战', '启动游戏']);
    expect(list.filter((item) => item.default).map((item) => item.id)).toEqual(['start_game']);
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(['default', 'id', 'label']);
    }
  });

  it('resolves a phrase by id and falls back to the default', () => {
    expect(catalog.getPhrase('start_challenge').label).toBe('开始挑战');
    expect(catalog.getPhrase('nope')).toBeNull();
    expect(catalog.getPhrase('')).toBeNull();
    expect(catalog.getPhrase(undefined)).toBeNull();
    expect(catalog.getDefaultPhrase().id).toBe(catalog.DEFAULT_VOICE_PHRASE_ID);
    expect(catalog.DEFAULT_VOICE_PHRASE_ID).toBe('start_game');
  });

  it('builds the keywords text as "<tokens> @<label>" per line', () => {
    const text = catalog.buildKeywordsText();
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(catalog.VOICE_START_PHRASES.length);
    for (const phrase of catalog.VOICE_START_PHRASES) {
      expect(lines).toContain(`${phrase.tokens} @${phrase.label}`);
    }
    expect(text.endsWith('\n')).toBe(true);
  });

  it('maps the model keyword back to a phrase', () => {
    expect(catalog.findPhraseByLabel('开始游戏').id).toBe('start_game');
    expect(catalog.findPhraseByLabel(' 启动游戏 ').id).toBe('launch_game');
    expect(catalog.findPhraseByLabel('芝麻开门')).toBeNull();
    expect(catalog.findPhraseByLabel('')).toBeNull();
  });
});
