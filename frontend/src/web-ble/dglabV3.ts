/**
 * 郊狼 3.0（Coyote 3.0 / 脉冲主机 3.0，广播名 47L*）蓝牙直连协议（前端帧构造）。
 *
 * 与后端 backend/brands/protocols/dglabV3.js 同源；此处为前端本地副本，
 * 供 BrandsPanel 经 Rust 桥（dglabBridge.send）下发控制帧。
 * 事实来源：DG-LAB 官方开源 dungeonlab-open/dglab-bluetooth-protocol → coyote/v3，
 * 并经 buttplug 的 dg_lab_v3.rs 交叉验证；buildB0Frame 已用官方示例帧单测通过。
 *
 * 写特征 UUID 不在此写死：桥在连接时已把真实设备的写特征缓存进 connection.write，
 * 前端 dglabBridge.send(frame) 不传 write 即由桥使用缓存值，自动兼容 0x150A / 0x0009 等差异。
 */

const BASE = '0000xxxx-0000-1000-8000-00805f9b34fb'
function expand(short: string): string {
  return BASE.replace('xxxx', short)
}

export const V3_UUIDS = {
  serviceCmd: expand('180c'),
  WRITE: expand('150a'),
  NOTIFY: expand('150b'),
  serviceInfo: expand('180a'),
  BATTERY: expand('1500'),
} as const

export const DGLAB_V3_NAMES = ['47L', 'D-LAB', 'DG-LAB', 'COYOTE', 'YSKJ']

const MAX_POWER = 200
const MAX_WAVE = 100
const FREQ_MIN = 10
const FREQ_MAX = 240

/** 波形频率输入值(10~1000Hz) → 实际发送值(10~240)，与官方映射一致 */
export function inputToFrequency(value: number): number {
  const v = Math.round(Number(value))
  if (v >= 10 && v <= 100) return v
  if (v >= 101 && v <= 600) return Math.round((v - 100) / 5 + 100)
  if (v >= 601 && v <= 1000) return Math.round((v - 600) / 10 + 200)
  return FREQ_MIN
}

function clampPower(v: number): number {
  v = Math.round(Number(v) || 0)
  return v > 0 && v <= MAX_POWER ? v : 0
}
function clampWave(v: number): number {
  v = Math.round(Number(v) || 0)
  if (v < 0) return 0
  if (v > 255) return 255
  return v
}
function clampFreq(v: number): number {
  v = Math.round(Number(v) || 0)
  if (v < 0) return 0
  if (v > 255) return 255
  return v
}

export interface B0Options {
  serial?: number
  methodA?: number
  methodB?: number
  powerA?: number
  powerB?: number
  freqA?: number[]
  waveA?: number[]
  freqB?: number[]
  waveB?: number[]
}

/** 构造 B0 控制帧（20 字节） */
export function buildB0Frame(o: B0Options = {}): number[] {
  const serial = ((o.serial ?? 0) & 0x0f) << 4
  const methodA = (o.methodA ?? 3) & 0x03
  const methodB = (o.methodB ?? 3) & 0x03
  const ctrl = (serial | ((methodA << 2) | methodB)) & 0xff
  const bytes = [0xb0, ctrl, clampPower(o.powerA ?? 0), clampPower(o.powerB ?? 0)]
  for (const f of o.freqA ?? [100, 100, 100, 100]) bytes.push(clampFreq(f))
  for (const w of o.waveA ?? [50, 50, 50, 50]) bytes.push(clampWave(w))
  for (const f of o.freqB ?? [100, 100, 100, 100]) bytes.push(clampFreq(f))
  for (const w of o.waveB ?? [50, 50, 50, 50]) bytes.push(clampWave(w))
  return bytes
}

export function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('')
}

export type V3Command =
  | { cmd: 'v3_setStrength'; a: number; b: number }
  | { cmd: 'v3_setWaveform'; channel?: 'A' | 'B'; x?: number; y?: number }
  | { cmd: 'v3_stop' }
  | { cmd: 'v3_setSoftLimit'; limitA?: number; limitB?: number }

/** 将郊狼 3.0 高层命令翻译为 { write, frame }（write 默认官方 UUID，可被桥缓存值覆盖） */
export function toGattOps(command: V3Command): { write: string; frame: string } {
  switch (command.cmd) {
    case 'v3_setStrength': {
      const frame = buildB0Frame({ powerA: clampPower(command.a), powerB: clampPower(command.b) })
      return { write: V3_UUIDS.WRITE, frame: bytesToHex(frame) }
    }
    case 'v3_setWaveform': {
      const ch = (command.channel || 'A').toUpperCase()
      const f = inputToFrequency(command.x ?? 100)
      const w = clampWave(command.y ?? 50)
      const quad = [f, f, f, f]
      const quadW = [w, w, w, w]
      const frame = ch === 'B' ? buildB0Frame({ freqB: quad, waveB: quadW }) : buildB0Frame({ freqA: quad, waveA: quadW })
      return { write: V3_UUIDS.WRITE, frame: bytesToHex(frame) }
    }
    case 'v3_stop': {
      const frame = buildB0Frame({ powerA: 0, powerB: 0 })
      return { write: V3_UUIDS.WRITE, frame: bytesToHex(frame) }
    }
    case 'v3_setSoftLimit': {
      const la = clampPower(command.limitA ?? MAX_POWER)
      const lb = clampPower(command.limitB ?? MAX_POWER)
      const frame = [0xbf, la, lb, 128, 128, 128, 128]
      return { write: V3_UUIDS.WRITE, frame: bytesToHex(frame) }
    }
    default:
      throw new Error('[dglabV3] 未支持的命令')
  }
}
