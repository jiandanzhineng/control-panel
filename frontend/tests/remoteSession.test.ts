import assert from 'node:assert/strict'
import test from 'node:test'

import {
  barView,
  barVisible,
  deriveUiState,
  pollIntervalMs,
  sessionTone,
  stepAutoNavigate,
} from '../src/remote/remoteSessionState.ts'
import { isMenuItemLocked, isRouteLocked } from '../src/remote/remoteLock.ts'
import { endReasonKey, isLivePhase, isStaleEndedNotice, shouldAutoReturn, shouldFireEnded, stepEndedGate } from '../src/remote/remoteEnded.ts'
import { detailText, formatClock, latencyValue, normalizeJoinCode, peerLabel } from '../src/remote/remoteSessionFormat.ts'
import { EMPTY_REMOTE_SESSION_STATUS, type RemoteSessionStatus } from '../src/remote/remoteSessionTypes.ts'

function status(patch: Partial<RemoteSessionStatus> = {}): RemoteSessionStatus {
  return { ...EMPTY_REMOTE_SESSION_STATUS, active: true, ...patch }
}

test('operator remote mode needs authorization and a projection room', () => {
  const pending = deriveUiState(status({ role: 'operator', phase: 'pending-authorization' }))
  assert.equal(pending.isOperatorRemote, false)
  assert.equal(pending.isOperator, true)

  const authorizedNoRoom = deriveUiState(status({
    role: 'operator',
    phase: 'active',
    authorized: true,
    links: { game: { connected: true }, projection: { connected: false, roomId: null } },
  }))
  assert.equal(authorizedNoRoom.isOperatorRemote, false)

  const remote = deriveUiState(status({
    role: 'operator',
    phase: 'active',
    authorized: true,
    links: { game: { connected: true }, projection: { connected: true, roomId: 'room-1' } },
  }))
  assert.equal(remote.isOperatorRemote, true)
  assert.equal(remote.isHostControlled, false)
})

test('host side is only "controlled" once a member is authorized', () => {
  const waiting = deriveUiState(status({ role: 'owner', phase: 'waiting' }))
  assert.equal(waiting.isHostControlled, false)
  assert.equal(waiting.isOwner, true)

  const active = deriveUiState(status({ role: 'owner', phase: 'active', authorized: true }))
  assert.equal(active.isHostControlled, true)
  assert.equal(active.isOperatorRemote, false)
})

test('idle and ended states are not live', () => {
  const idle = deriveUiState(status({ active: false, phase: 'idle' }))
  assert.equal(idle.live, false)
  assert.equal(idle.isOwner, false)
  assert.equal(idle.isOperator, false)

  const ended = deriveUiState(status({ active: false, role: null, phase: 'ended', lastError: 'kicked' }))
  assert.equal(ended.live, false)
  assert.equal(ended.ended, true)
  assert.equal(ended.tone, 'off')
})

test('phase maps to status light and poll interval', () => {
  assert.equal(sessionTone('active'), 'ok')
  assert.equal(sessionTone('reconnecting'), 'warn')
  assert.equal(sessionTone('idle'), 'off')

  assert.equal(pollIntervalMs('active', false), 1000)
  assert.equal(pollIntervalMs('reconnecting', false), 1000)
  assert.equal(pollIntervalMs('waiting', false), 3000)
  assert.equal(pollIntervalMs('idle', false), 3000)
  assert.equal(pollIntervalMs('active', true), 5000)
})

test('the bar shows for operators, and for hosts only when relevant', () => {
  assert.equal(barVisible(deriveUiState(status({ role: 'operator', phase: 'pending-authorization' }))), true)
  assert.equal(barVisible(deriveUiState(status({ role: 'owner', phase: 'waiting' }))), false)
  assert.equal(barVisible(deriveUiState(status({ role: 'owner', phase: 'pending-authorization' }))), true)
  assert.equal(barVisible(deriveUiState(status({ role: 'owner', phase: 'active', authorized: true }))), true)
  assert.equal(barVisible(deriveUiState(status({ phase: 'idle', active: false }))), false)
})

test('locked routes only apply in operator remote mode', () => {
  assert.equal(isRouteLocked('/settings', false), false)
  assert.equal(isRouteLocked('/settings', true), true)
  assert.equal(isRouteLocked('/logs', true), true)
  assert.equal(isRouteLocked('/devices/firmware/ota', true), true)
  assert.equal(isRouteLocked('/plays/plugin/abc/run', true), true)
  assert.equal(isRouteLocked('/test', true), true)
  // 未列出的路由保持可用
  assert.equal(isRouteLocked('/devices', true), false)
  assert.equal(isRouteLocked('/plays', true), false)
  assert.equal(isRouteLocked('/remote', true), false)
  assert.equal(isRouteLocked('/support', true), false)
  // 边界：/testing 不是 /test
  assert.equal(isRouteLocked('/testing', true), false)
})

