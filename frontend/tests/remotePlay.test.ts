import assert from 'node:assert/strict'
import test from 'node:test'

import { needsFrontendOccupy, playEndedMessageKey, playLabel, preemptedLocalPlay } from '../src/remote/remotePlay.ts'

test('preemptedLocalPlay returns the previous play only when it disappears', () => {
  const a = { gameId: 'a', gameName: 'A' }
  assert.deepEqual(preemptedLocalPlay(a, null), a)
  assert.deepEqual(preemptedLocalPlay(a, undefined), a)
  assert.equal(preemptedLocalPlay(a, a), null)
  assert.equal(preemptedLocalPlay(a, { gameId: 'b' }), null)
  assert.equal(preemptedLocalPlay(null, null), null)
  assert.equal(preemptedLocalPlay(undefined, a), null)
})

test('playLabel prefers gameName then gameId', () => {
  assert.equal(playLabel({ gameId: 'a', gameName: 'A' }), 'A')
  assert.equal(playLabel({ gameId: 'a', gameName: null }), 'a')
  assert.equal(playLabel(null), '')
})

test('needsFrontendOccupy only covers carriers the host cannot see', () => {
  // 页面式游戏与 HostRuntime 由后端启动接口登记（被拒即不启动）
  assert.equal(needsFrontendOccupy('game'), false)
  // 插件（以及缺省）在被控端没有载体事件，前端要自己登记
  assert.equal(needsFrontendOccupy('plugin'), true)
  assert.equal(needsFrontendOccupy(null), true)
  assert.equal(needsFrontendOccupy(undefined), true)
})

test('playEndedMessageKey distinguishes a host preempt from a host stop', () => {
  assert.equal(playEndedMessageKey('host-local-play'), 'remoteSession.play.preempted')
  assert.equal(playEndedMessageKey('host-stopped'), 'remoteSession.play.ended')
  assert.equal(playEndedMessageKey('remote-stop'), 'remoteSession.play.ended')
  assert.equal(playEndedMessageKey(null), 'remoteSession.play.ended')
})
