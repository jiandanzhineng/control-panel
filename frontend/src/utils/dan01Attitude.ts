export interface AttitudeQuaternion {
  w: number
  x: number
  y: number
  z: number
}

export interface EulerAngles {
  roll: number
  pitch: number
  yaw: number
}

export interface Dan01Telemetry {
  quaternion: AttitudeQuaternion | null
  euler: EulerAngles | null
  accel: number[] | null
  gyro: number[] | null
  mag: number[] | null
}

const RAD_TO_DEG = 180 / Math.PI

export function decodeInt16Hex(value: unknown, count: number, scale: number): number[] | null {
  if (typeof value !== 'string' || value.length !== count * 4 || !/^[0-9a-f]+$/i.test(value)) {
    return null
  }

  const result: number[] = []
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4
    const low = Number.parseInt(value.slice(offset, offset + 2), 16)
    const high = Number.parseInt(value.slice(offset + 2, offset + 4), 16)
    const unsigned = low | (high << 8)
    const signed = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned
    result.push(signed * scale)
  }
  return result
}

export function quaternionToEuler(quaternion: AttitudeQuaternion): EulerAngles {
  const { w, x, y, z } = quaternion
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
  const pitchInput = Math.max(-1, Math.min(1, 2 * (w * y - z * x)))
  const pitch = Math.asin(pitchInput)
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
  return {
    roll: roll * RAD_TO_DEG,
    pitch: pitch * RAD_TO_DEG,
    yaw: yaw * RAD_TO_DEG,
  }
}

export function decodeDan01Telemetry(data: Record<string, unknown>): Dan01Telemetry {
  const rawQuaternion = decodeInt16Hex(data.quat, 4, 0.000030517578125)
  let quaternion: AttitudeQuaternion | null = null
  if (rawQuaternion) {
    const norm = Math.hypot(...rawQuaternion)
    if (norm > 0.0001) {
      quaternion = {
        w: rawQuaternion[0] / norm,
        x: rawQuaternion[1] / norm,
        y: rawQuaternion[2] / norm,
        z: rawQuaternion[3] / norm,
      }
    }
  }

  return {
    quaternion,
    euler: quaternion ? quaternionToEuler(quaternion) : null,
    accel: decodeInt16Hex(data.accel, 3, 0.00478515625),
    gyro: decodeInt16Hex(data.gyro, 3, 0.0625),
    mag: decodeInt16Hex(data.mag, 3, 0.006103515625),
  }
}
