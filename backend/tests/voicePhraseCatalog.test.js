// 「语音开始」口令目录：前后端共用的唯一事实来源。
const catalog = require('../voice/voicePhraseCatalog');

describe('voice phrase catalog', () => {
  it('lists the fixed phrases for the API without leaking tokens', () => {
    const list = catalog.listPhrasesForApi();
    expect(list.map((item) => item.id)).toEqual(['start_game', 'start_the_game']);
    expect(list.map((item) => item.label)).toEqual(['开始游戏', 'start the game']);
    expect(list.filter((item) => item.default).map((item) => item.id)).toEqual(['start_game']);
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(['default', 'id', 'label']);
    }
  });

  it('resolves a phrase by id and falls back to the default', () => {
    expect(catalog.getPhrase('start_the_game').label).toBe('start the game');
    expect(catalog.getPhrase('nope')).toBeNull();
    expect(catalog.getPhrase('')).toBeNull();
    expect(catalog.getPhrase(undefined)).toBeNull();
    expect(catalog.getDefaultPhrase().id).toBe(catalog.DEFAULT_VOICE_PHRASE_ID);
    expect(catalog.DEFAULT_VOICE_PHRASE_ID).toBe('start_game');
  });

  it('builds the keywords text as "<tokens> @<keyword>" per line', () => {
    const text = catalog.buildKeywordsText();
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(catalog.VOICE_START_PHRASES.length);
    for (const phrase of catalog.VOICE_START_PHRASES) {
      expect(lines).toContain(`${phrase.tokens} @${phrase.keyword}`);
    }
    expect(text.endsWith('\n')).toBe(true);
  });

  it('keeps english keywords free of spaces (model rejects them)', () => {
    for (const phrase of catalog.VOICE_START_PHRASES) {
      expect(phrase.keyword).not.toMatch(/\s/);
    }
  });

  it('maps the model keyword back to a phrase', () => {
    expect(catalog.findPhraseByLabel('开始游戏').id).toBe('start_game');
    expect(catalog.findPhraseByLabel('START_THE_GAME').id).toBe('start_the_game');
    // 模型返回的是 keyword；label 也接受，方便前端回显
    expect(catalog.findPhraseByLabel(' start the game ').id).toBe('start_the_game');
    expect(catalog.findPhraseByLabel('芝麻开门')).toBeNull();
    expect(catalog.findPhraseByLabel('')).toBeNull();
  });
});
