(function (root) {
  'use strict';
  if (!root.GameI18n || typeof root.GameI18n.register !== 'function') return;
  root.GameI18n.register({
    en: {
      "准备就绪": "Ready",
      "暂停": "Pause",
      "延迟期中({n}s)…": "Delay ({n}s)…",
      "强度逐步提升中…": "Ramping intensity…",
      "已结束": "Ended",
      "已暂停": "Paused",
      "运行中": "Running",
      "继续": "Resume"
    }
  });
})(typeof window !== 'undefined' ? window : this);
