import assert from 'node:assert/strict'
import test from 'node:test'

import {
  controlsEnabled,
  isHostRuntime,
  restoreFromStatus,
  runtimeViewMode,
  shouldStopAfterStatusFailure,
} from '../src/play/gameRuntimeSession.ts'

test('host mode does not create an iframe carrier', () => {
  assert.equal(runtimeViewMode('host'), 'snapshot')
  assert.equal(isHostRuntime({ runtime: { mode: 'host' } }), true)
  assert.equal(runtimeViewMode('iframe'), 'iframe')
  assert.equal(isHostRuntime({ runtime: { mode: 'iframe' } }), false)
})

test('refresh restores the host snapshot', () => {
  const restored = restoreFromStatus({
    running: true,
    snapshot: { phase: 'EDGING', phaseText: '边缘寸止', currentPressure: 12.4 },
  })
  assert.equal(restored?.phase, 'EDGING')
  assert.equal(restored?.currentPressure, 12.4)
})

test('unauthorized remote client cannot use controls', () => {
  const controls = controlsEnabled({ authorized: false, running: true, paused: false, connection: 'live' })
  assert.equal(controls.pause, false)
  assert.equal(controls.resume, false)
  assert.equal(controls.stop, false)
  assert.equal(controls.params, false)
  assert.equal(controls.action, false)
})

test('a short network failure does not request stop', () => {
  assert.equal(shouldStopAfterStatusFailure(1), false)
  assert.equal(shouldStopAfterStatusFailure(5), false)
  const controls = controlsEnabled({ authorized: true, running: true, connection: 'reconnecting' })
  assert.equal(controls.stop, false)
})
