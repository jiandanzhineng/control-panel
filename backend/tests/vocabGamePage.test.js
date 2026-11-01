/**
 * 背单词游戏页面编排的过期结果测试：语音结果和 0.6 秒自动跳题都带题目序号，
 * 旧题目的回调必须丢弃（docs/plans/vocab-game.md 任务要求）。
 */
const assert = require('assert')
const { VocabGame } = require('../games/vocab-game/game.js')
const voice = require('../games/vocab-game/voice.js')
const test = (name, fn) => globalThis.test(name, fn)

function makeGame() {
  const game = new VocabGame({
    window: null,
    document: null,
    deviceApi: null,
    cloud: null,
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    now: () => 1000
  })
  game.voiceOk = true
  game.state.view = 'playing'
  game.state.questionSeq = 2
  game.state.answered = false
  game.state.question = {
    id: 'apple',
    word: 'apple',
    phonetic: 'ˈæpl',
    short: 'n. 苹果',
    full: 'n. 苹果；苹果树',
    choices: [{ id: 'apple', text: 'n. 苹果', correct: true }]
  }
  game.plan = { bank: 'cet4', ids: ['apple'], done: [], extra: 0, newIds: ['apple'], u: 1 }
  return game
}

test('旧题目的语音结果丢弃，不会误答当前题', () => {
  const game = makeGame()
  game._onVoiceResult({ text: '第一个', seq: 1 })
  assert.strictEqual(game.state.answered, false)
  assert.strictEqual(game.session.answers, 0)
  assert.deepStrictEqual(game.plan.done, [])
})

test('旧题目的自动跳题定时器触发时丢弃', () => {
  const game = makeGame()
  game.state.answered = true
  game._afterCorrect(1)
  assert.strictEqual(game.state.view, 'playing')
  assert.strictEqual(game.state.answered, true)
})

test('答案面板等待期间点选项不再作答', () => {
  const game = makeGame()
  game.state.view = 'answer'
  game.answer(1)
  assert.strictEqual(game.session.answers, 0)
})

test('开始页按急停不会进入已结束', () => {
  const game = makeGame()
  game.state.view = 'start'
  game.emergencyStop()
  assert.strictEqual(game.state.view, 'start')
})

function makeListener() {
  const listener = new voice.VoiceCommandListener({
    window: null,
    speech: { transcribe: async () => ({ text: '' }) },
    now: () => 1000
  })
  listener.running = true
  listener.audioContext = { sampleRate: 16000 }
  listener.audioStartTime = 0
  listener.ringBuffer = new voice.PcmRingBuffer(2, 16000)
  listener.ringBuffer.push(new Float32Array(20000))
  listener.freqData = new Uint8Array(512)
  listener.timeData = new Float32Array(1024)
  listener.analyser = {
    fftSize: 1024,
    frequencyBinCount: 512,
    getByteFrequencyData: () => {},
    getFloatTimeDomainData: () => {}
  }
  listener.detector = { process: () => ({ voiced: true, calibrating: false, micAbnormal: false }) }
  const captured = []
  listener._transcribe = segment => captured.push(segment)
  return { listener, captured }
}

test('语音切片按开始采集时的题号归属，不按切片时的题号', () => {
  const { listener, captured } = makeListener()
  listener.seq = 1
  listener._tick() // 开始采集，记下 seq=1
  listener.seq = 2 // 换题（防御性：即使没走 setSeq 也不能串题）
  listener._flush(1150)
  assert.strictEqual(captured.length, 1)
  assert.strictEqual(captured[0].seq, 1)
})

test('换题时丢弃正在采集的语音', () => {
  const { listener, captured } = makeListener()
  listener.seq = 1
  listener._tick()
  assert.ok(listener.segStartedAt > 0)
  listener.setSeq(2)
  assert.strictEqual(listener.segStartedAt, 0)
  assert.strictEqual(listener.segSeq, 0)
  listener._flush(1150)
  assert.strictEqual(captured.length, 0)
})

function makeGameWithDevices() {
  const calls = []
  const deviceApi = {
    device(id) {
      return {
        isMapped: () => true,
        invoke: (cap, action, params) => {
          calls.push({ id, cap, action, params })
          return Promise.resolve({ ok: true })
        }
      }
    }
  }
  const listeners = {}
  const env = { addEventListener: (type, fn) => { listeners[type] = fn } }
  const doc = { getElementById: () => null, addEventListener: () => {}, hidden: false }
  const game = new VocabGame({
    window: env,
    document: doc,
    deviceApi,
    cloud: null,
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    now: () => 1000
  })
  game._bindUI()
  return { game, calls, listeners }
}
const hasLockOpen = calls => calls.some(c => c.id === 'lock' && c.action === 'setOpen' && c.params.open === true)
const hasShockStop = calls => calls.some(c => c.id === 'shock' && c.action === 'stop')

test('未捕获错误也会停电击并解锁', () => {
  const { calls, listeners } = makeGameWithDevices()
  listeners.unhandledrejection({ reason: new Error('boom') })
  assert.ok(hasShockStop(calls))
  assert.ok(hasLockOpen(calls))
})

test('资源加载错误不误触发解锁', () => {
  const { calls, listeners } = makeGameWithDevices()
  listeners.error({ type: 'error' })
  assert.strictEqual(calls.length, 0)
})

test('启动失败和 pagehide 都停电击并解锁', () => {
  const first = makeGameWithDevices()
  first.game._startFailed(new Error('start failed'))
  assert.ok(hasShockStop(first.calls))
  assert.ok(hasLockOpen(first.calls))

  const second = makeGameWithDevices()
  second.game._onPageHide()
  assert.ok(hasShockStop(second.calls))
  assert.ok(hasLockOpen(second.calls))
})

