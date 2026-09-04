(function (root) {
  'use strict';
  if (!root.GameI18n || typeof root.GameI18n.register !== 'function') return;
  root.GameI18n.register({
    en: {
      "喝水/憋尿解锁玩法": "Drink / hold-pee unlock",
      "初始化": "Init",
      "未映射": "Unmapped",
      "不可用": "Unavailable",
      "正常": "OK",
      "异常": "Fail",
      "排泄": "Hold pee",
      "喝水": "Drink",
      "已映射": "Mapped",
      "电击中": "Shocking",
      "待机": "Standby",
      "未接": "N/A",
      "落地": "Down",
      "运行中": "Running",
      "冷却中": "Cooldown",
      "惩罚：": "Punish: ",
      "已解锁：": "Unlocked: ",
      "已结束": "Ended"
    }
  });
})(typeof window !== 'undefined' ? window : this);
