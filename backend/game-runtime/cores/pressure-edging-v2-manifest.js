const GAME_ID = 'pressure-edging-v2';
const VERSION = '2.2.3';
const TITLE = '气压寸止3阶段升级版';

const DEVICES = [
  { id: 'sensor', label: '气压传感器', capabilities: ['sphincterPressure', 'reporting'], required: true },
  { id: 'motor', label: 'TD01刺激器', capabilities: ['strength'], required: true },
  { id: 'punish', label: '电击惩罚设备', capabilities: ['shock'], required: false },
  { id: 'lock', label: '自动锁', capabilities: ['lock'], required: false },
];

const PARAMS = [
  { key: 'duration', type: 'number', default: 20, label: '游戏时长', unit: '分钟', description: '整局持续时长', group: 'core', min: 1, max: 180, step: 1 },
  { key: 'endCalmLock', type: 'number', default: 60, label: '结束前起飞期', unit: '秒', description: '结束前进入高强度「起飞」阶段的时长', group: 'core', min: 0, max: 600, step: 5, recommended: '30–90' },
  { key: 'criticalPressure', type: 'number', default: 20, label: '临界气压', unit: 'kPa', description: '边缘上限，超过会惩罚并回落', group: 'core', min: 1, max: 100, step: 0.1 },
  { key: 'midPressure', type: 'number', default: 19.2, label: '中间兴奋压力', unit: 'kPa', description: '进入「中期/兴奋」阶段的压力门槛，应低于临界气压', group: 'core', min: 1, max: 100, step: 0.1, recommended: '比临界低 0.5–1.0' },
  { key: 'maxMotorIntensity', type: 'number', default: 255, label: 'TD01最大强度', description: '刺激强度上限（1–255）。男用 TD 超过 50 可能断联，请谨慎', group: 'core', min: 1, max: 255, step: 1, device: 'motor' },
  { key: 'lowPressureDelay', type: 'number', default: 5, label: '低压延迟', unit: '秒', description: '压力偏低多久后才抬高强度', group: 'difficulty', min: 0, max: 60, step: 1, required: false },
  { key: 'rampRate', type: 'number', default: 2, label: '强度递增上限', unit: '每秒', description: '强度每秒最多增加多少', group: 'difficulty', min: 0.1, max: 50, step: 0.1, required: false },
  { key: 'sensitivity', type: 'number', default: 15, label: '压力敏感度', description: '压力变化对强度调节的影响系数，越大反应越灵敏', group: 'difficulty', min: 0.1, max: 100, step: 0.1, recommended: '10–20', required: false },
  { key: 'randomPercent', type: 'number', default: 0, label: '强度随机扰动', unit: '%', description: '目标强度随机波动百分比', group: 'advanced', min: 0, max: 50, step: 1, required: false },
  { key: 'gradualIncrease', type: 'number', default: 2, label: '延迟后逐步提升', unit: '每秒', description: '低压延迟后强度每秒抬升幅度', group: 'difficulty', min: 0, max: 50, step: 0.5, required: false },
  { key: 'shockVoltage', type: 'number', default: 20, label: '电击强度', unit: 'V', description: '超临界时电击电压', group: 'punish', min: 1, max: 50, step: 1, device: 'punish' },
  { key: 'shockDuration', type: 'number', default: 3, label: '电击持续', unit: '秒', description: '单次电击时间', group: 'punish', min: 0.5, max: 10, step: 0.5, device: 'punish', required: false },
  { key: 'voiceEnabled', type: 'boolean', default: true, label: '语音提示', description: '开启语音播报', group: 'core' },
];

module.exports = { GAME_ID, VERSION, TITLE, DEVICES, PARAMS };