test('sidebar lock covers exactly the disabled menu entries', () => {
  for (const path of ['/browser', '/network', '/account', '/settings', '/logs']) {
    assert.equal(isMenuItemLocked(path, true), true, path)
    assert.equal(isMenuItemLocked(path, false), false, path)
  }
  assert.equal(isMenuItemLocked('/support', true), false)
  assert.equal(isMenuItemLocked('/devices', true), false)
  assert.equal(isMenuItemLocked('/remote', true), false)
})

test('end reasons map to the four messages', () => {
  assert.equal(endReasonKey('kicked'), 'kicked')
  assert.equal(endReasonKey('revoked'), 'revoked')
  assert.equal(endReasonKey('session-revoked'), 'revoked')
  assert.equal(endReasonKey('operator-left-room'), 'revoked')
  assert.equal(endReasonKey('session-stop'), 'ended')
  assert.equal(endReasonKey('room-closed'), 'ended')
  // 对端离线（宽限期超时）与未知原因都按「连接已断开」提示
  assert.equal(endReasonKey('host-offline'), 'offline')
  assert.equal(endReasonKey('whatever'), 'offline')
  assert.equal(endReasonKey(null), 'offline')
  // 本端主动断开不提示
  assert.equal(endReasonKey('operator-stop'), 'none')
  assert.equal(endReasonKey('replaced'), 'none')
})

test('an end notice only fires once per end, and never on a cold start', () => {
  assert.equal(isLivePhase('active'), true)
  assert.equal(isLivePhase('reconnecting'), true)
  assert.equal(isLivePhase('idle'), false)
  assert.equal(isLivePhase('ended'), false)

  // 首次加载就看到历史的 ended：不提示
  assert.equal(shouldFireEnded({ wasLive: false, handledReason: null }, 'ended', 'kicked'), false)
  // 见过活跃会话后结束：提示一次
  assert.equal(shouldFireEnded({ wasLive: true, handledReason: null }, 'ended', 'kicked'), true)
  // 同一段 ended 被轮询重复读到：不再提示
  assert.equal(shouldFireEnded({ wasLive: true, handledReason: 'kicked' }, 'ended', 'kicked'), false)
  // 换了一次结束（新会话又结束）：再提示
  assert.equal(shouldFireEnded({ wasLive: true, handledReason: 'kicked' }, 'ended', 'revoked'), true)
  // 非 ended 相位不提示
  assert.equal(shouldFireEnded({ wasLive: true, handledReason: null }, 'active', null), false)
})

test('only operators are sent back to the remote page', () => {
  assert.equal(shouldAutoReturn('operator', '/devices'), true)
  assert.equal(shouldAutoReturn('operator', '/remote'), false)
  assert.equal(shouldAutoReturn('owner', '/devices'), false)
  assert.equal(shouldAutoReturn(null, '/devices'), false)
})

test('peer label falls back to the last six id characters', () => {
  assert.equal(peerLabel({ userId: 'abcdef123456', nickname: '小红' }), '小红')
  assert.equal(peerLabel({ userId: 'abcdef123456', nickname: null }), '123456')
  assert.equal(peerLabel({ userId: 'abc', nickname: '  ' }), 'abc')
  assert.equal(peerLabel(null), '')
})

test('join codes keep their case: only whitespace is stripped', () => {
  assert.equal(normalizeJoinCode('QeiNOINXU18'), 'QeiNOINXU18')
  assert.equal(normalizeJoinCode(' QeiN OINX U18 '), 'QeiNOINXU18')
  assert.equal(normalizeJoinCode('4MGYgg7d_k0'), '4MGYgg7d_k0')
  // 房间码可能含 `-` / `_`：一个字符都不能动
  assert.equal(normalizeJoinCode('x_ny6g-l7uk'), 'x_ny6g-l7uk')
  assert.equal(normalizeJoinCode(null), '')
})

test('clock and detail formatting', () => {
  const ts = new Date(2026, 9, 6, 21, 3, 12).getTime()
  assert.equal(formatClock(ts), '21:03:12')
  assert.equal(formatClock(null), '')
  assert.equal(detailText({ ts: 0, userId: null, kind: 'k', target: null, summary: 's', outcome: 'clamped', detail: { message: '超过上限' } }), '超过上限')
  assert.equal(detailText({ ts: 0, userId: null, kind: 'k', target: null, summary: 's', outcome: 'rejected', detail: { code: 'DENIED' } }), 'DENIED')
  assert.equal(detailText({ ts: 0, userId: null, kind: 'k', target: null, summary: 's', outcome: 'ok', detail: null }), '')
  assert.equal(detailText({ ts: 0, userId: null, kind: 'k', target: null, summary: 's', outcome: 'clamped', detail: { hint: '请求 999 → 实际 20', message: 'x' } }), '请求 999 → 实际 20')
})

