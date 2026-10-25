import assert from 'node:assert/strict'
import test from 'node:test'

import { errorCode, friendlyMessage } from '../src/api/errorMessage.ts'

const t = (key: string) => key

test('errorCode reads the backend code and ignores everything else', () => {
  assert.equal(errorCode({ code: 'X' }), 'X')
  assert.equal(errorCode({}), null)
  assert.equal(errorCode({ code: '' }), null)
  assert.equal(errorCode(''), null)
  assert.equal(errorCode('boom'), null)
  assert.equal(errorCode(null), null)
})

test('friendlyMessage maps known codes to i18n keys', () => {
  assert.equal(friendlyMessage({ code: 'HOST_PLAY_ACTIVE', message: 'raw' }, t), 'remoteSession.errors.hostPlayActive')
  assert.equal(friendlyMessage({ code: 'PUBLISH_TIMEOUT' }, t), 'remoteSession.errors.hostNoResponse')
  assert.equal(friendlyMessage({ code: 'REMOTE_LOCKED' }, t), 'remoteSession.lock.menu')
})

test('friendlyMessage falls back to message, then fallback, never throwing', () => {
  assert.equal(friendlyMessage({ code: 'UNKNOWN', message: 'raw' }, t), 'raw')
  assert.equal(friendlyMessage({}, t, 'fb'), 'fb')
  assert.equal(friendlyMessage(null, t), 'remoteSession.commandFailed')
  assert.equal(friendlyMessage('boom', t), 'boom')
  assert.equal(friendlyMessage('', t, 'fb'), 'fb')
})
