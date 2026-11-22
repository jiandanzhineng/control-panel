/**
 * 背单词游戏单测（纯逻辑 + 页面辅助函数）。
 * 覆盖 docs/plans/vocab-game.md 第 5 节第 1 条中属于游戏页面的项：
 * 干扰项规则、每日计划生成、04:00 换日、间隔翻倍与答错重置、
 * 同一天重复出现不改 k、错题回队尾、今日完成判定、存档合并、parseVoiceCommand。
 */
const assert = require('assert')
const core = require('../games/vocab-game/vocab-core.js')
const voice = require('../games/vocab-game/voice.js')
const gameModule = require('../games/vocab-game/game.js')
const test = (name, fn) => globalThis.test(name, fn)

function localMs(y, m, d, h, min) {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime()
}

function seeded(seed) {
  let state = seed >>> 0
  return function () {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const POS = ['n', 'v', 'adj', 'adv']
function fakeWord(i) {
  const pos = POS[i % POS.length]
  return {
    id: 'word' + i,
    word: 'word' + i,
    phonetic: 'wɜːd' + i,
    short: pos + '. 释义' + i,
    full: pos + '. 完整释义' + i + '；例句 ' + i
  }
}
function fakeBank(count) {
  const words = []
  for (let i = 0; i < count; i++) words.push(fakeWord(i))
  return words
}

console.log('\n[日期与间隔]')

test('04:00 换日：03:59 仍算前一天，04:00 进入新的一天', () => {
  const before = localMs(2026, 11, 1, 3, 59)
  const after = localMs(2026, 11, 1, 4, 0)
  assert.strictEqual(core.dateKey(before), '2026-10-31')
  assert.strictEqual(core.dateKey(after), '2026-11-01')
  assert.strictEqual(core.dayIndex(after) - core.dayIndex(before), 1)
  assert.strictEqual(core.indexToDateKey(core.dayIndex(after)), '2026-11-01')
  assert.strictEqual(core.dateKeyToIndex('2026-11-01'), core.dayIndex(after))
})

test('首答对：k 从 0 开始，间隔 1、2、4、8 天逐次翻倍', () => {
  const today = core.dayIndex(localMs(2026, 11, 1, 9, 0))
  let entry = null
  const expected = [1, 2, 4, 8, 16]
  for (let i = 0; i < expected.length; i++) {
    const result = core.updateWord(entry, {
      correct: true,
      today: today + i,
      now: localMs(2026, 11, 1 + i, 9, 0)
    })
    assert.strictEqual(result.first, true)
    entry = result.entry
    assert.strictEqual(entry.k, i + 1)
    assert.strictEqual(entry.due, today + i + expected[i])
  }
})

test('首答错：k 归零，明天到期，并累计错误次数', () => {
  const today = core.dayIndex(localMs(2026, 11, 1, 9, 0))
  const result = core.updateWord({ k: 5, due: today + 32, last: today - 32, wrong: 2, u: 1 }, {
    correct: false,
    today: today,
    now: 100
  })
  assert.strictEqual(result.first, true)
  assert.strictEqual(result.entry.k, 0)
  assert.strictEqual(result.entry.due, today + 1)
  assert.strictEqual(result.entry.wrong, 3)
  assert.strictEqual(result.entry.last, today)
  assert.strictEqual(result.entry.u, 100)
})

test('同一天再次出现：对错都不再改 k 和 due', () => {
  const today = core.dayIndex(localMs(2026, 11, 1, 9, 0))
  const first = core.updateWord(null, { correct: false, today: today, now: 10 }).entry
  const retryRight = core.updateWord(first, { correct: true, today: today, now: 20 })
  assert.strictEqual(retryRight.first, false)
  assert.strictEqual(retryRight.entry.k, 0)
  assert.strictEqual(retryRight.entry.due, today + 1)
  const retryWrong = core.updateWord(first, { correct: false, today: today, now: 30 })
  assert.strictEqual(retryWrong.entry.k, 0)
  assert.strictEqual(retryWrong.entry.due, today + 1)
  assert.strictEqual(retryWrong.entry.wrong, 2)
  assert.strictEqual(retryWrong.entry.u, 30)
})

test('recordAnswer 把结果写回存档 words', () => {
  const save = core.normalizeSave(null)
  const today = core.dayIndex(localMs(2026, 11, 1, 9, 0))
  const result = core.recordAnswer(save, 'apple', { correct: true, today: today, now: 99 })
  assert.strictEqual(result.first, true)
  assert.strictEqual(save.words.apple.k, 1)
  assert.strictEqual(save.words.apple.due, today + 1)
})

console.log('\n[每日计划]')

test('复习词按到期日从早到晚取，超过 reviewCap 的顺延', () => {
  const today = 20000
  const words = fakeBank(10)
  const progress = {}
  progress.word0 = { k: 1, due: today - 1, last: today - 2, wrong: 0, u: 1 }
  progress.word1 = { k: 1, due: today - 5, last: today - 6, wrong: 0, u: 1 }
  progress.word2 = { k: 1, due: today, last: today - 1, wrong: 0, u: 1 }
  progress.word3 = { k: 1, due: today + 1, last: today, wrong: 0, u: 1 }
  const plan = core.buildDailyPlan({
    bank: 'cet4',
    bankIds: words.map(w => w.id),
    progress: progress,
    today: today,
    now: 1,
    newPerDay: 0,
    reviewCap: 2,
    random: seeded(1)
  })
  assert.deepStrictEqual(plan.ids, ['word1', 'word0'])
  assert.strictEqual(plan.newIds.length, 0)
  assert.strictEqual(plan.done.length, 0)
})

test('新词只当前词库、按词库顺序，且别的词库学过的词不再算新词', () => {
  const today = 20000
  const bankIds = ['a', 'b', 'c', 'd', 'e']
  const progress = { a: { k: 1, due: today + 5, last: today, wrong: 0, u: 1 } }
  const plan = core.buildDailyPlan({
    bank: 'cet4',
    bankIds: bankIds,
    progress: progress,
    today: today,
    now: 1,
    newPerDay: 2,
    reviewCap: 0,
    random: seeded(2)
  })
  assert.deepStrictEqual(plan.ids, ['b', 'c'])
  assert.deepStrictEqual(plan.newIds, ['b', 'c'])
})

test('复习和新词混排时，新词不会连续扎堆', () => {
  const today = 20000
  const review = []
  const progress = {}
  for (let i = 0; i < 24; i++) {
    review.push('r' + i)
    progress['r' + i] = { k: 1, due: today - (i % 5), last: today - 1, wrong: 0, u: 1 }
  }
  const fresh = []
  for (let i = 0; i < 12; i++) fresh.push('n' + i)
  const plan = core.buildDailyPlan({
    bank: 'cet4',
    bankIds: review.concat(fresh),
    progress: progress,
    today: today,
    now: 1,
    newPerDay: 12,
    reviewCap: 100,
    random: seeded(3)
  })
  assert.strictEqual(plan.ids.length, 36)
  let run = 0
  let maxRun = 0
  plan.ids.forEach(id => {
    if (plan.newIds.includes(id)) {
      run += 1
      maxRun = Math.max(maxRun, run)
    } else {
      run = 0
    }
  })
  assert.ok(maxRun <= 2, '新词最多连续 ' + maxRun + ' 个')
  plan.ids.forEach(id => {
    if (plan.newIds.includes(id)) assert.ok(id.indexOf('n') === 0)
  })
})

test('计划状态：完成判定、剩余题数与新词/复习统计', () => {
  const plan = { bank: 'cet4', ids: ['a', 'b', 'c', 'd'], done: ['a', 'c'], extra: 0, newIds: ['c', 'd'], u: 1 }
  assert.strictEqual(core.isPlanComplete(plan), false)
  assert.deepStrictEqual(core.planRemaining(plan), ['b', 'd'])
  const stats = core.planStats(plan)
  assert.strictEqual(stats.newTotal, 2)
  assert.strictEqual(stats.newDone, 1)
  assert.strictEqual(stats.reviewTotal, 2)
  assert.strictEqual(stats.reviewDone, 1)
  assert.strictEqual(stats.remaining, 2)
  plan.done.push('b', 'd')
  assert.strictEqual(core.isPlanComplete(plan), true)
  assert.strictEqual(core.planStats(plan).remaining, 0)
})

test('再学一组只追加没学过的新词，extra 加一；没有新词时 added=0', () => {
  const today = 20000
  const bankIds = ['a', 'b', 'c', 'd', 'e', 'f']
  const progress = { a: { k: 1, due: today + 1, last: today, wrong: 0, u: 1 } }
  const base = { bank: 'cet4', ids: ['a'], done: ['a'], extra: 0, newIds: ['a'], u: 1 }
  const first = core.buildExtraPlan(base, { bankIds: bankIds, progress: progress, newPerDay: 2, now: 5 })
  assert.strictEqual(first.added, 2)
  assert.deepStrictEqual(first.plan.ids, ['a', 'b', 'c'])
  assert.strictEqual(first.plan.extra, 1)
  const second = core.buildExtraPlan(first.plan, { bankIds: bankIds, progress: progress, newPerDay: 10, now: 6 })
  assert.deepStrictEqual(second.plan.ids, ['a', 'b', 'c', 'd', 'e', 'f'])
  const noMore = core.buildExtraPlan(second.plan, { bankIds: bankIds, progress: progress, newPerDay: 10, now: 7 })
  assert.strictEqual(noMore.added, 0)
  assert.strictEqual(noMore.plan, second.plan)
})

console.log('\n[队列与存档]')

test('答错/超时/不认识的词排到队尾，答对正常出队', () => {
  const queue = new core.QuizQueue(['a', 'b', 'c'])
  assert.strictEqual(queue.next(), 'a')
  queue.requeue('a')
  assert.deepStrictEqual(queue.remaining(), ['b', 'c', 'a'])
  assert.strictEqual(queue.next(), 'b')
  assert.strictEqual(queue.remaining().length, 2)
  assert.strictEqual(new core.QuizQueue([]).next(), null)
})

test('存档合并：每个词取 u 大的，同一天计划取 ids/done 并集并保留先到顺序', () => {
  const local = {
    v: 1,
    words: {
      a: { k: 1, due: 10, last: 9, wrong: 0, u: 100 },
      b: { k: 2, due: 30, last: 9, wrong: 0, u: 100 }
    },
    plans: {
      '2026-11-01': { bank: 'cet4', ids: ['a', 'b'], done: ['a'], extra: 0, newIds: ['b'], u: 100 }
    }
  }
  const remote = {
    v: 1,
    words: {
      a: { k: 3, due: 50, last: 9, wrong: 1, u: 200 },
      c: { k: 1, due: 11, last: 10, wrong: 0, u: 150 }
    },
    plans: {
      '2026-11-01': { bank: 'cet6', ids: ['c', 'a'], done: ['c'], extra: 1, newIds: ['c'], u: 300 }
    }
  }
  const merged = core.mergeSaves(local, remote)
  assert.strictEqual(merged.words.a.k, 3)
  assert.strictEqual(merged.words.a.u, 200)
  assert.strictEqual(merged.words.b.u, 100)
  assert.strictEqual(merged.words.c.k, 1)
  assert.deepStrictEqual(merged.plans['2026-11-01'].ids, ['a', 'b', 'c'])
  assert.deepStrictEqual(merged.plans['2026-11-01'].done, ['a', 'c'])
  assert.deepStrictEqual(merged.plans['2026-11-01'].newIds, ['b', 'c'])
  assert.strictEqual(merged.plans['2026-11-01'].extra, 1)
  assert.strictEqual(merged.plans['2026-11-01'].bank, 'cet4')
  assert.strictEqual(merged.plans['2026-11-01'].u, 300)
})

test('存档清洗：坏数据不崩，重复 ids 去重', () => {
  const save = core.normalizeSave({
    words: { A: { k: '2', due: '5' }, bad: null },
    plans: { '2026-11-01': { ids: ['a', 'a', 'b'], done: ['b', 'b'] }, nope: { ids: [] } }
  })
  assert.ok(save.words.a)
  assert.strictEqual(save.words.a.k, 2)
  assert.ok(!save.words.bad)
  assert.deepStrictEqual(save.plans['2026-11-01'].ids, ['a', 'b'])
  assert.deepStrictEqual(save.plans['2026-11-01'].done, ['b'])
  assert.ok(!save.plans.nope)
})

test('只保留最近 7 天（含今天）的计划', () => {
  const today = core.dayIndex(localMs(2026, 11, 1, 12, 0))
  const plans = {}
  for (let i = 0; i < 10; i++) plans[core.indexToDateKey(today - i)] = { ids: ['a'], done: [] }
  const pruned = core.pruneSave({ words: {}, plans: plans }, today)
  assert.strictEqual(Object.keys(pruned.plans).length, 7)
  assert.ok(pruned.plans[core.indexToDateKey(today)])
  assert.ok(pruned.plans[core.indexToDateKey(today - 6)])
  assert.ok(!pruned.plans[core.indexToDateKey(today - 7)])
})

console.log('\n[干扰项]')

test('4 个选项：包含正确项、文本互不相同且不互相包含', () => {
  const words = fakeBank(20)
  const random = seeded(10)
  for (let round = 0; round < 20; round++) {
    const correct = words[round % words.length]
    const options = core.buildChoices(words, correct.id, random, 4)
    assert.strictEqual(options.length, 4)
    const correctOptions = options.filter(o => o.correct)
    assert.strictEqual(correctOptions.length, 1)
    assert.strictEqual(correctOptions[0].text, correct.short)
    const texts = options.map(o => o.text)
    assert.strictEqual(new Set(texts).size, 4)
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        assert.ok(!core.meaningsOverlap(texts[i], texts[j]), texts[i] + ' 与 ' + texts[j] + ' 不应互相包含')
      }
    }
  }
})

