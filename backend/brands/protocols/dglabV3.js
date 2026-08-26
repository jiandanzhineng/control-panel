/**
 * DG-LAB 郊狼 3.0（Coyote 3.0 / 脉冲主机 3.0，广播名如 47L121000）蓝牙直连协议。
 *
 * 事实来源（2026-08-26 对齐，权威）：
 *   1) DG-LAB 官方开源仓库 dungeonlab-open/dglab-bluetooth-protocol → coyote/v3/README.md
 *      （明确写明「脉冲主机 3.0 : 47L121000」，即本仓库真机 47L121000）。
 *   2) buttplug 的 Rust 实现 dg_lab_v3.rs（同语言，已实机验证，帧结构一致）。
 *
 * ⚠️ UUID 说明：官方文档定义的写/通知特征位于 Battery 服务(0x180C) 下：
 *      WRITE  = 0x180C / 0x150A（所有指令，最长 20 字节）
 *      NOTIFY = 0x180C / 0x150B（所有回应）
 *      BATTERY= 0x180A / 0x1500（电量，1 字节）
 *   早期真机枚举曾出现 2003/2004/fe59 体系，与官方文档不一致；以官方文档为准。
 *   桥侧 /api/send 支持通过 `write` 参数覆盖写特征 UUID，故此处默认官方 UUID，
 *   若真机确用其他特征，前端传 writeUuid 覆盖即可，无需改协议。
 *
 * 控制帧（见 toGattOps）：B0 帧（20 字节，每 100ms 重发）+ 可选 BF 软上限帧（7 字节）。
 * 与 V2 不同：数据无需大小端转换；两通道强度 + 两通道波形全部捏合在 B0 一条指令中。
 */

const BASE = '0000xxxx-0000-1000-8000-00805f9b34fb'
function expand(short) {
  return BASE.replace('xxxx', short)
}

// ============ 郊狼 3.0 GATT UUID（官方 coyote/v3）============
const V3_UUIDS = Object.freeze({
  // 指令/回应所在服务（文档标记为 Battery 服务 0x180C）
  serviceCmd: expand('180c'),
  WRITE: expand('150a'), // 写指令特征（所有命令入口）
  NOTIFY: expand('150b'), // 通知特征（B1 强度回传等）
  // 电量（Device Information 服务 0x180A 下）
  serviceInfo: expand('180a'),
  BATTERY: expand('1500'),
  // 兼容性保留：早期真机枚举到的 2003/2004/fe59 体系（若真机确用，可经 writeUuid 覆盖）
  legacy: {
    serviceData: expand('2003'),
    serviceControl: expand('2004'),
    serviceCustom: expand('fe59'),
    controlChar09: expand('0009'),
  },
})

// 原版 V3 设备广播名关键字（Web Bluetooth / 桥发现阶段过滤）
const DGLAB_V3_NAMES = ['47L', 'D-LAB', 'DG-LAB', 'COYOTE', 'YSKJ']

// 控制写特征（3.0 默认写目标，官方 0x150A）
const V3_CONTROL_WRITE = V3_UUIDS.WRITE
const V3_NOTIFY = V3_UUIDS.NOTIFY

// ============ 取值范围 ============
const MAX_POWER = 200 // 通道强度 0~200
const MAX_WAVE = 100 // 波形强度 0~100
const FREQ_MIN = 10
const FREQ_MAX = 240 // 波形频率实际输入值 10~240
const FREQ_INPUT_MAX = 1000 // 上层可给 10~1000Hz，经 inputToFrequency 压缩

/**
 * 波形频率输入值(10~1000Hz) → 实际发送值(10~240)。
 * 映射（官方）：10..100→原值；101..600→(v-100)/5+100；601..1000→(v-600)/10+200；否则 10。
 */
function inputToFrequency(value) {
  const v = Math.round(Number(value))
  if (v >= 10 && v <= 100) return v
  if (v >= 101 && v <= 600) return Math.round((v - 100) / 5 + 100)
  if (v >= 601 && v <= 1000) return Math.round((v - 600) / 10 + 200)
  return FREQ_MIN
}

function clampPower(v) {
  v = Math.round(Number(v) || 0)
  return v > 0 && v <= MAX_POWER ? v : 0
}
function clampWave(v) {
  v = Math.round(Number(v) || 0)
  if (v < 0) return 0
  if (v > 255) return 255
  return v
}

/**
 * 构造 B0 控制帧（20 字节）。
 * @param {object} o
 *   serial    序列号 0~15（0=不请求设备回传强度）
 *   methodA   强度解读方式 A: 0=不变,1=相对增,2=相对减,3=绝对设
 *   methodB   强度解读方式 B: 同上
 *   powerA    A 通道强度设定值 0~200
 *   powerB    B 通道强度设定值 0~200
 *   freqA[4]  A 通道波形频率 4 组（10~240）
 *   waveA[4]  A 通道波形强度 4 组（0~100）
 *   freqB[4]  B 通道波形频率 4 组
 *   waveB[4]  B 通道波形强度 4 组
 * @returns {number[]} 20 字节
 */
