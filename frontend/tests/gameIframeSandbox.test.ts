import assert from 'node:assert/strict'
import test from 'node:test'

import { iframeSandboxFor, isProxiedGameSrc } from '../src/play/gameIframeSandbox.ts'

test('builtin games keep same-origin access (no sandbox)', () => {
  assert.equal(iframeSandboxFor('/games/pressure-edging-v2/index.html'), undefined)
  assert.equal(iframeSandboxFor('/games/device-control/index.html?deviceMap=%7B%7D'), undefined)
})

test('cached registry games keep same-origin access (no sandbox)', () => {
  assert.equal(iframeSandboxFor('/games/cache/surge-edging/1.3.0/index.html?runtime=host'), undefined)
})

test('proxied third-party games are sandboxed without allow-same-origin', () => {
  const sandbox = iframeSandboxFor('/games/proxy/https/example.com/game/index.html?deviceMap=%7B%7D')
  assert.ok(sandbox)
  assert.ok(sandbox.includes('allow-scripts'))
  assert.ok(!sandbox.includes('allow-same-origin'))
})

test('empty src has no sandbox and isProxiedGameSrc detects proxy paths', () => {
  assert.equal(iframeSandboxFor(''), undefined)
  assert.equal(isProxiedGameSrc('/games/proxy/https/example.com/index.html'), true)
  assert.equal(isProxiedGameSrc('/games/cache/surge-edging/1.3.0/index.html'), false)
})
