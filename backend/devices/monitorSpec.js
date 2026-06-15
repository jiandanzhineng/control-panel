// 设备监控展示元数据（展示层关注点，与控制协议 capabilities.js 解耦）
// 按能力 key 声明该能力对应的可监控属性字段，供前端设备监控弹窗 / AutoTest 视图渲染。
// 注意：这里的 key 是设备上报数据中的属性名（如 pressure），不是能力名（如 sphincterPressure）。

const monitorSpecByCapability = {
  sphincterPressure: [{ key: 'pressure', name: '压力', unit: 'kPa' }],
  tiptoePressure: [{ key: 'pressure1', name: '踮脚压力', unit: 'kPa' }],
  weight: [{ key: 'weight', name: '重量', unit: 'g' }],
  distance: [{ key: 'distance', name: '距离', unit: 'mm' }],
  buttonInput: [
    { key: 'button0', name: '脚踏1', unit: '状态' },
    { key: 'button1', name: '脚踏2', unit: '状态' },
  ],
};

function getMonitorSpec(capabilityKey) {
  return monitorSpecByCapability[capabilityKey] || [];
}

module.exports = { monitorSpecByCapability, getMonitorSpec };