function buildB0Frame({
  serial = 0,
  methodA = 3,
  methodB = 3,
  powerA = 0,
  powerB = 0,
  freqA = [100, 100, 100, 100],
  waveA = [50, 50, 50, 50],
  freqB = [100, 100, 100, 100],
  waveB = [50, 50, 50, 50],
} = {}) {
  const ser = ((serial & 0x0f) << 4) & 0xf0
  const method = (((methodA & 0x03) << 2) | (methodB & 0x03)) & 0x0f
  const ctrl = ser | method
  const bytes = [
    0xb0,
    ctrl,
    clampPower(powerA),
    clampPower(powerB),
  ]
  for (const f of freqA) bytes.push(clampFreq(f))
  for (const w of waveA) bytes.push(clampWave(w))
  for (const f of freqB) bytes.push(clampFreq(f))
  for (const w of waveB) bytes.push(clampWave(w))
  return bytes
}

// 波形频率单个值：按字节透传（0 / 10~240 / 故意越界值均原样下发，
// 越界由设备端按文档判定“放弃该通道”，不应在协议层夹断）。
function clampFreq(v) {
  v = Math.round(Number(v) || 0)
  if (v < 0) return 0
  if (v > 255) return 255
  return v
}

/**
 * 构造 BF 软上限帧（7 字节，写入断电保存，每次重连须重发）。
 * @param {object} o { limitA, limitB, freqBalA, freqBalB, waveBalA, waveBalB }
 */
function buildBFFrame({
  limitA = MAX_POWER,
  limitB = MAX_POWER,
  freqBalA = 128,
  freqBalB = 128,
  waveBalA = 128,
  waveBalB = 128,
} = {}) {
  const la = clampPower(limitA)
  const lb = clampPower(limitB)
  const fbA = clampByte(freqBalA)
  const fbB = clampByte(freqBalB)
  const wbA = clampByte(waveBalA)
  const wbB = clampByte(waveBalB)
  return [0xbf, la, lb, fbA, fbB, wbA, wbB]
}

function clampByte(v) {
  v = Math.round(Number(v) || 0)
  return v >= 0 && v <= 255 ? v : 0
}

function bytesToHex(bytes) {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('')
}

// ============ 高层命令 → GATT 操作 ============
/**
 * 将郊狼 3.0 品牌命令翻译为桥写操作。
 * @param {object} brandCommand 形如 { cmd:'v3_setStrength', a, b } 等
 * @returns {{ write:string, frame:string }} write=写特征UUID, frame=hex 字节串
 */
function toGattOps(brandCommand) {
  const cmd = brandCommand?.cmd
  switch (cmd) {
    case 'v3_setStrength': {
      const a = clampPower(brandCommand.a)
      const b = clampPower(brandCommand.b)
      const frame = buildB0Frame({ powerA: a, powerB: b })
      return { write: V3_CONTROL_WRITE, frame: bytesToHex(frame) }
    }
    case 'v3_setWaveform': {
      // channel: 'A'|'B'；x=频率(10~1000Hz 输入), y=波形强度(0~100), z 预留
      const ch = (brandCommand.channel || 'A').toUpperCase()
      const f = inputToFrequency(brandCommand.x ?? 100)
      const w = clampWave(brandCommand.y ?? 50)
      const quad = [f, f, f, f]
      const quadW = [w, w, w, w]
      const frame =
        ch === 'B'
          ? buildB0Frame({ freqB: quad, waveB: quadW })
          : buildB0Frame({ freqA: quad, waveA: quadW })
      return { write: V3_CONTROL_WRITE, frame: bytesToHex(frame) }
    }
    case 'v3_stop': {
      // 绝对设为 0，波形保留有效值（停止输出但维持配置）
      const frame = buildB0Frame({ powerA: 0, powerB: 0 })
      return { write: V3_CONTROL_WRITE, frame: bytesToHex(frame) }
    }
    case 'v3_setSoftLimit': {
      const frame = buildBFFrame(brandCommand)
      return { write: V3_CONTROL_WRITE, frame: bytesToHex(frame) }
    }
    default:
      throw new Error(`[dglabV3] 未支持的命令: ${cmd}`)
  }
}

module.exports = {
  V3_UUIDS,
  V3_CONTROL_WRITE,
  V3_NOTIFY,
  DGLAB_V3_NAMES,
  MAX_POWER,
  MAX_WAVE,
  inputToFrequency,
  buildB0Frame,
  buildBFFrame,
  toGattOps,
  bytesToHex,
}