test('干扰项优先取和正确答案首个词性相同的词', () => {
  const correct = { id: 'target', short: 'n. 目标' }
  const words = [
    correct,
    { id: 'n1', short: 'n. 苹果' },
    { id: 'n2', short: 'n. 香蕉' },
    { id: 'n3', short: 'n. 橘子' },
    { id: 'v1', short: 'v. 跑' },
    { id: 'v2', short: 'v. 跳' }
  ]
  const options = core.buildChoices(words, 'target', seeded(11), 4)
  const picked = options.filter(o => !o.correct).map(o => o.id)
  assert.deepStrictEqual(picked.sort(), ['n1', 'n2', 'n3'])
})

test('同词性不够时用其他词性补足，正确词不存在时返回空数组', () => {
  const words = [
    { id: 'target', short: 'adj. 好的' },
    { id: 'a1', short: 'adj. 坏的' },
    { id: 'v1', short: 'v. 跑' },
    { id: 'n1', short: 'n. 苹果' }
  ]
  const options = core.buildChoices(words, 'target', seeded(12), 4)
  assert.strictEqual(options.length, 4)
  assert.ok(options.some(o => o.id === 'a1'))
  assert.ok(options.some(o => o.id === 'v1'))
  assert.ok(options.some(o => o.id === 'n1'))
  assert.deepStrictEqual(core.buildChoices(words, 'missing', seeded(13), 4), [])
})

