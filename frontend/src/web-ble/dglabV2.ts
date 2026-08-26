// 郊狼 2.0（DG-LAB V2 / Coyote2）前端帧构造（与后端 backend/brands/protocols/dglabV2.js 同源、已对齐）。
// 用于「本机桥接（Rust dglab_bridge）」与「网页蓝牙直连（brandBle）」两条通道下发强度 / 波形帧。
// 注意：V2 有 3 个独立写特征（pwmAB2 / pwmA34 / pwmB34），本机桥仅缓存单一写特征，
// 故原生桥下发时需显式传各指令对应的写特征 UUID（见 V2_UUIDS）。

const BASE_UUID = '955axxxx-0fe2-f5aa-a094-84b8d4f3e8ad'
function expand(short: string): string {
  return BASE_UUID.replace('xxxx', short)
}

export const V2_UUIDS = Object.freeze({
  service: expand('180b'),
  battery: expand('1500'),
  pwmAB2: expand('1504'),
  pwmA34: expand('1505'),
  pwmB34: expand('1506'),
})

export const DGLAB_V2_NAMES = ['D-LAB', 'DG-LAB', 'COYOTE', 'YSKJ', 'ESTIM']

const STRENGTH_HW_MAX = 2047
const WAVE_X_MAX = 31
const WAVE_Y_MAX = 1023

function clampInt(v: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(min, Math.min(max, Math.round(n)))
}
function toLittleEndian24(value: number): number[] {
  const v = value & 0xffffff
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff]
}
function toHex(bytes: number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('')
}

// 强度位布局：默认 coyote2（与后端一致，A = data>>13，B = (data>>2)&0x3FF）
export function packStrength(a = 0, b = 0): string {
  const va = clampInt(a, 0, STRENGTH_HW_MAX)
  const vb = clampInt(b, 0, STRENGTH_HW_MAX)
  const data = ((va & 0x7ff) << 13) | ((vb & 0x7ff) << 2)
  return toHex(toLittleEndian24(data))
}

// 波形（X5 / Y10 / Z5），频率 = X + Y
export function packWaveform(channel: 'A' | 'B', x = 5, y = 200, z = 0): string {
  const vx = clampInt(x, 0, WAVE_X_MAX)
  const vy = clampInt(y, 0, WAVE_Y_MAX)
  const vz = clampInt(z, 0, WAVE_X_MAX)
  const data = ((vz & 0x1f) << 15) | ((vy & 0x3ff) << 5) | (vx & 0x1f)
  const hex = toHex(toLittleEndian24(data))
  const characteristic = channel === 'B' ? V2_UUIDS.pwmB34 : V2_UUIDS.pwmA34
  return characteristic + ':' + hex
}

/** 返回 { characteristic, hex } 列表，供原生桥显式指定写特征下发。 */
export function toGattOpsHex(cmd: string, opts: Record<string, number> = {}): { characteristic: string; hex: string }[] {
  switch (cmd) {
    case 'v2_setStrength':
      return [{ characteristic: V2_UUIDS.pwmAB2, hex: packStrength(opts.a, opts.b) }]
    case 'v2_setWaveform':
      return [{ characteristic: opts.channel === 'B' ? V2_UUIDS.pwmB34 : V2_UUIDS.pwmA34, hex: packWaveform(opts.channel === 'B' ? 'B' : 'A', opts.x, opts.y) }]
    case 'v2_stop':
      return [{ characteristic: V2_UUIDS.pwmAB2, hex: packStrength(0, 0) }]
    default:
      throw new Error(`未知的 DG-LAB V2 指令: ${cmd}`)
  }
}
