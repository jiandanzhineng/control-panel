/**
 * 爪印无线按钮传感器（DG-LAB 47L120300 / V1.0 47L120100）蓝牙协议。
 *
 * 事实来源（2026-08-26 对齐，权威）：dungeonlab-open/dglab-bluetooth-protocol →
 *   paw-prints/README.md（「爪印无线按钮传感器 1.1 蓝牙协议」2026-06-11）。
 *
 * 与郊狼 3.0 / 负鼠 / 灵猫共用同一 GATT 传输层（服务 0x180C / 写 0x150A / 通知 0x150B）。
 * 注意：爪印文档未列电量特征（0x1500），故电量可能不可用。
 * 爪印是「输入/传感器」设备：上位机写配置/灯光指令，设备经 0x150B 主动上报按钮、加速度、角度、电压（D0，每 100ms）。
 * 实时传感器回传需原生桥转发 notify（列为后续增强，本模块只构造写指令）。
 *
 * 写指令（0x150A）：
 *   50 指示灯颜色 + 15B 触发模式设置（17B）
 *   5F 重置参数
 *   60 启动 XYZ 角度自动检测
 *   70 肩灯控制（点亮 / 闪烁）
 */
const BASE = '0000xxxx-0000-1000-8000-00805f9b34fb';
function expand(short) {
  return BASE.replace('xxxx', short);
}

const PAW_UUIDS = Object.freeze({
  serviceCmd: expand('180c'),
  WRITE: expand('150a'),
  NOTIFY: expand('150b'),
});
const PAW_NAMES = ['47L120300', '47L120100'];

function bytesToHex(bytes) {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

/** 50 指示灯 + 触发模式设置：0x50 + 颜色 + 触发模式(1B) + 14B 触发设置。 */
function build50Frame({ led = 0x01, trigger = 0x00, config = [] } = {}) {
  const cfg = (config || []).slice(0, 14).map((v) => v & 0xff);
  while (cfg.length < 14) cfg.push(0);
  return [0x50, led & 0xff, trigger & 0xff, ...cfg];
}

/** 5F 重置参数。 */
function build5FFrame() {
  return [0x5f];
}

/** 60 启动 XYZ 角度自动检测。 */
function build60Frame() {
  return [0x60];
}

/** 70 肩灯：点亮 = 0x70 + 颜色；闪烁 = 0x70 + 颜色1 + 颜色2 + 速度(01慢/02快/03停)。 */
function build70Frame({ color = 0x01, blink = false, color2 = 0x02, speed = 0x01 } = {}) {
  return blink
    ? [0x70, color & 0xff, color2 & 0xff, speed & 0xff]
    : [0x70, color & 0xff];
}

function toGattOps(brandCommand) {
  const cmd = brandCommand?.cmd;
  switch (cmd) {
    case 'pw_setLed':
      return { write: PAW_UUIDS.WRITE, frame: bytesToHex(build50Frame({ led: brandCommand.led, trigger: brandCommand.trigger, config: brandCommand.config })) };
    case 'pw_reset':
      return { write: PAW_UUIDS.WRITE, frame: bytesToHex(build5FFrame()) };
    case 'pw_detectAngle':
      return { write: PAW_UUIDS.WRITE, frame: bytesToHex(build60Frame()) };
    case 'pw_shoulderLight':
      return { write: PAW_UUIDS.WRITE, frame: bytesToHex(build70Frame({ color: brandCommand.color, blink: brandCommand.blink, color2: brandCommand.color2, speed: brandCommand.speed })) };
    default:
      throw new Error(`[paw] 未支持指令: ${cmd}`);
  }
}

module.exports = {
  PAW_UUIDS,
  PAW_NAMES,
  bytesToHex,
  build50Frame,
  build5FFrame,
  build60Frame,
  build70Frame,
  toGattOps,
};
