const VERSION = '1.4.1';
const TITLE = '气压突变寸止';
const GAME_ID = 'surge-edging';

const DEVICES = [
  { id: 'sensor', label: '气压传感器', capabilities: ['sphincterPressure', 'reporting'], required: true },
  { id: 'motor', label: 'TD01刺激器', capabilities: ['strength'], required: true },
  { id: 'punish', label: '电击惩罚设备', capabilities: ['shock'], required: false },
  { id: 'lock', label: '自动锁', capabilities: ['lock'], required: false },
];

// 与 play-registry/games/surge-edging/index.html 内联 manifest 保持一致
const PARAMS = [
  { key: 'duration', type: 'number', default: 20, label: '游戏时长', unit: '分钟', group: 'core', min: 1, max: 180, step: 1 },
  { key: 'endCalmLock', type: 'number', default: 60, label: '结束前起飞期', unit: '秒', group: 'core', min: 0, max: 600, step: 5 },
  { key: 'surgeWindowSec', type: 'number', default: 1.5, label: '突变检测窗口', unit: '秒', group: 'advanced', min: 0.5, max: 5, step: 0.5, required: false },
  { key: 'surgeRiseKpa', type: 'number', default: 1, label: '突变抬升阈值', unit: 'kPa', group: 'core', min: 0.2, max: 5, step: 0.1 },
  { key: 'midOffsetKpa', type: 'number', default: 0.8, label: '中间压偏移', unit: 'kPa', group: 'core', min: 0.1, max: 3, step: 0.1 },
  { key: 'maxMotorIntensity', type: 'number', default: 50, label: 'TD01最大强度', group: 'difficulty', min: 1, max: 255, step: 1, device: 'motor' },
  { key: 'lowPressureDelay', type: 'number', default: 10, label: '冷却延迟', unit: '秒', group: 'difficulty', min: 0, max: 60, step: 1 },
  { key: 'maxEdgeSec', type: 'number', default: 10, label: '边缘期最长时长', unit: '秒', group: 'advanced', min: 1, max: 60, step: 1, required: false },
  { key: 'gradualIncrease', type: 'number', default: 2, label: '平静期缓升', unit: '每秒', group: 'difficulty', min: 0.1, max: 50, step: 0.5 },
  { key: 'randomPercent', type: 'number', default: 0, label: '强度随机扰动', unit: '%', group: 'advanced', min: 0, max: 50, step: 1, required: false },
  { key: 'minSurgeMs', type: 'number', default: 100, label: '突变最短持续', unit: '毫秒', group: 'advanced', min: 50, max: 1500, step: 10, required: false },
  { key: 'sendIntervalMs', type: 'number', default: 1000, label: '强度下发间隔', unit: '毫秒', group: 'advanced', min: 200, max: 5000, step: 50, required: false },
  { key: 'midDelay', type: 'number', default: 5, label: '中期防回落时长', unit: '秒', group: 'advanced', min: 0, max: 20, step: 1, required: false },
  { key: 'midIntensityMin', type: 'number', default: 5, label: '中期强度下限', group: 'difficulty', min: 0, max: 10, step: 1 },
  { key: 'midIntensityMax', type: 'number', default: 20, label: '中期强度上限', group: 'difficulty', min: 10, max: 100, step: 1 },
  { key: 'shockVoltage', type: 'number', default: 20, label: '电击强度', unit: 'V', group: 'punish', min: 1, max: 50, step: 1, device: 'punish' },
  { key: 'shockDuration', type: 'number', default: 3, label: '电击持续', unit: '秒', group: 'punish', min: 0.5, max: 10, step: 0.5, device: 'punish' },
  { key: 'voiceEnabled', type: 'boolean', default: true, label: '语音提示', group: 'core' },
];

module.exports = { VERSION, TITLE, GAME_ID, DEVICES, PARAMS };
