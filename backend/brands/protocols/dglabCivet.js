/**
 * 灵猫边缘控制传感器（DG-LAB 47L124000）蓝牙协议。
 *
 * 事实来源（2026-08-26 对齐，权威）：dungeonlab-open/dglab-bluetooth-protocol →
 *   civet-edging-sensor/README.md（含「fix: 灵猫边缘控制器66指令」2026-06-08）。
 *
 * 与郊狼 3.0 / 负鼠共用同一 GATT 传输层（服务 0x180C / 写 0x150A / 通知 0x150B / 电量 0x180A/0x1500）。
 * 灵猫是「输入/传感器」设备：上位机写配置指令，设备经 0x150B 主动上报气压值（D0，每 100ms）。
 * 实时气压回传需原生桥转发 notify（当前桥仅缓存写特征 + 电量，气压显示列为后续增强，本模块只构造写指令）。
 *
 * 写指令（0x150A）：
 *   50 指示灯颜色 + D0/00(开启/停止气压上报) + 14×00（17B）
 *   66 气压读值重置 / 屏幕显示方向翻转（0x66 + 9×00 + 01/03 + 0002）
 */
const BASE = '0000xxxx-0000-1000-8000-00805f9b34fb';
function expand(short) {
  return BASE.replace('xxxx', short);
}

const CIVET_UUIDS = Object.freeze({
  serviceCmd: expand('180c'),
  WRITE: expand('150a'),
  NOTIFY: expand('150b'),
  serviceInfo: expand('180a'),
  BATTERY: expand('1500'),
});
const CIVET_NAMES = ['47L124000'];

function bytesToHex(bytes) {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

/** 50 指示灯 + 开启/停止气压上报：0x50 + 01(颜色) + D0/00 + 14×00。 */
function build50Frame({ led = 0x01, report = false } = {}) {
  return [0x50, led & 0xff, report ? 0xd0 : 0x00, ...new Array(14).fill(0)];
}

/** 66 气压读值重置 / 屏幕方向翻转：0x66 + 9×00 + 01/03(方向) + 0002(int16 气压重置)。 */
function build66Frame({ rotate = false } = {}) {
  return [0x66, ...new Array(9).fill(0), rotate ? 0x03 : 0x01, 0x00, 0x02];
}

function toGattOps(brandCommand) {
  const cmd = brandCommand?.cmd;
  switch (cmd) {
    case 'ci_setLed':
      return { write: CIVET_UUIDS.WRITE, frame: bytesToHex(build50Frame({ led: brandCommand.led, report: brandCommand.report })) };
    case 'ci_resetPressure':
      return { write: CIVET_UUIDS.WRITE, frame: bytesToHex(build66Frame({ rotate: false })) };
    case 'ci_rotateScreen':
      return { write: CIVET_UUIDS.WRITE, frame: bytesToHex(build66Frame({ rotate: true })) };
    default:
      throw new Error(`[civet] 未支持指令: ${cmd}`);
  }
}

module.exports = {
  CIVET_UUIDS,
  CIVET_NAMES,
  bytesToHex,
  build50Frame,
  build66Frame,
  toGattOps,
};
