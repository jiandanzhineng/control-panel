import assert from 'node:assert/strict'
import test from 'node:test'

import { createStreamState, reduceStateEvent } from '../src/play/gameStateStream.ts'
import { createGameStateStream } from '../src/play/gameStateStreamClient.ts'

const snap = (state: any, rev: number) => ({ type: 'snapshot', rev, state })
const patch = (rev: number, baseRev: number, ops: any[]) => ({ type: 'patch', rev, baseRev, ops })

test('a full snapshot replaces the state and sets the rev', () => {
  const result = reduceStateEvent(createStreamState(null, 0), snap({ running: true, phase: 'INITIAL_CALM' }, 1))
  assert.equal(result.changed, true)
  assert.equal(result.resync, false)
  assert.equal(result.rev, 1)
  assert.equal((result.state as any).phase, 'INITIAL_CALM')
})

test('an out-of-order older snapshot never rewinds the state', () => {
  const current = createStreamState({ phase: 'EDGING' }, 7)
  const result = reduceStateEvent(current, snap({ phase: 'INITIAL_CALM' }, 3))
  assert.equal(result.changed, false)
  assert.equal(result.rev, 7)
  assert.equal((result.state as any).phase, 'EDGING')
})

test('a patch applies dotted paths without touching untouched branches', () => {
  const current = createStreamState({ running: true, pressure: { now: 1, avg: 2 }, logs: ['a'] }, 4)
  const result = reduceStateEvent(current, patch(5, 4, [{ op: 'set', path: 'pressure.now', value: 9 }]))
  assert.equal(result.changed, true)
  assert.equal((result.state as any).pressure.now, 9)
  assert.equal((result.state as any).pressure.avg, 2)
  assert.equal((result.state as any).logs, (current.state as any).logs)
  assert.equal(result.rev, 5)
})

test('append ships only the new sample tail', () => {
  const current = createStreamState({ samples: [1, 2] }, 2)
  const result = reduceStateEvent(current, patch(3, 2, [{ op: 'append', path: 'samples', items: [3, 4] }]))
  assert.deepEqual((result.state as any).samples, [1, 2, 3, 4])
  assert.deepEqual((current.state as any).samples, [1, 2])
})

test('prepend keeps newest-first logs in order', () => {
  const current = createStreamState({ logs: ['old'] }, 1)
  const result = reduceStateEvent(current, patch(2, 1, [{ op: 'prepend', path: 'logs', items: ['new'] }]))
  assert.deepEqual((result.state as any).logs, ['new', 'old'])
})

test('del removes a key and a missing key is a no-op', () => {
  const current = createStreamState({ a: 1, b: 2 }, 3)
  const removed = reduceStateEvent(current, patch(4, 3, [{ op: 'del', path: 'b' }]))
  assert.deepEqual(removed.state, { a: 1 })
  const missing = reduceStateEvent(current, patch(4, 3, [{ op: 'del', path: 'zzz' }]))
  assert.deepEqual(missing.state, { a: 1, b: 2 })
})

test('a root set replaces the whole document', () => {
  const result = reduceStateEvent(createStreamState({ a: 1 }, 1), patch(2, 1, [{ op: 'set', path: '', value: { b: 2 } }]))
  assert.deepEqual(result.state, { b: 2 })
})

test('a rev gap requests a full resync instead of guessing', () => {
  const current = createStreamState({ a: 1 }, 5)
  const result = reduceStateEvent(current, patch(9, 7, [{ op: 'set', path: 'a', value: 2 }]))
  assert.equal(result.resync, true)
  assert.equal(result.changed, false)
  assert.equal(result.rev, 5)
  assert.deepEqual(result.state, { a: 1 })
})

test('malformed ops request a resync rather than corrupting the state', () => {
  const current = createStreamState({ a: 1 }, 1)
  for (const ops of [[{ op: 'bogus', path: 'a' }], [{ op: 'append', path: 'a', items: [1] }], [{ op: 'set', path: 'a.b' }]]) {
    const result = reduceStateEvent(current, patch(2, 1, ops as any))
    assert.equal(result.resync, true)
    assert.deepEqual(result.state, { a: 1 })
  }
})

test('unknown events and an empty patch are ignored', () => {
  const current = createStreamState({ a: 1 }, 1)
  assert.deepEqual(reduceStateEvent(current, null), { state: { a: 1 }, rev: 1, changed: false, resync: false })
  assert.deepEqual(reduceStateEvent(current, { type: 'noise' } as any), { state: { a: 1 }, rev: 1, changed: false, resync: false })
  const empty = reduceStateEvent(current, patch(2, 1, []))
  assert.equal(empty.changed, true)
  assert.deepEqual(empty.state, { a: 1 })
})

// ---- 状态流客户端（SSE 优先，失败回落轮询）----

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  closed = false
  handlers: Record<string, ((event: any) => void)[]> = {}
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, handler: (event: any) => void) {
    (this.handlers[type] ||= []).push(handler)
  }
  emit(type: string, data: any) {
    for (const handler of this.handlers[type] || []) handler({ data: JSON.stringify(data) })
  }
  close() { this.closed = true }
}

test('stream client applies the snapshot frame then patch frames', () => {
  FakeEventSource.instances = []
  ;(globalThis as any).EventSource = FakeEventSource
  const seen: any[] = []
  const stream = createGameStateStream({
    url: '/api/game-runtime/stream',
    poll: async () => ({}),
    onState: (state) => seen.push(state),
  })
  stream.start()
  const source = FakeEventSource.instances[0]
  assert.equal(source.url, '/api/game-runtime/stream')
  source.emit('snapshot', { type: 'snapshot', rev: 1, state: { running: true, currentPressure: 1 } })
  source.emit('patch', { type: 'patch', rev: 2, baseRev: 1, ops: [{ op: 'set', path: 'currentPressure', value: 9 }] })
  assert.equal(seen.length, 2)
  assert.equal(seen[1].currentPressure, 9)
  assert.equal(stream.rev(), 2)
  stream.stop()
  assert.equal(source.closed, true)
  delete (globalThis as any).EventSource
})

test('a rev gap on the client reopens the stream instead of guessing', () => {
  FakeEventSource.instances = []
  ;(globalThis as any).EventSource = FakeEventSource
  const seen: any[] = []
  const stream = createGameStateStream({
    url: '/api/remote-game/stream',
    poll: async () => ({}),
    onState: (state) => seen.push(state),
  })
  stream.start()
  const first = FakeEventSource.instances[0]
  first.emit('snapshot', { type: 'snapshot', rev: 4, state: { gameRev: 4 } })
  first.emit('patch', { type: 'patch', rev: 9, baseRev: 7, ops: [{ op: 'set', path: 'gameRev', value: 9 }] })
  // 断档：旧流被关掉、开了一条新流，且坏 patch 没有被应用
  assert.equal(first.closed, true)
  assert.equal(FakeEventSource.instances.length, 2)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].gameRev, 4)
  stream.stop()
  delete (globalThis as any).EventSource
})
