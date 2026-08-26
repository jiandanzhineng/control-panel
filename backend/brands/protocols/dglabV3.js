/**
 * DG-LAB 郊狼 3.0（Coyote 3.0）蓝牙直连协议骨架。
 *
 * ⚠️ 状态：仅完成「GATT 拓扑」部分（来自真机枚举），**控制帧格式尚未实现**。
 * 仓库此前只有郊狼 2.0（dglabV2.js，955A 体系）协议；3.0 的 GATT 服务/特征
 * 与 2.0 完全不同（见下），2.0 的 packStrength/packWaveform 帧布局不能直接套用。
 *
 * 真机枚举到的 GATT（设备 47L121000 / rssi 强信号）：
 *   服务 00002003-…（数据通道）   → 特征 00000007、00000008
 *   服务 00002004-…（控制通道）   → 特征 00000009   ← 写指令目标
 *   服务 0000fe59-…（自定义）     → 特征 8ec90003-…
 *   服务 0000180a（Device Information）
 *   服务 0000180c（Battery）
 *
 * 完整 UUID 采用 Bluetooth Base UUID：0000xxxx-0000-1000-8000-00805f9b34fb
 *
 * TODO（需设备协议规格，无法凭空构造）：
 *   - 确认 00000009（控制通道）的写帧字节布局（强度/波形如何编码、是否加密/校验）。
 *   - 确认 00002003 数据通道（00000007/00000008）的读帧解析方式。
 *   - 实现 toGattOps(brandCommand) → [{ characteristic, value }]，供前端 dglabBridge.send 调用。
 * 提供规格后，把帧打包逻辑填进 buildFrame / toGattOps 即可，桥与前端收发链路已打通。
 */

const BASE = '0000xxxx-0000-1000-8000-00805f9b34fb';
function expand(short) {
  return BASE.replace('xxxx', short);
}

// 郊狼 3.0 真机枚举到的服务 / 特征（16-bit 短 UUID → 完整 UUID）
const V3_UUIDS = Object.freeze({
  serviceData: expand('2003'), // 数据通道
  serviceControl: expand('2004'), // 控制通道
  serviceCustom: expand('fe59'), // 自定义
  dataChar07: expand('0007'),
  dataChar08: expand('0008'),
  controlChar09: expand('0009'), // ← 写指令目标
  customChar: expand('8ec90003'),
  battery: '0000180c-0000-1000-8000-00805f9b34fb',
  deviceInfo: '0000180a-0000-1000-8000-00805f9b34fb',
});

// 原版 V3 设备广播名关键字（Web Bluetooth / 桥发现阶段过滤）
const DGLAB_V3_NAMES = ['47L', 'D-LAB', 'DG-LAB', 'COYOTE', 'YSKJ'];

// 控制写特征（3.0 默认写目标）
const V3_CONTROL_WRITE = V3_UUIDS.controlChar09;

/**
 * 占位：3.0 控制帧构造。待补足设备协议后实现。
 * @param {object} brandCommand 高层/专用命令（同 dglabV2 的 v2_setStrength / v2_setWaveform / v2_stop 等）
 * @returns {Array<{characteristic:string, value:number[]}>}
 */
function toGattOps(brandCommand) {
  throw new Error(
    `[dglabV3] 郊狼 3.0 控制协议尚未实现（仓库暂无 3.0 帧格式规格）。` +
      `设备已能经 Rust 桥连接并枚举 GATT，待提供 3.0 协议规格后补齐帧构造。命令: ${brandCommand?.cmd}`
  );
}

module.exports = {
  V3_UUIDS,
  V3_CONTROL_WRITE,
  DGLAB_V3_NAMES,
  toGattOps,
};
