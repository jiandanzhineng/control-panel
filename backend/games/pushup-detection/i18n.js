(function (root) {
  'use strict';
  if (!root.GameI18n || typeof root.GameI18n.register !== 'function') return;
  root.GameI18n.register({
    en: {
      "暂停": "Pause",
      "未锁": "Unlocked",
      "空闲": "Idle",
      "待机": "Standby",
      "关闭": "Off",
      "已锁": "Locked",
      "进行中": "Active",
      "工作中": "On",
      "目标完成，训练结束": "Target reached. Training over",
      "奖励": "Reward",
      "惩罚": "Punish",
      "警告：快动起来！": "Warning: move!",
      "快动起来": "Move",
      "准备就绪": "Ready",
      "训练结束": "Training over",
      "已暂停": "Paused",
      "运行中": "Running",
      "继续": "Resume"
    }
  });
})(typeof window !== 'undefined' ? window : this);
