const { formatElectronText, normalizeLocalePref, resolveAppLocale, localeTag } = require('../../electron/locale');

describe('electron locale', () => {
  it('normalizes unknown prefs to system and follows system language', () => {
    expect(normalizeLocalePref('en')).toBe('en');
    expect(normalizeLocalePref('ja')).toBe('system');
    expect(resolveAppLocale('system', 'zh-CN')).toBe('zh');
    expect(resolveAppLocale('system', 'en-US')).toBe('en');
    expect(localeTag('en')).toBe('en-US');
  });

  it('formats tray and dialog copy', () => {
    expect(formatElectronText('en', 'showWindow')).toBe('Show main window');
    expect(formatElectronText('en', 'titleHint')).toBe('F11 fullscreen, Esc exit fullscreen');
    expect(formatElectronText('zh', 'grantMessage', { origin: 'https://game.undersilicon.cn' }))
      .toContain('https://game.undersilicon.cn');
  });
});
