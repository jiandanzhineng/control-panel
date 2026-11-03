/**
 * 扇贝式改版的页面行为：空计划完成、跨 04:00、完成前云端合并、暂停不跳题、
 * 上传脏标记竞态、pagehide 补发、primeMic、自动进入、游戏内设置与本机电击覆盖。
 */
const assert = require('assert')
const core = require('../games/vocab-game/vocab-core.js')
const { VocabGame } = require('../games/vocab-game/game.js')
const test = (name, fn) => globalThis.test(name, fn)

function memoryStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) }
  }
}

function localMs(y, m, d, h, min) {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime()
}

function fakeElement() {
  return {
    hidden: false,
    disabled: false,
    textContent: '',
    className: '',
    value: '',
    style: {},
    handlers: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, fn) { this.handlers[type] = fn },
    querySelectorAll() { return [] },
    querySelector() { return null },
    getAttribute() { return null },
    closest() { return null },
    scrollIntoView() {}
  }
}

function fakeDoc() {
  const els = new Map()
  return {
    hidden: false,
    body: { classList: { add() {}, remove() {}, toggle() {} } },
    els: els,
    addEventListener() {},
    querySelectorAll() { return [] },
    getElementById(id) {
      if (!els.has(id)) els.set(id, fakeElement())
      return els.get(id)
    }
  }
}

function bankEnv() {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((word, i) => ({
    id: word,
    word: word,
    phonetic: word,
    short: 'n. 释义' + i,
    full: 'n. 完整释义' + i
  }))
  const other = ['india', 'juliet', 'kilo', 'lima'].map((word, i) => ({
    id: word,
    word: word,
    phonetic: word,
    short: 'v. 释义' + i,
    full: 'v. 完整释义' + i
  }))
  return {
    VG_BANKS: {
      cet4: { name: '四级', nameEn: 'CET-4', words: words },
      ielts: { name: '雅思', nameEn: 'IELTS', words: other }
    }
  }
}

function makeGame(opts) {
  const o = opts || {}
  const game = new VocabGame({
    window: o.window !== undefined ? o.window : bankEnv(),
    document: o.document !== undefined ? o.document : fakeDoc(),
    deviceApi: o.deviceApi || null,
    cloud: o.cloud !== undefined ? o.cloud : null,
    storage: o.storage || memoryStorage(),
    now: o.now || (() => 1000),
    random: () => 0.5
  })
  game.signedIn = true
  game.online = true
  game.planReady = true
  game.userId = 'u1'
  return game
}

function seedPlan(game, ids, done, newIds) {
  const now = game.now()
  game.today = core.dayIndex(now)
  game._loadBank()
  game.plan = {
    bank: game.config.bank,
    ids: ids.slice(),
    done: (done || []).slice(),
    extra: 0,
    newIds: (newIds || []).slice(),
    u: now
  }
  game.save.plans[core.dateKey(now)] = game.plan
  game.queue = new core.QuizQueue(core.planRemaining(game.plan))
  return game.plan
}

function reviewGame() {
  let now = 1000
  const game = makeGame({ now: () => now })
  game.config.autoSpeak = false
  game.timers = { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} }
  game.doShock = jest.fn()
  seedPlan(game, ['alpha', 'bravo', 'charlie'], [], ['alpha', 'bravo', 'charlie'])
  game.state.view = 'playing'
  game.nextQuestion()
  return { game, advance: ms => { now += ms; game._tick() } }
}

globalThis.test.each(['wrong', 'timeout', 'unknown'])('%s 显示答案 10 秒后自动下一题，错词仍在队尾且不重复电击', reason => {
  const { game, advance } = reviewGame()
  const first = game.state.question.id
  game._wrongAnswer(reason, 0)
  assert.strictEqual(game.doc.getElementById('vg-answer-countdown').textContent, '10 秒后自动下一题')
  advance(9999)
  assert.strictEqual(game.state.view, 'answer')
  advance(1)
  assert.strictEqual(game.state.view, 'playing')
  assert.notStrictEqual(game.state.question.id, first)
  assert.strictEqual(game.queue.next(), 'charlie')
  assert.strictEqual(game.queue.next(), first)
  assert.strictEqual(game.doShock.mock.calls.length, 1)
})

