const { cloneI18n, withPlayI18n } = require('../utils/playI18n');

describe('play i18n passthrough', () => {
  it('keeps optional i18n.en packs and ignores junk', () => {
    const play = withPlayI18n({
      id: 'demo',
      title: '中文标题',
      devices: [{ id: 'shock', label: '电击' }],
      params: [{ key: 'voltage', label: '电压' }],
    }, {
      i18n: {
        en: {
          title: 'English title',
          description: 'English desc',
          howTo: 'How to play',
          devices: { shock: 'Shock' },
          params: { voltage: 'Voltage' },
        },
        xx: 'nope',
      },
    });
    expect(play.title).toBe('中文标题');
    expect(play.i18n.en).toMatchObject({
      title: 'English title',
      devices: { shock: 'Shock' },
      params: { voltage: 'Voltage' },
    });
    expect(play.i18n.xx).toBeUndefined();
    expect(cloneI18n({})).toBeUndefined();
  });
});
