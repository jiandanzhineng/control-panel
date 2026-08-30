const TEXTS = {
  zh: {
    showWindow: '显示主窗口',
    quit: '退出',
    closeTitle: '关闭窗口',
    closeMessage: '关闭窗口时如何处理？',
    closeDetail: '最小化到托盘后，设备连接和后台服务会继续运行。之后可在设置中更改。',
    minimizeTray: '最小化到托盘',
    quitNow: '直接退出',
    cancel: '取消',
    grantTitle: '设备控制授权',
    grantMessage: '{origin} 请求访问设备控制能力',
    grantDetail: '允许后，该网站今天内可以通过 DeviceAPI 控制当前客户端已接入的全部设备和能力。\n\n请确认你信任该网站。恶意网页可能导致设备误触发或持续输出。',
    allowToday: '允许今天访问',
    deny: '拒绝',
    updateReadyTitle: '更新已准备就绪',
    updateReadyMessage: '更新已下载，是否立即重启并安装？',
    installNow: '立即安装',
    later: '稍后',
    titleHint: '按F11全屏 ESC退出全屏',
  },
  en: {
    showWindow: 'Show main window',
    quit: 'Quit',
    closeTitle: 'Close window',
    closeMessage: 'What should happen when the window closes?',
    closeDetail: 'Minimize to tray keeps device connections and background services running. You can change this later in Settings.',
    minimizeTray: 'Minimize to tray',
    quitNow: 'Quit',
    cancel: 'Cancel',
    grantTitle: 'Device control access',
    grantMessage: '{origin} is requesting device control',
    grantDetail: 'If allowed, this site can control all devices and capabilities currently connected to this client today.\n\nOnly allow sites you trust. A malicious page may trigger devices or keep them running.',
    allowToday: 'Allow today',
    deny: 'Deny',
    updateReadyTitle: 'Update ready',
    updateReadyMessage: 'The update has been downloaded. Restart and install now?',
    installNow: 'Install now',
    later: 'Later',
    titleHint: 'F11 fullscreen, Esc exit fullscreen',
  },
};

function normalizeLocalePref(value) {
  if (value === 'en' || value === 'zh' || value === 'system') return value;
  return 'system';
}

function resolveAppLocale(pref, systemLanguage) {
  if (pref === 'en' || pref === 'zh') return pref;
  return String(systemLanguage || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function localeTag(locale) {
  return locale === 'en' ? 'en-US' : 'zh-CN';
}

function getElectronText(locale) {
  return TEXTS[locale] || TEXTS.zh;
}

function formatElectronText(locale, key, vars = {}) {
  const table = getElectronText(locale);
  let text = table[key] || TEXTS.zh[key] || key;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

module.exports = {
  normalizeLocalePref,
  resolveAppLocale,
  localeTag,
  getElectronText,
  formatElectronText,
};