test('手动继续后旧的答案倒计时不会再跳过一题', () => {
  const { game, advance } = reviewGame()
  game._wrongAnswer('wrong', 0)
  advance(3000)
  game.continueQuestion()
  const seq = game.state.questionSeq
  advance(7000)
  assert.strictEqual(game.state.questionSeq, seq)
  assert.strictEqual(game.state.view, 'playing')
})

test('答案展示暂停不推进，恢复后保留剩余展示时间', () => {
  const { game, advance } = reviewGame()
  game._wrongAnswer('wrong', 0)
  advance(4000)
  game.pause()
  advance(60000)
  assert.strictEqual(game.state.view, 'answer')
  game.resume()
  advance(5999)
  assert.strictEqual(game.state.view, 'answer')
  advance(1)
  assert.strictEqual(game.state.view, 'playing')
})

globalThis.test.each(['backToStart', 'emergencyStop'])('%s 后旧的答案倒计时不会重新启动学习', method => {
  const { game, advance } = reviewGame()
  game._wrongAnswer('wrong', 0)
  game[method]()
  advance(10000)
  assert.strictEqual(game.state.view, 'home')
  assert.strictEqual(game.state.question, null)
})

test('整体时间到时结束，不被答案自动下一题覆盖', () => {
  const { game, advance } = reviewGame()
  game._wrongAnswer('wrong', 0)
  game.state.totalEndsAt = game.state.answerEndsAt
  advance(10000)
  assert.strictEqual(game.state.view, 'home')
  assert.strictEqual(game.lastResult, 'ended')
})

test('全部点不认识并手动继续，循环一百题也不算完成或解锁', () => {
  const { game } = reviewGame()
  game.setLock = jest.fn()
  for (let i = 0; i < 100; i++) {
    game.markUnknown()
    game.continueQuestion()
  }
  assert.strictEqual(game.state.view, 'playing')
  assert.strictEqual(game.session.answers, 100)
  assert.deepStrictEqual(game.plan.done, [])
  assert.strictEqual(core.planRemaining(game.plan).length, 3)
  assert.strictEqual(game.lastResult, '')
  expect(game.setLock).not.toHaveBeenCalled()
})

test('全部不认识并自动继续，仅整体时限到才结束，今日任务保持未完成', () => {
  const { game, advance } = reviewGame()
  game.state.totalEndsAt = 1000 + 60000
  game.setLock = jest.fn()
  for (let i = 0; i < 5; i++) {
    game.markUnknown()
    advance(10000)
    assert.strictEqual(game.state.view, 'playing')
  }
  expect(game.setLock).not.toHaveBeenCalled()
  game.markUnknown()
  advance(10000)
  assert.strictEqual(game.state.view, 'home')
  assert.strictEqual(game.lastResult, 'ended')
  assert.deepStrictEqual(game.plan.done, [])
  assert.strictEqual(core.isPlanComplete(game.plan), false)
  assert.strictEqual(core.planRemaining(game.plan).length, 3)
  expect(game.setLock).toHaveBeenCalledWith(true)
})

test('学习页可以直接开启语音并识别第一个、第二个，关闭后释放录音', async () => {
  const game = makeGame({ deviceApi: { speech: { status: async () => ({ ready: true }), transcribe: async () => ({ text: '' }) } } })
  const calls = []
  game.state.view = 'playing'
  game.voice = { prime: () => calls.push('prime'), primeMic: async () => calls.push('mic'), start: async () => calls.push('start'), stop: async () => calls.push('stop') }
  await game.toggleVoice()
  assert.strictEqual(game.voiceOk, true)
  assert.strictEqual(game.save.settings.inputMode, 'voice')
  assert.strictEqual(game.doc.getElementById('vg-voice-toggle').textContent, '语音已开启')
  const answer = jest.fn()
  game.answer = answer
  game.state.questionSeq = 1
  game.state.question = { choices: [{}, {}] }
  game._onVoiceResult({ text: '第一个', seq: 1 })
  game._onVoiceResult({ text: '第二个', seq: 1 })
  expect(answer).toHaveBeenNthCalledWith(1, 1)
  expect(answer).toHaveBeenNthCalledWith(2, 2)
  await game.toggleVoice()
  assert.strictEqual(game.voiceOk, false)
  assert.strictEqual(game.save.settings.inputMode, 'touch')
  assert.ok(calls.includes('stop'))
})

