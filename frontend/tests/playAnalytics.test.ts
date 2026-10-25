import assert from 'node:assert/strict'
import test from 'node:test'

import {
  durationMs,
  mappedDeviceCount,
  mappedDeviceMacs,
  mappedDeviceTypes,
  mappedRoles,
  playEventProps,
  uniqueSorted,
} from '../src/playSession.ts'

test('uniqueSorted drops blanks and sorts', () => {
  assert.equal(uniqueSorted(['TD01', '', 'CUNZHI01', 'TD01']), 'CUNZHI01,TD01')
})

test('mapped device fields ignore empty roles and report macs', () => {
  const mapping = {
    sensor: ['aa'],
    motor: ['bb', 'cc'],
    punish: [],
  }
  const devices = [
    { id: 'aa', type: 'CUNZHI01' },
    { id: 'bb', type: 'TD01' },
    { id: 'cc' },
  ]
  assert.equal(mappedRoles(mapping), 'motor,sensor')
  assert.equal(mappedDeviceCount(mapping), 3)
  assert.equal(mappedDeviceMacs(mapping), 'aa,bb,cc')
  assert.equal(mappedDeviceTypes(mapping, devices), 'CUNZHI01,TD01')
})

test('playEventProps uses game_id or plugin_id', () => {
  const base = {
    carrier: 'game' as const,
    id: 'surge-edging',
    version: '1.3.6',
    source: 'remote',
    device_types: 'CUNZHI01,TD01',
    device_macs: 'aa,bb',
    roles: 'motor,sensor',
    device_count: 2,
  }
  assert.equal(playEventProps(base).game_id, 'surge-edging')
  assert.equal(playEventProps({ ...base, carrier: 'plugin' }).plugin_id, 'surge-edging')
})

test('durationMs clamps invalid and negative values', () => {
  assert.equal(durationMs(1000, 2500), 1500)
  assert.equal(durationMs(2500, 1000), 0)
  assert.equal(durationMs(Number.NaN, 1), 0)
})
