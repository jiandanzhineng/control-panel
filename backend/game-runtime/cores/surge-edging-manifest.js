const VERSION = '1.4.3';
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
  { key: 'duration', type: 'number', default: 20, label: '游戏时长', unit: '分钟', description: '整局持续时长', group: 'core', min: 1, max: 180, step: 1 },
  { key: 'endCalmLock', type: 'number', default: 60, label: '结束前起飞期', unit: '秒', description: '结束前进入高强度「起飞」阶段的时长', group: 'core', min: 0, max: 600, step: 5, recommended: '30-90' },
  { key: 'surgeWindowSec', type: 'number', default: 1.5, label: '突变检测窗口', unit: '秒', description: '在多长时间内比较气压的升高幅度。窗口越长，缓慢的升高也会被当成突变，越灵敏', group: 'advanced', min: 0.5, max: 5, step: 0.5, required: false },
  { key: 'surgeRiseKpa', type: 'number', default: 1, label: '突变抬升阈值', unit: 'kPa', description: '气压在短时间内突然升高超过这个值，就判定为接近边缘并立即停止刺激。越小越灵敏', group: 'core', min: 0.2, max: 5, step: 0.1 },
  { key: 'midOffsetKpa', type: 'number', default: 0.8, label: '中间压偏移', unit: 'kPa', description: '每次边缘后，把「兴奋阶段」门槛设为这次峰值减去该值，越大越早进入兴奋阶段', group: 'advanced', min: 0.1, max: 3, step: 0.1, required: false },
  { key: 'maxMotorIntensity', type: 'number', default: 50, label: 'TD01最大强度', description: '刺激强度上限（1–255）。男用 TD 超过 50 可能断联，请谨慎', group: 'difficulty', min: 1, max: 255, step: 1, device: 'motor' },
  { key: 'lowPressureDelay', type: 'number', default: 10, label: '冷却延迟', unit: '秒', description: '每次边缘后完全停止刺激的时长', group: 'advanced', min: 0, max: 60, step: 1, required: false },
  { key: 'maxEdgeSec', type: 'number', default: 10, label: '边缘期最长时长', unit: '秒', description: '边缘期最长持续时间，超时强制进入冷却，防止意外压力波动导致锁死在边缘期', group: 'advanced', min: 1, max: 60, step: 1, required: false },
  { key: 'gradualIncrease', type: 'number', default: 2, label: '平静期缓升', unit: '每秒', description: '平静阶段强度每秒最多上升多少', group: 'advanced', min: 0.1, max: 50, step: 0.5, required: false },
  { key: 'randomPercent', type: 'number', default: 0, label: '强度随机扰动', unit: '%', description: '目标强度随机波动百分比', group: 'advanced', min: 0, max: 50, step: 1, required: false },
  { key: 'minSurgeMs', type: 'number', default: 100, label: '突变最短持续', unit: '毫秒', description: '突变需连续保持至少此时长才计数，滤除单点尖刺', group: 'advanced', min: 50, max: 1500, step: 10, required: false, hidden: true },
  { key: 'sendIntervalMs', type: 'number', default: 1000, label: '强度下发间隔', unit: '毫秒', description: '多久给 TD01 发一次强度。设备响应有延迟时可调大；边缘时的停止命令会立即发送', group: 'advanced', min: 200, max: 5000, step: 50, required: false },
  { key: 'midDelay', type: 'number', default: 5, label: '中期防回落时长', unit: '秒', description: '进入兴奋阶段后至少保持多少秒，避免语音来回切换', group: 'advanced', min: 0, max: 20, step: 1, required: false },
  { key: 'midIntensityMin', type: 'number', default: 5, label: '中期强度下限', description: '兴奋阶段压力越高强度越低，最低降到这个值', group: 'advanced', min: 0, max: 10, step: 1, required: false },
  { key: 'midIntensityMax', type: 'number', default: 20, label: '中期强度上限', description: '刚进入兴奋阶段时的强度，压力越高逐渐降到下限。须在 10 到 TD01 最大强度之间，否则自动取 20（不超过最大强度）', group: 'advanced', min: 10, max: 100, step: 1, required: false },
  { key: 'shockVoltage', type: 'number', default: 20, label: '电击强度', unit: 'V', description: '突变进入边缘期时电击电压', group: 'punish', min: 1, max: 50, step: 1, device: 'punish' },
  { key: 'shockDuration', type: 'number', default: 3, label: '电击持续', unit: '秒', description: '单次电击时间', group: 'advanced', min: 0.5, max: 10, step: 0.5, device: 'punish', required: false },
  { key: 'voiceEnabled', type: 'boolean', default: true, label: '语音提示', description: '开启语音播报', group: 'core' },
];

module.exports = { VERSION, TITLE, GAME_ID, DEVICES, PARAMS };
