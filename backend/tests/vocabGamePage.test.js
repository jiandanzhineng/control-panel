/**
 * 背单词游戏页面编排的过期结果测试：语音结果和 0.6 秒自动跳题都带题目序号，
 * 旧题目的回调必须丢弃（docs/plans/vocab-game.md 任务要求）。
 */
const assert = require('assert')
const { VocabGame } = require('../games/vocab-game/game.js')
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