async function waitFor(fn, timeout) {
  const started = Date.now()
  while (Date.now() - started < (timeout || 2000)) {
    if (fn()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return false
}

test('空计划首页显示今日已完成，不显示开始按钮', () => {
  const doc = fakeDoc()
  const game = makeGame({ document: doc })
  game.plan = { bank: 'cet4', ids: [], done: [], extra: 0, newIds: [], u: 1 }
  game._renderHome()
  assert.strictEqual(doc.getElementById('vg-task-main').hidden, true)
  assert.strictEqual(doc.getElementById('vg-task-done').hidden, false)
  assert.strictEqual(game.state.locked, null)
})

test('跨 04:00：答题中不打断当前题，答完当前题后按新一天重建计划', () => {
  let now = localMs(2026, 11, 1, 20, 0)
  const game = makeGame({ now: () => now })
  game.config.newPerDay = 2
  game._ensurePlan()
  assert.strictEqual(game.plan.ids.length, 2)
  const oldToday = game.today
  game.state.view = 'playing'
  game.state.questionSeq = 1
  game.state.question = { id: 'alpha', word: 'alpha', choices: [] }
  game.state.answered = false
  now = localMs(2026, 11, 2, 4, 1)

  game._tick()
  assert.strictEqual(game.state.question.id, 'alpha', '学习中途不应换题')
  assert.strictEqual(game.today, oldToday)

  game.state.answered = true
  game.queue = new core.QuizQueue([])
  game._afterCorrect(1)
  assert.strictEqual(game.today, core.dayIndex(now))
  assert.ok(game.save.plans[core.dateKey(now)], '新的一天应生成计划')
  assert.strictEqual(game.state.view, 'playing')
  assert.strictEqual(game.state.question.id, game.plan.ids[0])
})

test('回到首页跨过 04:00 也会按新一天重建计划', () => {
  let now = localMs(2026, 11, 1, 23, 0)
  const game = makeGame({ now: () => now })
  game._ensurePlan()
  game.plan.done = game.plan.ids.slice()
  game.state.view = 'playing'
  now = localMs(2026, 11, 2, 4, 2)
  game.backToStart()
  assert.strictEqual(game.today, core.dayIndex(now))
  assert.ok(game.save.plans[core.dateKey(now)])
  assert.deepStrictEqual(game.plan.done, [])
})

test('完成前先合并云端：合并后还有未答词就继续学习，不解锁', async () => {
  const now = localMs(2026, 11, 1, 9, 0)
  const key = core.dateKey(now)
  const lockCalls = []
  const cloud = {
    get: async () => ({
      version: 2,
      data: {
        v: 1,
        words: {},
        plans: { [key]: { bank: 'cet4', ids: ['alpha', 'bravo'], done: ['alpha'], extra: 0, newIds: ['bravo'], u: 5 } }
      }
    }),
    put: async () => ({ version: 3 })
  }
  const game = makeGame({ now: () => now, cloud: cloud })
  game.cloudVersion = 1
  seedPlan(game, ['alpha'], ['alpha'])
  game.state.view = 'playing'
  game.setLock = async open => { lockCalls.push(open) }

  const finished = await game.completePlan()
  assert.strictEqual(finished, false)
  assert.deepStrictEqual(lockCalls, [])
  assert.strictEqual(game.state.view, 'playing')
  assert.strictEqual(game.state.question.id, 'bravo')
  assert.deepStrictEqual(game.plan.ids, ['alpha', 'bravo'])
})

test('合并后确实完成才解锁并回首页', async () => {
  const now = localMs(2026, 11, 1, 9, 0)
  const lockCalls = []
  const cloud = { get: async () => ({ version: 2, data: { v: 1, words: {}, plans: {} } }), put: async () => ({ version: 3 }) }
  const game = makeGame({ now: () => now, cloud: cloud })
  seedPlan(game, ['alpha'], ['alpha'])
  game.state.view = 'playing'
  game.setLock = async open => { lockCalls.push(open) }
  await game.completePlan()
  assert.deepStrictEqual(lockCalls, [true])
  assert.strictEqual(game.state.view, 'home')
  assert.strictEqual(game.lastResult, 'complete')
})

test('暂停时不自动跳题，恢复后再继续', () => {
  const game = makeGame()
  seedPlan(game, ['alpha', 'bravo'])
  game.state.view = 'playing'
  game.state.questionSeq = 2
  game.state.answered = true
  game.state.question = { id: 'alpha' }
  game.state.paused = true
  game.state.pausedAt = 1000
  game.queue = new core.QuizQueue(['bravo'])
  let advanced = 0
  game.nextQuestion = () => { advanced += 1 }
  game._afterCorrect(2)
  assert.strictEqual(advanced, 0)
  assert.strictEqual(game.state.pendingAdvance, true)
  game.resume()
  assert.strictEqual(advanced, 1)
  assert.strictEqual(game.state.pendingAdvance, false)
})

test('上传期间的新改动不会被清 dirty 丢掉，上传结束后会再传一次', async () => {
  const puts = []
  let releaseFirst = null
  const cloud = {
    put: (data, version) => {
      puts.push(JSON.parse(JSON.stringify(data)))
      if (puts.length === 1) return new Promise(resolve => { releaseFirst = resolve })
      return Promise.resolve({ version: 2 })
    }
  }
  const game = makeGame({ cloud: cloud })
  game.save.words.alpha = { k: 1, due: 3, last: 1, wrong: 0, u: 1 }
  game._markDirty()
  const first = game._maybeUpload(true)
  assert.strictEqual(puts.length, 1)
  game.save.words.bravo = { k: 1, due: 4, last: 2, wrong: 0, u: 2 }
  game._markDirty()
  releaseFirst({ version: 1 })
  await first
  await waitFor(() => puts.length >= 2 && game.uploading === false)
  assert.ok(puts[1].words.bravo, '第二次上传应包含上传期间的改动')
  assert.strictEqual(game.dirty, false)
})

test('pagehide 时有未上传改动会立即发出', () => {
  const puts = []
  const game = makeGame({ cloud: { put: (data, version) => { puts.push({ data, version }); return Promise.resolve({ version: 2 }) } } })
  game.cloudVersion = 1
  game.save.words.alpha = { k: 1, due: 3, last: 1, wrong: 0, u: 1 }
  game._markDirty()
  game._onPageHide()
  assert.strictEqual(puts.length, 1)
  assert.ok(puts[0].data.words.alpha)
})

test('点「开始/继续学习」的手势里同时预热 AudioContext 和麦克风', () => {
  const doc = fakeDoc()
  const game = makeGame({ document: doc })
  let prime = 0
  let mic = 0
  game.voice = {
    prime() { prime += 1 },
    primeMic() { mic += 1; return Promise.resolve(null) },
    setSeq() {},
    ignoreUntil() {},
    stop() {}
  }
  game.signedIn = false
  game._bindUI()
  const button = doc.getElementById('vg-start-btn')
  game.voiceMode = false
  button.handlers.click()
  assert.strictEqual(prime, 1)
  assert.strictEqual(mic, 0, '点选模式不申请麦克风')
  game.voiceMode = true
  button.handlers.click()
  assert.strictEqual(prime, 2)
  assert.strictEqual(mic, 1)
})

test('自动进入：有历史且未完成时直接开始；语音模式起不来才显示点一下遮罩', async () => {
  const game = makeGame()
  game.autoStart = true
  game.voiceMode = false
  game.save.words.alpha = { k: 1, due: 3, last: 1, wrong: 0, u: 1 }
  game.plan = { bank: 'cet4', ids: ['bravo'], done: [], extra: 0, newIds: ['bravo'], u: 1 }
  let started = 0
  game._handleStart = async () => { started += 1; return true }
  assert.strictEqual(await game._maybeAutoEnter(), true)
  assert.strictEqual(started, 1)

  const doc = fakeDoc()
  const voiceGame = makeGame({ document: doc })
  voiceGame.autoStart = true
  voiceGame.voiceMode = true
  voiceGame.save.words.alpha = { k: 1, due: 3, last: 1, wrong: 0, u: 1 }
  voiceGame.plan = { bank: 'cet4', ids: ['bravo'], done: [], extra: 0, newIds: ['bravo'], u: 1 }
  let voiceStarted = 0
  voiceGame._handleStart = async () => { voiceStarted += 1; return true }
  voiceGame._tryPrimeWithoutGesture = async () => false
  assert.strictEqual(await voiceGame._maybeAutoEnter(), false)
  assert.strictEqual(voiceStarted, 0)
  assert.strictEqual(doc.getElementById('vg-gate').hidden, false)

  // 无手势也能起麦克风时（如 Electron），语音模式直接开始，不弹遮罩
  const doc2 = fakeDoc()
  const okGame = makeGame({ document: doc2 })
  okGame.autoStart = true
  okGame.voiceMode = true
  okGame.save.words.alpha = { k: 1, due: 3, last: 1, wrong: 0, u: 1 }
  okGame.plan = { bank: 'cet4', ids: ['bravo'], done: [], extra: 0, newIds: ['bravo'], u: 1 }
  let okStarted = 0
  okGame._handleStart = async () => { okStarted += 1; return true }
  okGame._tryPrimeWithoutGesture = async () => true
  assert.strictEqual(await okGame._maybeAutoEnter(), true)
  assert.strictEqual(okStarted, 1)
})

test('自动进入：今日已完成或没有学习记录时停在首页', async () => {
  const game = makeGame()
  game.autoStart = true
  let started = 0
  game._handleStart = async () => { started += 1; return true }
  game.save.words.alpha = { k: 1, due: 3, last: 1, wrong: 0, u: 1 }
  game.plan = { bank: 'cet4', ids: ['alpha'], done: ['alpha'], extra: 0, newIds: ['alpha'], u: 1 }
  assert.strictEqual(await game._maybeAutoEnter(), false)
  game.plan = { bank: 'cet4', ids: ['bravo'], done: [], extra: 0, newIds: ['bravo'], u: 1 }
  game.save.words = {}
  game.autoEntered = false
  assert.strictEqual(await game._maybeAutoEnter(), false)
  assert.strictEqual(started, 0)
})

test('游戏内改学习设置存云存档 settings，换词书会重建今日新词部分', () => {
  const storage = memoryStorage()
  const game = makeGame({ storage: storage })
  game.config.newPerDay = 2
  game._ensurePlan()
  const key = core.dateKey(game.now())
  game.plan.done = [game.plan.ids[0]]
  game._applySettingChange({ newPerDay: 3, bank: 'ielts', questionTime: 30 })
  assert.strictEqual(game.save.settings.newPerDay, 3)
  assert.strictEqual(game.save.settings.bank, 'ielts')
  assert.strictEqual(game.save.settings.questionTime, 30)
  assert.strictEqual(game.config.bank, 'ielts')
  assert.strictEqual(game.save.plans[key].bank, 'ielts')
  assert.ok(game.save.plans[key].ids.some(id => id === 'india'))
  assert.strictEqual(game.save.settings.u, 1000)
})

test('游戏内改电击：本机覆盖生效；宿主值变了以宿主为准并清掉覆盖', () => {
  const storage = memoryStorage()
  const game = makeGame({ storage: storage })
  game.hostParams = { shockVoltage: 15, shockDuration: 2 }
  game._applySettingChange({ shockVoltage: 40, shockDuration: 5 })
  assert.strictEqual(game.config.shockVoltage, 40)
  assert.strictEqual(game.config.shockDuration, 5)
  assert.strictEqual(game.dirty, false, '电击覆盖只存本机，不应标脏上传')
  const saved = JSON.parse(storage.getItem('vocab-game:shock:u1'))
  assert.strictEqual(saved.hostVoltage, 15)
  assert.strictEqual(saved.voltage, 40)

  const sameHost = makeGame({ storage: storage })
  sameHost.hostParams = { shockVoltage: 15, shockDuration: 2 }
  sameHost._applyShockSettings()
  assert.strictEqual(sameHost.config.shockVoltage, 40)
  assert.strictEqual(sameHost.config.shockDuration, 5)

  const changedHost = makeGame({ storage: storage })
  changedHost.hostParams = { shockVoltage: 20, shockDuration: 3 }
  changedHost._applyShockSettings()
  assert.strictEqual(changedHost.config.shockVoltage, 20)
  assert.strictEqual(changedHost.config.shockDuration, 3)
  assert.strictEqual(storage.getItem('vocab-game:shock:u1'), null)
})