console.log('\n[语音口令]')

test('选项口令：第一个/第一/一个/一号/1/A 与常见同音字', () => {
  const cases = {
    '第一个': 1, '第一': 1, '一个': 1, '一号': 1, '1': 1, 'A': 1, 'a': 1, '衣': 1, '医': 1,
    '第二个': 2, '第二': 2, '二号': 2, '2': 2, 'B': 2, '儿': 2, '而': 2,
    '第三个': 3, '第三': 3, '三号': 3, '3': 3, 'C': 3, '山': 3, '伞': 3,
    '第四个': 4, '第四': 4, '四号': 4, '4': 4, 'D': 4, '寺': 4, '似': 4,
    '第3个': 3, '选B': 2,
    // 本地识别会把「第二个」输出成「2个」或「两个」。
    '2个': 2, '第2个': 2, '两个': 2, '两': 2
  }
  Object.keys(cases).forEach(text => {
    const result = core.parseVoiceCommand(text)
    assert.strictEqual(result.action, 'choice', text)
    assert.strictEqual(result.index, cases[text], text)
  })
})

test('「不认识」「继续」等动作口令', () => {
  ;['不认识', '不会', '不知道', '不记得', '忘了'].forEach(text => {
    assert.strictEqual(core.parseVoiceCommand(text).action, 'unknown', text)
  })
  ;['继续', '下一个', '下一题', '继续吧'].forEach(text => {
    assert.strictEqual(core.parseVoiceCommand(text).action, 'continue', text)
  })
})

