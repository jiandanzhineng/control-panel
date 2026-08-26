/**
 * 负鼠振动控制器（DG-LAB 47L127000）蓝牙协议。
 *
 * 事实来源（2026-08-26 对齐，权威）：dungeonlab-open/dglab-bluetooth-protocol →
 *   opossum-vibrate-controller/README.md（含「补充负鼠振动控制器 B2 指令」2026-06-11）。
 *
 * 与郊狼 3.0 共用同一 GATT 传输层（服务 0x180C / 写 0x150A / 通知 0x150B / 电量 0x180A/0x1500），
 * 差异仅在帧语义。本模块只构造帧，写特征默认官方 0x150A；真实设备的写特征由原生桥缓存，
 * 前端 dglabBridge.send(frame) 不传 write 即由桥使用缓存值（与郊狼3.0 一致）。
 *
 * 指令（写 0x150A）：
 *   50 指示灯颜色 + 停止/开启按键上报（3B）
 *   B0 通道振动波形（20B，每 100ms）：0xB0 + 7×00 + A4(0-100) + 4×00 + B4(0-100)
 *   B3 通道强度（3B）：0xB3 + A(0-200) + B(0-200)；0xFF 表示不修改该通道
 *   B2 屏幕强度显示（24B）：0xB2 + 21B 固定 + A(0-200) + B(0-200)
 * 回应（通知 0x150B）：B3 强度上报；D0 物理按键状态集（16B）。
 */
const BASE = '0000xxxx-0000-1000-8000-00805f9b34fb';
function expand(short) {
  return BASE.replace('xxxx', short);
}

const OPOSSUM_UUIDS = Object.freeze({
  serviceCmd: expand('180c'),
  WRITE: expand('150a'),
  NOTIFY: expand('150b'),
  serviceInfo: expand('180a'),
  BATTERY: expand('1500'),
});
const OPOSSUM_NAMES = ['47L127000'];
const MAX_STRENGTH = 200; // 通道强度 0~200
const MAX_WAVE = 100; // 单字节波形强度 0~100

function bytesToHex(bytes) {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}
function clampStrength(v) {
  v = Math.round(Number(v) || 0);
  if (v < 0) return 0;
  if (v > MAX_STRENGTH) return MAX_STRENGTH;
  return v;
}
function clampWave(v) {
  v = Math.round(Number(v) || 0);
  if (v < 0) return 0;
  if (v > MAX_WAVE) return MAX_WAVE;
  return v;
}

/** B3 通道强度：0xB3 + A(0-200) + B(0-200)。使用 0xFF 表示不修改对应通道。 */
function buildB3Frame({ a = 0, b = 0 } = {}) {
  const av = a === null || a === undefined || a === 0xff ? 0xff : clampStrength(a);
  const bv = b === null || b === undefined || b === 0xff ? 0xff : clampStrength(b);
  return [0xb3, av & 0xff, bv & 0xff];
}

/** B0 振动波形（20B）：0xB0 + 7×00 + A4(0-100) + 4×00 + B4(0-100)。 */
function buildB0Frame({ aWave = [0, 0, 0, 0], bWave = [0, 0, 0, 0] } = {}) {
  const a = aWave.slice(0, 4).map((v) => clampWave(v));
  while (a.length < 4) a.push(0);
  const b = bWave.slice(0, 4).map((v) => clampWave(v));
  while (b.length < 4) b.push(0);
  return [0xb0, 0, 0, 0, 0, 0, 0, 0, ...a, 0, 0, 0, 0, ...b];
}

// B2 屏幕强度显示：0xB2 + 21B 固定 + A(0-200) + B(0-200)。固定段来自官方 README。
const B2_FIXED = [0xff, 0xff, 0x00, ...new Array(16).fill(0xff), 0x08, 0x09];
function buildB2Frame({ a = 0, b = 0 } = {}) {
  return [0xb2, ...B2_FIXED, clampStrength(a) & 0xff, clampStrength(b) & 0xff];
}

/** 50 指示灯 + 停止/开启按键上报：0x50 + 01(颜色) + 00/01。 */
function build50Frame({ led = 0x01, report = false } = {}) {
  return [0x50, led & 0xff, report ? 0x01 : 0x00];
}

function toGattOps(brandCommand) {
  const cmd = brandCommand?.cmd;
  switch (cmd) {
    case 'op_setStrength':
      return { write: OPOSSUM_UUIDS.WRITE, frame: bytesToHex(buildB3Frame({ a: brandCommand.a, b: brandCommand.b })) };
    case 'op_setWaveform':
      return { write: OPOSSUM_UUIDS.WRITE, frame: bytesToHex(buildB0Frame({ aWave: brandCommand.aWave, bWave: brandCommand.bWave })) };
    case 'op_updateScreen':
      return { write: OPOSSUM_UUIDS.WRITE, frame: bytesToHex(buildB2Frame({ a: brandCommand.a, b: brandCommand.b })) };
    case 'op_setLed':
      return { write: OPOSSUM_UUIDS.WRITE, frame: bytesToHex(build50Frame({ led: brandCommand.led, report: brandCommand.report })) };
    default:
      throw new Error(`[opossum] 未支持指令: ${cmd}`);
  }
}

module.exports = {
  OPOSSUM_UUIDS,
  OPOSSUM_NAMES,
  MAX_STRENGTH,
  MAX_WAVE,
  bytesToHex,
  clampStrength,
  clampWave,
  buildB3Frame,
  buildB0Frame,
  buildB2Frame,
  build50Frame,
  toGattOps,
};
