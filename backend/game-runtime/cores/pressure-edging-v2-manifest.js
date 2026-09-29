const GAME_ID = 'pressure-edging-v2';
const VERSION = '2.2.0';
const TITLE = '气压寸止3阶段升级版';

const DEVICES = [
  { id: 'sensor', label: '气压传感器', capabilities: ['sphincterPressure', 'reporting'], required: true },
  { id: 'motor', label: 'TD01刺激器', capabilities: ['strength'], required: true },
  { id: 'punish', label: '电击惩罚设备', capabilities: ['shock'], required: false },
  { id: 'lock', label: '自动锁', capabilities: ['lock'], required: false },
];

const PARAMS = [
  { key: 'duration', type: 'number', default: 20, label: '游戏时长', unit: '分钟', group: 'core', min: 1, max: 180, step: 1 },
  { key: 'endCalmLock', type: 'number', default: 60, label: '结束前起飞期', unit: '秒', group: 'core', min: 0, max: 600, step: 5 },
  { key: 'criticalPressure', type: 'number', default: 20, label: '临界气压', unit: 'kPa', group: 'core', min: 1, max: 100, step: 0.1 },
  { key: 'midPressure', type: 'number', default: 19.2, label: '中间兴奋压力', unit: 'kPa', group: 'core', min: 1, max: 100, step: 0.1 },
  { key: 'maxMotorIntensity', type: 'number', default: 255, label: 'TD01最大强度', group: 'core', min: 1, max: 255, step: 1, device: 'motor' },
  { key: 'lowPressureDelay', type: 'number', default: 5, label: '低压延迟', unit: '秒', group: 'difficulty', min: 0, max: 60, step: 1 },
  { key: 'rampRate', type: 'number', default: 2, label: '强度递增上限', unit: '每秒', group: 'difficulty', min: 0.1, max: 50, step: 0.1, required: false },
  { key: 'sensitivity', type: 'number', default: 15, label: '压力敏感度', group: 'difficulty', min: 0.1, max: 100, step: 0.1 },
  { key: 'randomPercent', type: 'number', default: 0, label: '强度随机扰动', unit: '%', group: 'advanced', min: 0, max: 50, step: 1, required: false },
  { key: 'gradualIncrease', type: 'number', default: 2, label: '延迟后逐步提升', unit: '每秒', group: 'difficulty', min: 0, max: 50, step: 0.5, required: false },
  { key: 'shockVoltage', type: 'number', default: 20, label: '电击强度', unit: 'V', group: 'punish', min: 1, max: 50, step: 1, device: 'punish' },
  { key: 'shockDuration', type: 'number', default: 3, label: '电击持续', unit: '秒', group: 'punish', min: 0.5, max: 10, step: 0.5, device: 'punish' },
  { key: 'voiceEnabled', type: 'boolean', default: true, label: '语音提示', group: 'core' },
];

module.exports = { GAME_ID, VERSION, TITLE, DEVICES, PARAMS };
