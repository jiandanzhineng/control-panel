import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MIC_ID,
  buildMicOptions,
  buildVoiceTriggerUrl,
  frameLevel,
  micConstraintsFor,
  resolveMicId,
  smoothLevel,
  voiceErrorKey,
} from '../src/play/voiceStart.ts'

test('buildMicOptions always prepends the system default and skips non-audio inputs', () => {
  const options = buildMicOptions([
    { deviceId: 'cam', kind: 'videoinput', label: 'Webcam' },
    { deviceId: 'mic-1', kind: 'audioinput', label: 'USB Mic' },
    { deviceId: 'mic-2', kind: 'audioinput', label: '' },
    { deviceId: 'mic-1', kind: 'audioinput', label: 'dup' },
  ], '系统默认')

  assert.deepEqual(options, [
    { id: DEFAULT_MIC_ID, label: '系统默认' },
    { id: 'mic-1', label: 'USB Mic' },
    { id: 'mic-2', label: '麦克风 2' },
  ])
})

test('buildMicOptions tolerates a missing device list', () => {
  assert.deepEqual(buildMicOptions(null, '系统默认'), [{ id: DEFAULT_MIC_ID, label: '系统默认' }])
  assert.deepEqual(buildMicOptions(undefined, '系统默认'), [{ id: DEFAULT_MIC_ID, label: '系统默认' }])
})

test('resolveMicId falls back to the default when the saved device is gone', () => {
  const options = [
    { id: DEFAULT_MIC_ID, label: '系统默认' },
    { id: 'mic-1', label: 'USB Mic' },
  ]
  assert.equal(resolveMicId('mic-1', options), 'mic-1')
  assert.equal(resolveMicId('unplugged', options), DEFAULT_MIC_ID)
  assert.equal(resolveMicId('', options), DEFAULT_MIC_ID)
  assert.equal(resolveMicId(null, options), DEFAULT_MIC_ID)
})

test('micConstraintsFor leaves the default device to the browser', () => {
  assert.deepEqual(micConstraintsFor(DEFAULT_MIC_ID), {})
  assert.deepEqual(micConstraintsFor(''), {})
  assert.deepEqual(micConstraintsFor('mic-1'), { deviceId: { exact: 'mic-1' } })
})

test('buildVoiceTriggerUrl follows the page origin and encodes the phrase id', () => {
  assert.equal(
    buildVoiceTriggerUrl('http://127.0.0.1:5277', 'start_game'),
    'ws://127.0.0.1:5277/voice-trigger?phrase=start_game',
  )
  assert.equal(
    buildVoiceTriggerUrl('https://example.com', 'a b'),
    'wss://example.com/voice-trigger?phrase=a%20b',
  )
})

test('frameLevel maps silence to 0 and loud input to 1', () => {
  assert.equal(frameLevel(new Float32Array(0)), 0)
  assert.equal(frameLevel(new Float32Array(160)), 0)
  assert.equal(frameLevel(new Float32Array(160).fill(0.5)), 1)
  const quiet = frameLevel(new Float32Array(160).fill(0.0125))
  assert.ok(quiet > 0.04 && quiet < 0.06, `unexpected level ${quiet}`)
})

test('smoothLevel follows the new value gradually', () => {
  assert.equal(smoothLevel(0, 1, 0.5), 0.5)
  assert.equal(smoothLevel(0.5, 1, 0.5), 0.75)
  assert.equal(smoothLevel(Number.NaN, 1, 0.5), 0.5)
})

test('voiceErrorKey maps browser and backend failures to readable keys', () => {
  assert.equal(voiceErrorKey('NotAllowedError'), 'playConfig.voiceMicDenied')
  assert.equal(voiceErrorKey('NotFoundError'), 'playConfig.voiceMicMissing')
  assert.equal(voiceErrorKey('NotReadableError'), 'playConfig.voiceMicBusy')
  assert.equal(voiceErrorKey('MODEL_UNAVAILABLE'), 'playConfig.voiceModelMissing')
  assert.equal(voiceErrorKey('REMOTE_LOCKED'), 'remoteSession.lock.menu')
  assert.equal(voiceErrorKey('TIMEOUT'), 'playConfig.voiceTimeout')
  assert.equal(voiceErrorKey('whatever'), 'playConfig.voiceFailed')
  assert.equal(voiceErrorKey(null), 'playConfig.voiceFailed')
})
