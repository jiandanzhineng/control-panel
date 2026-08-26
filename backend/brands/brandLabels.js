// 设备品牌 / 类型的中文脱敏显示名。
// 仅用于日志、接口响应与前端展示，不暴露真实商业品牌名（如 DG-LAB / 役次元·YOKONEX 等）。
// 注意：内部路由码（dglab / ycy / DGLAB / YCY_*）保持不变，前端依赖它们做类型路由。
const BRAND_LABEL = {
  dglab: '蓝牙体感设备',
  ycy: '遥控蓝牙设备',
};

const TYPE_LABEL = {
  DGLAB: '蓝牙体感设备',
  DGLAB_V2: '蓝牙体感设备（直连版）',
  DGLAB_V3: '蓝牙体感设备 3.0',
  YCY_EMS: '电击型设备',
  YCY_TOY: '电机型设备',
  YCY_CUP: '杯型设备',
  YCY_ENEMA: '灌肠型设备',
};

function brandLabel(brand) {
  if (brand && BRAND_LABEL[brand]) return BRAND_LABEL[brand];
  return typeof brand === 'string' && brand ? brand : '未知设备';
}

function typeLabel(type) {
  if (type && TYPE_LABEL[type]) return TYPE_LABEL[type];
  return typeof type === 'string' && type ? type : '未知类型';
}

module.exports = { BRAND_LABEL, TYPE_LABEL, brandLabel, typeLabel };
