(function (root) {
  'use strict';
  if (!root.GameI18n || typeof root.GameI18n.register !== 'function') return;
  root.GameI18n.register({
    en: {
      "暂停": "Pause",
      "放松阶段": "Rest",
      "提肛阶段": "Squeeze",
      "当前阶段：": "Stage: ",
      "提肛阶段…": "Squeeze…",
      "放松阶段…": "Rest…",
      "已结束": "Ended",
      "已暂停": "Paused",
      "继续": "Resume"
    }
  });
})(typeof window !== 'undefined' ? window : this);
