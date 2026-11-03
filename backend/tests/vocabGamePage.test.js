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
  game.state.view = 'home'
  game.emergencyStop()
  assert.strictEqual(game.state.view, 'home')
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

test('用户手势预申请的麦克风被 start 复用，停止后释放并允许重新开启', async () => {
  const track = { stop: jest.fn() }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
  const getUserMedia = jest.fn(async () => stream)
  const listener = new voice.VoiceCommandListener({ window: { navigator: { mediaDevices: { getUserMedia } } } })
  const context = { state: 'running', createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), close: async () => {} }
  listener.audioContext = context
  listener._connectRecorder = async () => {}
  await listener.primeMic()
  await listener._startMic()
  assert.strictEqual(getUserMedia.mock.calls.length, 1)
  await listener.stop()
  assert.strictEqual(track.stop.mock.calls.length, 1)
  listener.audioContext = context
  await listener.primeMic()
  await listener._startMic()
  assert.strictEqual(getUserMedia.mock.calls.length, 2)
  await listener.stop()
})

test('停止后才获得授权的麦克风流立即释放，不留下后台录音', async () => {
  let grant
  const track = { stop: jest.fn() }
  const listener = new voice.VoiceCommandListener({ window: { navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve }) } } } })
  const pending = listener.primeMic()
  await listener.stop()
  grant({ getTracks: () => [track] })
  assert.strictEqual(await pending, null)
  assert.strictEqual(track.stop.mock.calls.length, 1)
  assert.strictEqual(listener.stream, null)
})

test('语音切片按开始采集时的题号归属，不按切片时的题号', () => {
  const { listener, captured } = makeListener()
  listener.seq = 1
  listener._tick() // 开始采集，记下 seq=1
  listener.seq = 2 // 换题（防御性：即使没走 setSeq 也不能串题）
  listener._flush(1150)
  assert.strictEqual(captured.length, 1)
  assert.strictEqual(captured[0].seq, 1)
})

test('语音切片前置留白足够 Zipformer 识别短口令首字', () => {
  const { listener, captured } = makeListener()
  listener.seq = 1
  listener._tick() // segStartedAt = now - 100
  listener._flush(1150)
  assert.strictEqual(captured.length, 1)
  const wav = Buffer.from(captured[0].audio, 'base64')
  // 16k / 单声道 / 16bit，去掉 44 字节 WAV 头
  const seconds = (wav.length - 44) / 2 / 16000
  // 起点最多往前 800ms，终点 1150ms → 至少 1.0s；400ms 时只有 0.65s
  assert.ok(seconds >= 1.0, `segment ${seconds.toFixed(2)}s too short`)
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

test('手机原生朗读结束后才释放语音屏蔽，旧朗读完成不影响重播', async () => {
  jest.useFakeTimers()
  const game = makeGame()
  const endings = []
  let now = 1000
  game.now = () => now
  game.deviceApi = { speech: { speak: jest.fn(() => new Promise(resolve => endings.push(resolve))), stop: async () => {} } }
  game.voice.ignoreUntil = jest.fn()
  const button = { classList: { toggle: jest.fn() }, setAttribute: jest.fn() }
  game.doc = { getElementById: id => id === 'vg-speak' ? button : null }
  try {
    assert.strictEqual(game.speakWord('apple', true), true)
    assert.deepStrictEqual(game.deviceApi.speech.speak.mock.calls[0][0], { text: 'apple' })
    now = 4000
    jest.advanceTimersByTime(3000)
    assert.strictEqual(game.voice.ignoreUntil.mock.calls.at(-1)[0], 4500)
    game.speakWord('banana', true)
    const timer = game.speechTimer
    endings[0]({ completed: false })
    await Promise.resolve()
    assert.strictEqual(game.speechTimer, timer)
    endings[1]({ completed: true })
    await Promise.resolve()
    assert.strictEqual(game.speechTimer, null)
    assert.strictEqual(game.voice.ignoreUntil.mock.calls.at(-1)[0], 4500)
    expect(button.setAttribute.mock.calls.filter(c => c[0] === 'aria-pressed').at(-1)).toEqual(['aria-pressed', 'false'])
  } finally {
    game.stopSpeaking()
    jest.useRealTimers()
  }
})

test('原生朗读失败给出反馈，退出页面停止朗读', async () => {
  const game = makeGame()
  const stop = jest.fn(async () => {})
  game.deviceApi = { speech: { speak: async () => { throw Error('no English voice') }, stop } }
  game._toast = jest.fn()
  game.speakWord('apple', true)
  await Promise.resolve()
  await Promise.resolve()
  assert.strictEqual(game.speechTimer, null)
  assert.ok(game._toast.mock.calls[0][0].includes('朗读不可用'))
  game._onPageHide()
  assert.ok(stop.mock.calls.length >= 2)
})

test('电击提示只在指令成功后显示，停止后消失，过期回执不能重新点亮', async () => {
  jest.useFakeTimers()
  const { game } = makeGameWithDevices()
  const indicator = { hidden: true }
  game.doc = { getElementById: id => id === 'vg-shock' ? indicator : null }
  try {
    game.doShock('wrong')
    assert.strictEqual(indicator.hidden, true)
    await Promise.resolve()
    assert.strictEqual(indicator.hidden, false)
    game.stopShock()
    assert.strictEqual(indicator.hidden, true)
    let finish
    game._shockDevice = () => ({ invoke: () => new Promise(resolve => { finish = resolve }) })
    game.doShock('timeout')
    const startDone = finish
    game.stopShock()
    startDone({ ok: true })
    await Promise.resolve()
    assert.strictEqual(indicator.hidden, true)
  } finally {
    jest.useRealTimers()
  }
})

test('电击启动拒绝或未映射时不显示提示', async () => {
  jest.useFakeTimers()
  const game = makeGame()
  const indicator = { hidden: true }
  game.doc = { getElementById: id => id === 'vg-shock' ? indicator : null }
  try {
    assert.strictEqual(game.doShock('wrong'), false)
    game._shockDevice = () => ({ invoke: async () => ({ success: false }) })
    game.doShock('wrong')
    await Promise.resolve()
    assert.strictEqual(indicator.hidden, true)
    game._shockDevice = () => ({ invoke: async () => { throw Error('offline') } })
    game.doShock('wrong')
    await Promise.resolve()
    await Promise.resolve()
    assert.strictEqual(indicator.hidden, true)
    game.stopShock()
  } finally {
    jest.useRealTimers()
  }
})

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