test('单独一个「是」不当成四；多个选项或混合意图忽略', () => {
  assert.strictEqual(core.parseVoiceCommand('是').action, 'ignore')
  assert.strictEqual(core.parseVoiceCommand('第一个第二个').action, 'ignore')
  assert.strictEqual(core.parseVoiceCommand('第一个，继续').action, 'ignore')
  assert.strictEqual(core.parseVoiceCommand('').action, 'ignore')
  assert.strictEqual(core.parseVoiceCommand('今天天气不错').action, 'ignore')
})

test('语音结果带标点/空格也能解析', () => {
  assert.deepStrictEqual(core.parseVoiceCommand(' 第 一 个。'), { action: 'choice', index: 1 })
  assert.strictEqual(core.parseVoiceCommand('不认识！').action, 'unknown')
  assert.strictEqual(core.parseVoiceCommand('下一题。').action, 'continue')
})

console.log('\n[页面辅助函数]')

test('测试音频参数 vgTestAudio 解析', () => {
  assert.strictEqual(voice.parseTestAudio('?vgTestAudio=cmd.wav'), 'cmd.wav')
  assert.strictEqual(voice.parseTestAudio('?vgTestAudio=https%3A%2F%2Fexample.com%2Fa.wav'), 'https://example.com/a.wav')
  assert.strictEqual(voice.parseTestAudio('?rgTestAudio=old.wav'), '')
  assert.strictEqual(voice.parseTestAudio(''), '')
})

