(function (root) {
  'use strict';
  if (!root.GameI18n || typeof root.GameI18n.register !== 'function') return;
  root.GameI18n.register({
    en: {
      "平静期": "Calm",
      "中期刺激": "Mid",
      "边缘寸止": "Edging",
      "冷却延迟": "Delay",
      "气压寸止3阶段升级版": "Pressure edging 3-stage",
      "准备就绪": "Ready",
      "暂停": "Pause",
      "进入结束前起飞期": "Takeoff before end",
      "进入中期刺激": "Entering mid stimulation",
      "过载！边缘寸止中…": "Overload! Holding the edge…",
      "压力回落，进入平静期": "Pressure dropped, calm",
      "冷却延迟({n}s)…": "Cooldown delay ({n}s)…",
      "延迟结束，高压保持": "Delay over, holding high",
      "延迟结束，重新积累": "Delay over, rebuilding",
      "已结束": "Ended",
      "已暂停": "Paused",
      "运行中": "Running",
      "继续": "Resume"
    }
  });
})(typeof window !== 'undefined' ? window : this);
