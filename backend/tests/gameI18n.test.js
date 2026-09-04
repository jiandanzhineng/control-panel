const fs = require('fs');
const path = require('path');
const vm = require('vm');

const gameI18nPath = path.join(__dirname, '..', 'public', 'game-i18n.js');

function loadGameI18n({ locale = 'zh', search = '', register, extraScripts = [] } = {}) {
  const context = {
    DeviceAPI: { locale },
    location: { search },
    URLSearchParams,
    document: {
      documentElement: { lang: '' },
      querySelector: () => null,
      querySelectorAll: () => [],
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(gameI18nPath, 'utf8'), context);
  extraScripts.forEach((file) => {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  });
  if (register) context.GameI18n.register(register);
  return context.GameI18n;
}

describe('GameI18n chinese keys', () => {
  it('returns the chinese key in zh', () => {
    const i18n = loadGameI18n({ locale: 'zh' });
    expect(i18n.t('运行中')).toBe('运行中');
  });

  it('looks up english by chinese key', () => {
    const i18n = loadGameI18n({
      locale: 'en',
      register: { en: { '运行中': 'Running', '延迟期中({n}s)…': 'Delay ({n}s)…' } },
    });
    expect(i18n.t('运行中')).toBe('Running');
    expect(i18n.t('延迟期中({n}s)…', { n: 3 })).toBe('Delay (3s)…');
    expect(i18n.t('没有这条')).toBe('没有这条');
  });

  it('uses legacy second-string english when the key is missing', () => {
    const i18n = loadGameI18n({ locale: 'en' });
    expect(i18n.t('运行中', 'Running')).toBe('Running');
  });

  it('loads drink-pee-unlock english catalog by chinese key', () => {
    const i18n = loadGameI18n({
      locale: 'en',
      extraScripts: [path.join(__dirname, '..', 'games', 'drink-pee-unlock', 'i18n.js')],
    });
    expect(i18n.t('喝水')).toBe('Drink');
    expect(i18n.t('运行中')).toBe('Running');
  });
});
