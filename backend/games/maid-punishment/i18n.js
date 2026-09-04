(function (root) {
  'use strict';
  if (!root.GameI18n || typeof root.GameI18n.register !== 'function') return;
  root.GameI18n.register({
    en: {
      "暂停": "Pause",
      "已解锁": "Unlocked",
      "已加锁": "Locked",
      "电击中({v}V)": "Shocking ({v}V)",
      "运行中": "Running",
      "等待手动开启": "Waiting for manual start",
      "已结束": "Ended",
      "已暂停": "Paused",
      "继续": "Resume"
    }
  });
})(typeof window !== 'undefined' ? window : this);
