import assert from 'node:assert/strict'
import test from 'node:test'

import { buildGameRuntimePageSrc, resolveGamePagePath } from '../src/play/gamePagePath.ts'

test('buildGameRuntimePageSrc appends runtime mode and locale', () => {
  const src = buildGameRuntimePageSrc('/games/pressure-edging-v2/index.html', 'host', 'zh', 'zh-CN')
  assert.equal(src, '/games/pressure-edging-v2/index.html?runtime=host&locale=zh&localeTag=zh-CN')
  const remote = buildGameRuntimePageSrc('/games/cache/surge-edging/1.3.0/index.html?x=1', 'remote')
  assert.equal(remote, '/games/cache/surge-edging/1.3.0/index.html?x=1&runtime=remote')
  assert.equal(buildGameRuntimePageSrc('', 'host'), '')
})

test('resolveGamePagePath prefers builtin gamePath', async () => {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    return { ok: true, json: async () => ({ gamePath: '/games/pressure-edging-v2/index.html' }) }
  }
  const path = await resolveGamePagePath('pressure-edging-v2')
  assert.equal(path, '/games/pressure-edging-v2/index.html')
  assert.equal(calls.length, 1)
})

test('resolveGamePagePath falls back to cache install for registry games', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/api/game-cache/install/')) {
      return { ok: true, json: async () => ({ localGamePath: '/games/cache/surge-edging/1.3.0/index.html' }) }
    }
    return { ok: false, json: async () => ({}) }
  }
  const path = await resolveGamePagePath('surge-edging')
  assert.equal(path, '/games/cache/surge-edging/1.3.0/index.html')
})

test('resolveGamePagePath returns empty when nothing resolves', async () => {
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })
  assert.equal(await resolveGamePagePath('nope'), '')
  assert.equal(await resolveGamePagePath(''), '')
})