test('latency is hidden when unknown', () => {
  assert.equal(latencyValue(null), null)
  assert.equal(latencyValue(undefined), null)
  assert.equal(latencyValue('abc'), null)
  assert.equal(latencyValue(-1), null)
  assert.equal(latencyValue(0), 0)
  assert.equal(latencyValue(52.6), 53)
})

test('ended notice belongs to the session that just ended', () => {
  const gate = { wasLive: false, handledReason: null, liveSessionId: null, handledSessionId: null }
  assert.equal(stepEndedGate(gate, 'active', null, 'A'), false)
  // 会话 A 结束：弹一次，轮询重复读到不再弹
  assert.equal(stepEndedGate(gate, 'ended', 'session-stop-by-host', 'A'), true)
  assert.equal(stepEndedGate(gate, 'ended', 'session-stop-by-host', 'A'), false)
  // 新会话 B 开始：A 的提示已过时（关掉、不跳页）
  assert.equal(stepEndedGate(gate, 'pending-authorization', null, 'B'), false)
  assert.equal(isStaleEndedNotice('A', { phase: 'pending-authorization', sessionId: 'B' }), true)
  assert.equal(isStaleEndedNotice('A', { phase: 'ended', sessionId: 'A' }), false)
  assert.equal(isStaleEndedNotice('A', { phase: 'idle', sessionId: null }), false)
  // B 活跃期间读到迟到的 A 的 ended：不弹
  assert.equal(stepEndedGate(gate, 'active', null, 'B'), false)
  assert.equal(stepEndedGate(gate, 'ended', 'session-stop-by-host', 'A'), false)
  // B 自己结束（同样的原因）：照样弹
  assert.equal(stepEndedGate(gate, 'active', null, 'B'), false)
  assert.equal(stepEndedGate(gate, 'ended', 'session-stop-by-host', 'B'), true)
})

test('bar text follows phase: pending never says "controlling"', () => {
  const projection = { game: { connected: true }, projection: { connected: true, roomId: 'p1' } }
  const opPending = barView(deriveUiState(status({ role: 'operator', phase: 'pending-authorization' })))
  assert.deepEqual(opPending, { textKey: 'operatorPending', tone: 'pending', showEmergencyStop: false, operatorStopKey: 'cancel' })
  const opActive = barView(deriveUiState(status({ role: 'operator', phase: 'active', authorized: true, links: projection })))
  assert.deepEqual(opActive, { textKey: 'operator', tone: 'ok', showEmergencyStop: true, operatorStopKey: 'disconnect' })
  const opReconnecting = barView(deriveUiState(status({ role: 'operator', phase: 'reconnecting', authorized: true, links: projection })))
  assert.equal(opReconnecting.textKey, 'operator')
  assert.equal(opReconnecting.tone, 'warn')

  const hostPending = barView(deriveUiState(status({ role: 'owner', phase: 'pending-authorization' })))
  assert.deepEqual(hostPending, { textKey: 'hostPending', tone: 'pending', showEmergencyStop: false, operatorStopKey: 'disconnect' })
  const hostActive = barView(deriveUiState(status({ role: 'owner', phase: 'active', authorized: true })))
  assert.equal(hostActive.textKey, 'host')
  assert.equal(hostActive.tone, 'ok')
  assert.equal(hostActive.showEmergencyStop, true)
  assert.equal(sessionTone('pending-authorization'), 'pending')
})

test('operator auto-navigates to /devices once per session, including from /remote', () => {
  const projection = { game: { connected: true }, projection: { connected: true, roomId: 'p1' } }
  const pending = deriveUiState(status({ role: 'operator', phase: 'pending-authorization' }))
  const active = deriveUiState(status({ role: 'operator', phase: 'active', authorized: true, links: projection }))
  const memo = { handledKey: null as string | null }

  assert.equal(stepAutoNavigate(memo, pending, 's1', '/remote'), null)
  assert.equal(stepAutoNavigate(memo, active, 's1', '/remote'), '/devices')
  assert.equal(stepAutoNavigate(memo, active, 's1', '/home'), null, 'only once per session')

  // 上一段会话结束没被轮询到（直接进入下一段）：新会话 id 仍然要跳
  assert.equal(stepAutoNavigate(memo, pending, 's2', '/home'), null)
  assert.equal(stepAutoNavigate(memo, active, 's2', '/home'), '/devices')

  // 已经在设备页：记为已处理但不跳
  assert.equal(stepAutoNavigate(memo, active, 's3', '/devices'), null)
  assert.equal(stepAutoNavigate(memo, active, 's3', '/home'), null)

  // 回到 idle 后清空记忆
  stepAutoNavigate(memo, deriveUiState(status({ active: false, phase: 'idle' })), null, '/remote')
  assert.equal(memo.handledKey, null)
})
