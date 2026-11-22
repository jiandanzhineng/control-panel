import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hiddenDefaultOverrides,
  isParamVisible,
  matchesVisibleWhen,
  visibleParams,
  withHiddenDefaults,
} from '../src/utils/paramVisibility.ts'

const params = [
  { key: 'mode', default: 'read' },
  { key: 'passes', default: 1, visibleWhen: { key: 'mode', equals: 'read' } },
  { key: 'maskStart', default: 10, visibleWhen: { key: 'mode', equals: 'recite' } },
  { key: 'shockMax', default: 50, visibleWhen: { key: 'shockStep', gt: 0 } },
  { key: 'segmentLen', default: 4, hidden: true },
]

test('hidden params are never visible', () => {
  assert.equal(isParamVisible(params[4], {}), false)
  assert.equal(isParamVisible(params[4], { segmentLen: 9 }), false)
})

test('visibleWhen equals supports single values and arrays', () => {
  assert.equal(matchesVisibleWhen({ visibleWhen: { key: 'mode', equals: 'read' } }, { mode: 'read' }), true)
  assert.equal(matchesVisibleWhen({ visibleWhen: { key: 'mode', equals: 'read' } }, { mode: 'recite' }), false)
  assert.equal(matchesVisibleWhen({ visibleWhen: { key: 'mode', equals: ['read', 'recite'] } }, { mode: 'recite' }), true)
  assert.equal(matchesVisibleWhen({ visibleWhen: { key: 'mode', equals: ['read', 'recite'] } }, { mode: 'other' }), false)
})

test('visibleWhen gt only matches numbers above the threshold', () => {
  assert.equal(matchesVisibleWhen({ visibleWhen: { key: 'shockStep', gt: 0 } }, { shockStep: 1 }), true)
  assert.equal(matchesVisibleWhen({ visibleWhen: { key: 'shockStep', gt: 0 } }, { shockStep: 0 }), false)
  assert.equal(matchesVisibleWhen({ visibleWhen: { key: 'shockStep', gt: 0 } }, { shockStep: '2' }), true)
  assert.equal(matchesVisibleWhen({ visibleWhen: { key: 'shockStep', gt: 0 } }, {}), false)
})

test('visibleParams filters hidden and unmatched params without touching values', () => {
  const values = { mode: 'read', passes: 2, maskStart: 30, shockStep: 0, segmentLen: 7 }
  assert.deepEqual(visibleParams(params, values).map((p) => p.key), ['mode', 'passes'])
  assert.equal(values.maskStart, 30)
  assert.equal(values.segmentLen, 7)
  const recite = visibleParams(params, { ...values, mode: 'recite' })
  assert.deepEqual(recite.map((p) => p.key), ['mode', 'maskStart'])
  const escalating = visibleParams(params, { ...values, shockStep: 3 })
  assert.deepEqual(escalating.map((p) => p.key), ['mode', 'passes', 'shockMax'])
})

test('hidden defaults override saved values at launch', () => {
  assert.deepEqual(hiddenDefaultOverrides(params, { segmentLen: 7 }), { segmentLen: 4 })
  assert.deepEqual(withHiddenDefaults(params, { mode: 'read', segmentLen: 7, passes: 3 }), {
    mode: 'read',
    segmentLen: 4,
    passes: 3,
  })
})
