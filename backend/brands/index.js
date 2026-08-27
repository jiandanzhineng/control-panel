/**
 * 品牌设备模块入口。
 * 统一暴露郊狼（DGLab）与役次元（YCY）设备的发现 / 连接 / 控制能力。
 * 不在此处做自动网络初始化；连接由路由按需触发，避免无设备时占用资源。
 */
const brandService = require('./brandService');

function init() {
  // 当前无需常驻服务；保留钩子以便将来接入常驻保活 / 事件总线。
  return { ok: true };
}

module.exports = {
  init,
  ...brandService,
};
