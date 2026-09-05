import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeDan01Telemetry, decodeInt16Hex } from '../src/utils/dan01Attitude.ts'

test('decodes signed little-endian AS201 vectors', () => {
  assert.deepEqual(decodeInt16Hex('0100feffff7f', 3, 1), [1, -2, 32767])
  assert.equal(decodeInt16Hex('not-hex', 3, 1), null)
})

test('normalizes quaternion and derives Euler angles', () => {
  const telemetry = decodeDan01Telemetry({
    quat: '825a00000000825a',
    accel: '000000000008',
    gyro: '000000000000',
    mag: '000000000000',
  })
  assert.ok(telemetry.quaternion)
  assert.ok(telemetry.euler)
  assert.ok(Math.abs(Math.hypot(
    telemetry.quaternion.w,
    telemetry.quaternion.x,
    telemetry.quaternion.y,
    telemetry.quaternion.z,
  ) - 1) < 0.000001)
  assert.ok(Math.abs(telemetry.euler.yaw - 90) < 0.1)
  assert.deepEqual(telemetry.gyro, [0, 0, 0])
})

test('rejects empty or zero quaternions', () => {
  assert.equal(decodeDan01Telemetry({ quat: '' }).quaternion, null)
  assert.equal(decodeDan01Telemetry({ quat: '0000000000000000' }).quaternion, null)
})