test('词库条目兼容 4 元组和旧的 3 元组', () => {
  const words = core.normalizeBank({
    words: [
      ['apple', 'ˈæpl', 'n. 苹果', 'n. 苹果；苹果树'],
      ['run', 'rʌn', 'v. 跑']
    ]
  })
  assert.strictEqual(words.length, 2)
  assert.strictEqual(words[0].short, 'n. 苹果')
  assert.strictEqual(words[0].full, 'n. 苹果；苹果树')
  assert.strictEqual(words[1].full, 'v. 跑')
  assert.strictEqual(words[0].id, 'apple')
})

test('时长与音标格式化', () => {
  assert.strictEqual(gameModule.formatDuration(65000), '1:05')
  assert.strictEqual(gameModule.formatDuration(0), '0:00')
  assert.strictEqual(gameModule.formatPhonetic('ˈæpl'), '/ˈæpl/')
  assert.strictEqual(gameModule.formatPhonetic('/ˈæpl/'), '/ˈæpl/')
  assert.strictEqual(gameModule.formatPhonetic(''), '')
})

console.log('\n[空计划与设置]')

test('空计划（没有新词也没有到期复习）算今日完成', () => {
  const plan = { bank: 'cet4', ids: [], done: [], extra: 0, newIds: [], u: 1 }
  assert.strictEqual(core.isPlanComplete(plan), true)
  assert.strictEqual(core.planStats(plan).remaining, 0)
  assert.strictEqual(core.isPlanComplete(null), false)
})

test('旧存档没有 settings 时补默认值，设置合并取 u 大的那份', () => {
  const old = core.normalizeSave({ words: { a: { k: 1, due: 3, last: 1 } }, plans: {} })
  assert.deepStrictEqual(
    { bank: old.settings.bank, newPerDay: old.settings.newPerDay, inputMode: old.settings.inputMode },
    { bank: 'cet4', newPerDay: 20, inputMode: 'voice' }
  )
  assert.strictEqual(core.normalizeSettings({ inputMode: 'touch' }).inputMode, 'touch')
  const newer = { v: 1, words: {}, plans: {}, settings: { bank: 'ielts', newPerDay: 50, u: 200 } }
  const older = { v: 1, words: {}, plans: {}, settings: { bank: 'cet6', newPerDay: 10, u: 100 } }
  assert.strictEqual(core.mergeSaves(older, newer).settings.bank, 'ielts')
  assert.strictEqual(core.mergeSaves(newer, older).settings.bank, 'ielts')
})

