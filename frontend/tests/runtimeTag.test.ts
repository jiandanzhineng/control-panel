import assert from 'node:assert/strict'
import test from 'node:test'

import { runtimeTagFor } from '../src/play/runtimeTag.ts'

test('runtimeTagFor shows nothing for non-game carriers', () => {
  assert.equal(runtimeTagFor({ isGame: false, isHostRuntime: false, isOperatorRemote: true }), null)
  assert.equal(runtimeTagFor({ isGame: false, isHostRuntime: true, isOperatorRemote: true }), null)
  assert.equal(runtimeTagFor({ isGame: false, isHostRuntime: true, isOperatorRemote: false }), null)
})

test('runtimeTagFor marks a host-runtime game as no-delay (accent)', () => {
  assert.deepEqual(
    runtimeTagFor({ isGame: true, isHostRuntime: true, isOperatorRemote: true }),
    { key: 'plays.remoteNoDelayTag', tipKey: 'plays.remoteNoDelayTip', accent: true },
  )
})

test('runtimeTagFor marks a non-host game as delayed while operator remote', () => {
  assert.deepEqual(
    runtimeTagFor({ isGame: true, isHostRuntime: false, isOperatorRemote: true }),
    { key: 'plays.remoteDelayTag', tipKey: 'plays.remoteDelayTip', accent: false },
  )
})

test('runtimeTagFor hides the tag for a non-host game outside remote mode', () => {
  assert.equal(runtimeTagFor({ isGame: true, isHostRuntime: false, isOperatorRemote: false }), null)
})

test('runtimeTagFor keeps the accent tag for a host game outside remote mode', () => {
  assert.deepEqual(
    runtimeTagFor({ isGame: true, isHostRuntime: true, isOperatorRemote: false }),
    { key: 'plays.remoteNoDelayTag', tipKey: 'plays.remoteNoDelayTip', accent: true },
  )
})