test('updateSettings 只接受白名单字段并限制范围', () => {
  const next = core.updateSettings({ bank: 'cet4', newPerDay: 20, u: 1 }, {
    newPerDay: 999,
    reviewCap: -3,
    questionTime: 30,
    inputMode: 'voice',
    autoSpeak: false,
    hacker: true
  }, 50)
  assert.strictEqual(next.newPerDay, 200)
  assert.strictEqual(next.reviewCap, 0)
  assert.strictEqual(next.questionTime, 30)
  assert.strictEqual(next.inputMode, 'voice')
  assert.strictEqual(next.autoSpeak, false)
  assert.strictEqual(next.u, 50)
  assert.strictEqual(next.hacker, undefined)
})

console.log('\n[当天改设置]')

test('换词书：复习词和已答过的词不动，没答过的新词换成新词库', () => {
  const today = 20000
  const old = {
    bank: 'cet4',
    ids: ['r1', 'n1', 'n2', 'n3'],
    done: ['n1'],
    extra: 0,
    newIds: ['n1', 'n2', 'n3'],
    u: 1
  }
  const progress = { n1: { k: 1, due: today + 2, last: today, wrong: 0, u: 2 } }
  const next = core.rebuildPlan(old, {
    bank: 'ielts',
    bankIds: ['x1', 'x2', 'x3'],
    progress: progress,
    today: today,
    now: 9,
    newPerDay: 3
  })
  assert.deepStrictEqual(next.ids, ['r1', 'n1', 'x1', 'x2'])
  assert.deepStrictEqual(next.newIds, ['n1', 'x1', 'x2'])
  assert.strictEqual(next.bank, 'ielts')
  assert.strictEqual(next.u, 9)
})

test('同词库改每日新词数：保留没答过的新词，超出上限裁掉，增加则补齐', () => {
  const today = 20000
  const progress = {}
  const base = { bank: 'cet4', ids: ['n1', 'n2', 'n3'], done: [], extra: 0, newIds: ['n1', 'n2', 'n3'], u: 1 }
  const shrunk = core.rebuildPlan(base, {
    bank: 'cet4', bankIds: ['n1', 'n2', 'n3', 'n4', 'n5'], progress: progress, today: today, now: 2, newPerDay: 2
  })
  assert.deepStrictEqual(shrunk.ids, ['n1', 'n2'])
  const grown = core.rebuildPlan(shrunk, {
    bank: 'cet4', bankIds: ['n1', 'n2', 'n3', 'n4', 'n5'], progress: progress, today: today, now: 3, newPerDay: 4
  })
  assert.deepStrictEqual(grown.ids, ['n1', 'n2', 'n3', 'n4'])
})

console.log('\n[电击本机覆盖]')

test('游戏内电击设置只在本机覆盖，宿主值变了以宿主为准', () => {
  const host = { shockVoltage: 15, shockDuration: 2 }
  const local = { hostVoltage: 15, hostDuration: 2, voltage: 40, duration: 5 }
  const same = core.resolveShockSettings(host, local)
  assert.strictEqual(same.voltage, 40)
  assert.strictEqual(same.duration, 5)
  assert.ok(same.override)

  const hostChanged = core.resolveShockSettings({ shockVoltage: 20, shockDuration: 2 }, local)
  assert.strictEqual(hostChanged.voltage, 20)
  assert.strictEqual(hostChanged.duration, 2)
  assert.strictEqual(hostChanged.override, null)

  const noOverride = core.resolveShockSettings(host, null)
  assert.strictEqual(noOverride.voltage, 15)
  assert.strictEqual(noOverride.duration, 2)
})
