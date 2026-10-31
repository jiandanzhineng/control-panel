/**
 * 朗读游戏 Jest 单测。
 * 原版 test/reading-game/unit.js 的 58 项全部迁移（其中 2 项主进程看门狗用例改由宿主承担，
 * 此处替换为迁移后的 IO 层用例），对象换成 reading-core.js 与 game.js 的编排逻辑。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const core = require('../games/reading-game/reading-core.js')
const pinyinService = require('../games/reading-game/pinyin.js')
const builtinTexts = require('../games/reading-game/texts.js')
const { ReadingGame, parseTestAudio } = require('../games/reading-game/game.js')
const { ReadingAligner, ReadingTriggerMachine, RG_CONST } = core
const test = (name, fn) => globalThis.test(name, fn)

const texts = builtinTexts
const SOURCE = texts[0].text
const OTHER = texts[1].text
const sourceSyllables = pinyinService.textToPinyin(SOURCE).syllables
const sentences = SOURCE.split(/(?<=[。！？])/).filter(s => s.trim())
const sentenceSyllables = sentences.map(s => pinyinService.textToPinyin(s).syllables)

function alignText (text, pos, aligner) {
  return (aligner || new ReadingAligner(sourceSyllables))
    .align(pinyinService.textToPinyin(text).syllables, pos)
}

function cumulativeSyllables (count) {
  let n = 0
  for (let i = 0; i < count && i < sentenceSyllables.length; i++) n += sentenceSyllables[i].length
  return n
}

const HOMOPHONES = {
  的: '得', 在: '再', 时: '十', 好: '号', 一: '衣', 起: '启',
  读: '毒', 天: '添', 气: '器', 我: '握', 们: '门', 你: '尼',
  长: '常', 里: '李', 那: '拿', 知: '之', 书: '舒', 完: '玩'
}

function replaceChars (text, map) {
  return Array.from(text).map(ch => map[ch] || ch).join('')
}

console.log('\n[对齐器单元测试]')

test('逐句朗读：位置按句子依次前进', () => {
  const al = new ReadingAligner(sourceSyllables)
  let pos = 0
  sentenceSyllables.forEach((syl, i) => {
    const r = al.align(syl, pos)
    assert.strictEqual(r.verdict, 'reading', '第 ' + (i + 1) + ' 句判定')
    assert.ok(r.advanced, '第 ' + (i + 1) + ' 句应前进')
    const expected = cumulativeSyllables(i + 1)
    assert.ok(Math.abs(r.newPos - expected) <= 1, '位置 ' + r.newPos + ' 期望 ' + expected)
    pos = r.newPos
  })
  assert.ok(pos >= sourceSyllables.length - 1, '最终应读完全文')
})

test('同音字替换不误判为离稿', () => {
  const al = new ReadingAligner(sourceSyllables)
  let pos = 0
  sentenceSyllables.forEach((syl, i) => {
    const sent = sentences[i]
    const variant = replaceChars(sent, HOMOPHONES)
    if (variant === sent) return
    const r = alignText(variant, pos, al)
    assert.strictEqual(r.verdict, 'reading', '第 ' + (i + 1) + ' 句同音字判定')
    assert.ok(r.newPos >= cumulativeSyllables(i + 1) - 2, '同音字后位置应前移')
    pos = Math.max(pos, r.newPos)
  })
})

test('漏字（去掉部分字符）仍判定在读且前进', () => {
  const al = new ReadingAligner(sourceSyllables)
  const sent = sentences[0] + sentences[1]
  const chars = Array.from(sent)
  const dropped = chars.filter((ch, i) => i % 5 !== 2).join('')
  const r = alignText(dropped, 0, al)
  assert.strictEqual(r.verdict, 'reading')
  assert.ok(r.advanced)
  assert.ok(r.newPos >= 20, '漏字后位置 ' + r.newPos)
})

test('多字（插入嗯、那个）仍判定在读且前进', () => {
  const al = new ReadingAligner(sourceSyllables)
  const sent = sentences[0] + sentences[1] + sentences[2]
  const chars = Array.from(sent)
  const extra = chars.map((ch, i) => (i % 9 === 4 ? '嗯那个' + ch : ch)).join('')
  const r = alignText(extra, 0, al)
  assert.strictEqual(r.verdict, 'reading')
  assert.ok(r.advanced)
  assert.ok(r.newPos >= cumulativeSyllables(2) - 2, '多字后位置 ' + r.newPos)
})

test('n/l、zh/z、sh/s 混淆仍判定在读且前进', () => {
  const al = new ReadingAligner(sourceSyllables)
  const confusions = { 那: '拉', 念: '练', 能: '棱', 知: '资', 长: '藏', 是: '四', 时: '丝', 中: '宗' }
  let pos = 0
  sentenceSyllables.forEach((syl, i) => {
    const variant = replaceChars(sentences[i], confusions)
    const r = alignText(variant, pos, al)
    assert.strictEqual(r.verdict, 'reading', '第 ' + (i + 1) + ' 句模糊音判定')
    if (variant !== sentences[i]) {
      assert.ok(r.newPos >= pos, '模糊音后位置不应后退')
    }
    pos = r.newPos
  })
})

test('跳过一句：位置直接前进到后面那句', () => {
  const al = new ReadingAligner(sourceSyllables)
  const first = al.align(sentenceSyllables[0], 0)
  const r = alignText(sentences[2], first.newPos, al)
  assert.strictEqual(r.verdict, 'reading')
  assert.ok(r.advanced)
  const expected = cumulativeSyllables(3)
  assert.ok(Math.abs(r.newPos - expected) <= 3, '跳句后位置 ' + r.newPos + ' 期望约 ' + expected)
})

test('重读上一句：判定在读、位置不回退，继续读下一句仍能前进', () => {
  const al = new ReadingAligner(sourceSyllables)
  let pos = 0
  for (let i = 0; i < 2; i++) {
    const r = al.align(sentenceSyllables[i], pos)
    pos = r.newPos
  }
  const replay = alignText(sentences[1], pos, al)
  assert.strictEqual(replay.verdict, 'reading', '重读不应判为离稿')
  assert.strictEqual(replay.advanced, false)
  assert.strictEqual(replay.newPos, pos, '位置不能回退')
  const next = alignText(sentences[2], pos, al)
  assert.strictEqual(next.verdict, 'reading')
  assert.ok(next.advanced)
  assert.ok(next.newPos > pos)
})

test('完全无关文本：判定离稿且不前进', () => {
  const al = new ReadingAligner(sourceSyllables)
  const r = alignText(OTHER, 100, al)
  assert.strictEqual(r.verdict, 'offtext', '无关文本应判离稿')
  assert.strictEqual(r.advanced, false)
  assert.strictEqual(r.newPos, 100)
})

test('短片段（<6 音节）与空结果：unknown，且不判离稿', () => {
  const al = new ReadingAligner(sourceSyllables)
  const short = alignText('苹果香蕉', 10, al)
  assert.strictEqual(short.verdict, 'unknown')
  assert.strictEqual(short.newPos, 10)
  const empty = al.align([], 10)
  assert.strictEqual(empty.verdict, 'unknown')
})

test('半句朗读：在读且前进', () => {
  const al = new ReadingAligner(sourceSyllables)
  const half = Array.from(sentences[0]).slice(0, Math.floor(sentences[0].length / 2)).join('')
  const r = alignText(half, 0, al)
  assert.strictEqual(r.verdict, 'reading')
  assert.ok(r.advanced)
  assert.ok(r.newPos > 3)
})

console.log('\n[状态机单元测试]')

function newMachine (overrides) {
  const cfg = Object.assign({
    silenceLimit: 6,
    stallLimit: 20,
    warnLead: 2,
    cooldown: 5,
    startGrace: 5,
    checkContent: true,
    stallAdvanceChars: 5,
    stallBadSegments: 3,
    maxShocksPerMinute: 6,
    maxTickGapMs: 1e9
  }, overrides || {})
  const m = new ReadingTriggerMachine(cfg, () => 0)
  m.reset(0)
  return m
}

test('T1：沉默 6 秒，提前 2 秒警告，按时电击', () => {
  const m = newMachine()
  assert.strictEqual(m.tick(4999).action, 'none', '宽限期内不警告')
  const warn = m.tick(5000)
  assert.strictEqual(warn.action, 'warn-start')
  assert.strictEqual(warn.reason, 'T1')
  assert.strictEqual(m.tick(6999).action, 'warning')
  const shock = m.tick(7000)
  assert.strictEqual(shock.action, 'shock')
  assert.strictEqual(shock.reason, 'T1')
  assert.strictEqual(m.shockCount, 1)
})

test('T1：警告期间出声立即取消', () => {
  const m = newMachine()
  m.tick(5000)
  assert.ok(m.warning)
  const cancel = m.setVoice(5500)
  assert.strictEqual(cancel.action, 'cancel')
  assert.strictEqual(m.tick(5500).action, 'none')
  assert.strictEqual(m.tick(6000).action, 'none')
  assert.strictEqual(m.shockCount, 0)
})

test('电击后 5 秒冷却，冷却结束重新开始 T1 判定', () => {
  const m = newMachine()
  m.tick(5000)
  m.tick(7000)
  assert.strictEqual(m.shockCount, 1)
  assert.strictEqual(m.tick(11999).action, 'none', '冷却中不判定')
  const warn = m.tick(12000)
  assert.strictEqual(warn.action, 'warn-start')
  const shock = m.tick(14000)
  assert.strictEqual(shock.action, 'shock')
  assert.strictEqual(m.shockCount, 2)
})

test('每分钟最多 6 次电击，第 7 次只冷却不电击', () => {
  const m = newMachine({ silenceLimit: 2, warnLead: 0.5, cooldown: 1, startGrace: 0 })
  let shocks = 0
  let limited = false
  for (let t = 0; t < 60000; t += 100) {
    const a = m.tick(t)
    if (a.action === 'shock') shocks += 1
    if (a.action === 'limit') { limited = true; break }
  }
  assert.strictEqual(shocks, 6, '一分钟内应恰好 6 次电击')
  assert.ok(limited, '第 7 次应触发限流')
  assert.strictEqual(m.shockCount, 6)
})

test('unknown 永远不触发惩罚，连续 3 次后降级', () => {
  const m = newMachine()
  for (let t = 0; t <= 30000; t += 50) {
    m.setVoice(t)
    if (t === 1000 || t === 2000 || t === 3000) {
      m.onSegment(t, { verdict: 'unknown' })
    }
    const a = m.tick(t)
    assert.notStrictEqual(a.action, 'shock', 'unknown 不应导致电击')
    assert.notStrictEqual(a.action, 'warn-start', 'unknown 不应触发警告')
  }
  assert.strictEqual(m.shockCount, 0)
  assert.strictEqual(m.degraded, true, '连续 3 次 unknown 应降级')
})

function runT2Scenario (m, endTime, offtextTimes) {
  const events = []
  for (let t = 0; t <= endTime; t += 100) {
    m.setVoice(t)
    m.setAudioNow(t)
    if (offtextTimes.indexOf(t) >= 0) m.onSegment(t, { verdict: 'offtext', audioStartMs: t, audioEndMs: t })
    const a = m.tick(t)
    if (a.action === 'warn-start' || a.action === 'shock' || a.action === 'limit') {
      events.push(Object.assign({ t }, a))
    }
  }
  return events
}

test('T2：持续离稿 20 秒后警告，2 秒后电击', () => {
  const m = newMachine()
  const events = runT2Scenario(m, 24000, [3000, 6000, 9000, 12000, 15000, 18000, 21000])
  const warn = events.find(e => e.action === 'warn-start')
  const shock = events.find(e => e.action === 'shock')
  assert.ok(warn, '应出现 T2 警告')
  assert.strictEqual(warn.reason, 'T2')
  assert.ok(warn.t >= 20000 && warn.t <= 20100, '警告时间 ' + warn.t)
  assert.ok(shock, '应出现 T2 电击')
  assert.strictEqual(shock.reason, 'T2')
  assert.ok(shock.t >= 22000 && shock.t <= 23000, '电击时间 ' + shock.t)
  assert.strictEqual(m.shockCount, 1)
})

test('T2：警告期间位置前进立即取消', () => {
  const m = newMachine()
  runT2Scenario(m, 20000, [3000, 6000, 9000, 12000, 15000, 18000])
  assert.ok(m.warning && m.warning.reason === 'T2')
  m.setPosition(20100, 8)
  assert.strictEqual(m.warning, null)
  m.setVoice(20200)
  assert.notStrictEqual(m.tick(22000).action, 'shock')
  assert.strictEqual(m.shockCount, 0)
})

test('降级期间关闭 T2；识别恢复后自动重新开启', () => {
  const m = newMachine()
  for (let t = 0; t <= 21000; t += 100) {
    m.setVoice(t)
    if (t === 1000 || t === 2000 || t === 3000) m.onSegment(t, { verdict: 'unknown' })
    const a = m.tick(t)
    assert.notStrictEqual(a.action, 'warn-start', '降级期间不应出现 T2 警告')
  }
  assert.strictEqual(m.degraded, true)
  m.onSegment(21000, { verdict: 'reading', advanced: false })
  assert.strictEqual(m.degraded, false, '成功识别后应恢复')
  const events = runT2Scenario(m, 31000, [24000, 27000, 30000])
  const warn = events.find(e => e.action === 'warn-start')
  assert.ok(warn, '恢复后应重新启用 T2')
  assert.strictEqual(warn.reason, 'T2')
})

test('关闭内容检测后不会触发 T2', () => {
  const m = newMachine({ checkContent: false })
  const events = runT2Scenario(m, 30000, [3000, 6000, 9000, 12000, 15000, 18000, 21000, 24000, 27000])
  assert.strictEqual(events.filter(e => e.action === 'warn-start').length, 0)
  assert.strictEqual(m.shockCount, 0)
})

test('识别延迟过高时暂停 T2，恢复后重新开启', () => {
  const m = newMachine()
  m.setTransportOk(false)
  const slow = runT2Scenario(m, 30000, [3000, 6000, 9000, 12000, 15000, 18000, 21000, 24000, 27000])
  assert.strictEqual(slow.filter(e => e.action === 'warn-start').length, 0, '慢速识别期间不应出现 T2 警告')
  assert.strictEqual(m.shockCount, 0)
  m.setTransportOk(true)
  const later = runT2Scenario(m, 55000, [31000, 34000, 37000, 40000, 43000, 46000, 49000])
  const warn = later.find(e => e.action === 'warn-start')
  assert.ok(warn, '识别恢复后应重新启用 T2')
  assert.strictEqual(warn.reason, 'T2')
})

test('临近结尾有识别在途时暂缓 T1；在途结束后恢复', () => {
  const m = newMachine()
  m.setTailGuard(true)
  assert.notStrictEqual(m.tick(5000).action, 'warn-start', '结尾保护期间不应开始 T1 警告')
  m.setTailGuard(false)
  assert.strictEqual(m.tick(5100).action, 'warn-start', '在途请求结束后应恢复 T1')
  m.setTailGuard(true)
  assert.strictEqual(m.tick(5200).action, 'cancel', '进入结尾保护时应取消 T1 警告')
})

test('麦克风暂停期间不判定沉默，恢复后有宽限', () => {
  const m = newMachine()
  m.setPaused(0, true)
  assert.strictEqual(m.tick(20000).action, 'paused')
  m.setPaused(20000, false)
  assert.strictEqual(m.tick(22000).action, 'none', '恢复后 2 秒仍在宽限期')
  assert.strictEqual(m.shockCount, 0)
})

test('等待结束立即给满警告，不按旧时间直接电击', () => {
  const m = newMachine()
  m.setVoice(6000)
  for (let t = 6050; t <= 20000; t += 50) {
    m.setTailGuard(true, t)
    assert.notStrictEqual(m.tick(t).action, 'shock')
  }
  m.setTailGuard(false, 20000)
  const warn = m.tick(20050)
  assert.strictEqual(warn.action, 'warn-start', '等待结束应立即开始警告')
  assert.ok(warn.remaining >= 1950, '剩余 ' + warn.remaining)
  let shockAt = null
  for (let t = 20100; t <= 22200; t += 50) {
    if (m.tick(t).action === 'shock') { shockAt = t; break }
  }
  assert.ok(shockAt >= 22000 && shockAt <= 22050, '电击时间 ' + shockAt)
})

test('cooldown 大于 silenceLimit 时每次 T1 仍有完整警告', () => {
  const m = newMachine({ cooldown: 10, maxTickGapMs: 1e9 })
  let warned = null
  let sawShock = false
  for (let t = 0; t <= 30000; t += 50) {
    const a = m.tick(t)
    if (a.action === 'warn-start') {
      warned = t
      assert.ok(a.remaining >= 1950, '警告剩余 ' + a.remaining)
    }
    if (a.action === 'shock' && warned != null) {
      assert.ok(t - warned >= 1900, '警告时长 ' + (t - warned))
      sawShock = true
    }
  }
  assert.ok(sawShock)
})

test('startGrace 大于 silenceLimit 时仍有完整警告', () => {
  const m = newMachine({ startGrace: 30, maxTickGapMs: 1e9 })
  let warned = null
  let shockAt = null
  for (let t = 0; t <= 34000; t += 50) {
    const a = m.tick(t)
    if (a.action === 'warn-start') {
      warned = { t, remaining: a.remaining }
      assert.ok(warned.t >= 30000, '警告时间 ' + warned.t)
      assert.ok(a.remaining >= 1950, '警告剩余 ' + a.remaining)
    }
    if (a.action === 'shock') { shockAt = t; break }
  }
  assert.ok(warned, '应出现警告')
  assert.ok(shockAt >= warned.t + 1950, '电击时间 ' + shockAt)
})

test('tick 间隔超过 1 秒时不判定并重置计时', () => {
  const m = newMachine({ maxTickGapMs: 1000, startGrace: 0 })
  assert.strictEqual(m.tick(0).action, 'none')
  const stalled = m.tick(3000)
  assert.strictEqual(stalled.action, 'stalled')
  assert.strictEqual(m.shockCount, 0)
  let warnAt = null
  for (let t = 3050; t <= 7500; t += 50) {
    const a = m.tick(t)
    if (a.action === 'warn-start') warnAt = t
    assert.notStrictEqual(a.action, 'shock')
  }
  assert.ok(warnAt >= 7000, '重置后应重新等满 4 秒才警告，实际 ' + warnAt)
})

test('T2 没有合格确认结果时到点取消，不电击', () => {
  const m = newMachine({ maxTickGapMs: 1e9 })
  runT2Scenario(m, 20200, [3000, 6000, 9000, 12000, 15000, 18000])
  assert.ok(m.warning && m.warning.reason === 'T2')
  let canceled = null
  for (let t = 20250; t <= 24000; t += 50) {
    const a = m.tick(t)
    assert.notStrictEqual(a.action, 'shock')
    if (a.action === 'cancel') { canceled = a.reason; break }
  }
  assert.strictEqual(canceled, 'T2-limit')
  m.warning = { reason: 'T2', startedAt: 20000, dueAt: 22000, audioStartMs: 20000, t2Confirmed: false, extendedMs: 0, maxDueAt: 22000 }
  m.onSegment(24000, { verdict: 'offtext', audioStartMs: 24000, audioEndMs: 24000 })
  let shockAt = null
  for (let t = 24050; t <= 26500; t += 50) {
    if (m.tick(t).action === 'shock') { shockAt = t; break }
  }
  assert.ok(shockAt && shockAt >= 24050 && shockAt <= 24100, '确认后电击时间 ' + shockAt)
})

test('T2 警告期间 extendWarning 会推迟 dueAt', () => {
  const m = newMachine({ maxTickGapMs: 1e9 })
  runT2Scenario(m, 20200, [3000, 6000, 9000, 12000, 15000, 18000])
  assert.ok(m.warning)
  const before = m.warning.dueAt
  m.extendWarning(21000, true)
  assert.ok(m.warning.dueAt >= 23000 && m.warning.dueAt > before)
})

test('T2 中 reading 未前进不取消警告，传输变慢只阻止新建', () => {
  const m = newMachine({ maxTickGapMs: 1e9 })
  runT2Scenario(m, 20200, [3000, 6000, 9000, 12000, 15000, 18000])
  assert.ok(m.warning && m.warning.reason === 'T2')
  m.onSegment(20500, { verdict: 'reading', advanced: false, audioStartMs: 20000, audioEndMs: 20500 })
  assert.ok(m.warning && m.warning.reason === 'T2', 'reading 未前进不应取消 T2')
  m.setTransportOk(false)
  const a = m.tick(21000)
  assert.ok(m.warning, '传输变慢不应取消已有警告')
  assert.strictEqual(a.action, 'warning')
  const m2 = newMachine({ maxTickGapMs: 1e9 })
  m2.setTransportOk(false)
  const ev = runT2Scenario(m2, 30000, [3000, 6000, 9000, 12000, 15000, 18000, 21000, 24000, 27000])
  assert.strictEqual(ev.filter(e => e.action === 'warn-start').length, 0, '传输变慢时不得新建 T2')
})

test('T2 延长达到上限后取消警告，不电击', () => {
  const m = newMachine({ maxTickGapMs: 1e9, sttTimeout: 15000 })
  runT2Scenario(m, 20200, [3000, 6000, 9000, 12000, 15000, 18000])
  assert.ok(m.warning && m.warning.reason === 'T2')
  let canceled = null
  for (let t = 20250; t <= 37500; t += 50) {
    m.badSegments.push({ t, verdict: 'offtext', advanced: false })
    m.extendWarning(t, true, 20000)
    const a = m.tick(t)
    if (a.action === 'shock') { canceled = 'shock'; break }
    if (a.action === 'cancel') { canceled = a.reason; break }
  }
  assert.strictEqual(canceled, 'T2-limit', '应在上限处取消，实际 ' + canceled)
  assert.strictEqual(m.shockCount, 0)
  assert.strictEqual(m.warning, null)
})

test('T2 用警告开始前的旧音频不能确认', () => {
  const m = newMachine({ maxTickGapMs: 1e9 })
  runT2Scenario(m, 20200, [3000, 6000, 9000, 12000, 15000, 18000])
  assert.ok(m.warning)
  m.onSegment(21000, { verdict: 'offtext', audioStartMs: 19000, audioEndMs: 21000 })
  assert.ok(m.warning && !m.warning.t2Confirmed, '旧音频不得确认')
  let shocked = false
  for (let t = 21050; t <= 23000; t += 50) {
    if (m.tick(t).action === 'shock') { shocked = true; break }
  }
  assert.strictEqual(shocked, false)
})



test('收尾短片段（<6 音节）与原文吻合时允许推进到结尾', () => {
  const al = new ReadingAligner(sourceSyllables)
  const tailText = sentences[sentences.length - 1]
  const tailSyllables = pinyinService.textToPinyin(tailText).syllables
  const lastFive = tailSyllables.slice(-5)
  const pos = sourceSyllables.length - 5
  const r = al.align(lastFive, pos)
  assert.strictEqual(r.verdict, 'reading')
  assert.strictEqual(r.advanced, true)
  assert.strictEqual(r.newPos, sourceSyllables.length)
})

test('VAD：校准期间有人声/电视声仍能检测正常朗读', () => {
  const VoiceDetector = core.VoiceDetector
  const cases = [
    { name: '人声', calib: [60, 80, 65, 90, 70, 85], read: 55 },
    { name: '电视', calib: [50, 55, 45, 60, 50, 55], read: 40 }
  ]
  cases.forEach(c => {
    const d = new VoiceDetector()
    let t = 0
    for (let i = 0; i < 61; i++) { t += 50; d.process(c.calib[i % c.calib.length], t, 0.05) }
    assert.ok(d.calibrated, c.name + ' 校准未完成')
    let voiced = 0
    for (let i = 0; i < 100; i++) {
      t += 50
      if (d.process(c.read, t, 0.2).voiced) voiced += 1
    }
    assert.ok(voiced > 80, c.name + ' 正常朗读 voiced=' + voiced)
  })
})

test('VAD：大声之后阈值能回落，安静朗读仍被识别', () => {
  const VoiceDetector = core.VoiceDetector
  const d = new VoiceDetector()
  let t = 0
  for (let i = 0; i < 61; i++) { t += 50; d.process(4, t, 0.02) }
  const quietThreshold = d.threshold
  for (let i = 0; i < 40; i++) { t += 50; d.process(180, t, 0.8) }
  let voiced = 0
  for (let i = 0; i < 240; i++) {
    t += 50
    if (d.process(15, t, 0.08).voiced) voiced += 1
  }
  assert.ok(voiced > 150, '安静朗读 voiced=' + voiced)
  assert.ok(d.threshold < 20, '阈值应回落，实际 ' + d.threshold)
  assert.ok(d.thresholdEnergy <= quietThreshold + 15)
})

test('VAD：重新校准会重置校准状态和计时', () => {
  const VoiceDetector = core.VoiceDetector
  const d = new VoiceDetector()
  let t = 0
  for (let i = 0; i < 61; i++) { t += 50; d.process(5, t, 0.05) }
  assert.ok(d.calibrated)
  d.startCalibration(t + 1000)
  assert.strictEqual(d.calibrated, false)
  const info = d.process(5, t + 1050, 0.05)
  assert.strictEqual(info.calibrating, true)
  assert.ok(info.lastEnergyAt >= t + 1000)
})

test('proactive 传输判定和普通分片有界队列', () => {
  const g = new ReadingGame()
  g.config.segmentHop = 3
  g.state = g._initialState()
  g.state.sttSlow = false
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, checkContent: true }, () => 0)
  const now = Date.now()
  g.requestStarts = [{ seq: 1, t: now - 6000 }]
  g._checkProactiveTransport(now)
  assert.strictEqual(g.state.sttSlow, true, '在途超过 4 秒应主动判定变慢')
  g._updateTransport(500)
  assert.strictEqual(g.state.sttSlow, false, '后续快速响应应恢复')
  g.finalQueue = []
  for (let i = 0; i < 6; i++) {
    g._enqueueItem({ audioStartMs: i * 3000, audioEndMs: (i + 1) * 3000 })
  }
  assert.strictEqual(g.finalQueue.length, 2, '队列最多 2 段')
  assert.strictEqual(g.finalQueue[0].audioEndMs, 15000, '溢出丢最旧')
  assert.strictEqual(g.finalQueue[1].audioEndMs, 18000)
})

test('结尾 20 秒拥堵：6 段排队后仍能推进并通关，不电击', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 214
  g.state.position = 180
  g.readingStartTime = now - 50000
  g.audioStartTime = now - 60000
  g.appliedAudioEndMs = 0
  g.finalQueue = []
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0, checkContent: true }, () => now)
  g.trigger.reset(now - 30000)
  g.trigger.pos = 180
  for (let i = 0; i < 6; i++) {
    g._enqueueItem({ audioStartMs: i * 3000, audioEndMs: (i + 1) * 3000 })
  }
  // 6 段只保留最后 2 段（不静默丢光），已应用位置仍能追上
  assert.strictEqual(g.finalQueue.length, 2)
  assert.strictEqual(g.finalQueue[0].audioEndMs, 15000)
  assert.strictEqual(g.finalQueue[1].audioEndMs, 18000)
  g.chunkSeq = 10
  g.finalQueue.forEach(item => {
    g._applyResult(++g.chunkSeq, { verdict: 'reading', newPos: 214, advanced: true },
      '结尾一句', item.audioStartMs, item.audioEndMs, false)
  })
  assert.strictEqual(g.state.won, true, '拥堵后仍能读完通关')
  assert.strictEqual(g.state.shockCount, 0, '不应因排队丢段而电击')
})

test('停在 120/214 且锚定最终确认判中段：恢复 T1 并电击', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 214
  g.state.position = 120
  g.state.silenceSeconds = 6
  g.state.tailConfirm = { startedAt: now - 1000, attempts: 1, lastAt: now - 1000, nextAt: 0 }
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0, checkContent: false, maxTickGapMs: 1e9 }, () => now)
  g.trigger.reset(now - 30000)
  g.trigger.pos = 120
  g.trigger.lastVoiceAt = now - 6000
  g.trigger.lastEnergyAt = now - 6000
  g.trigger.setTailGuard(true, now)
  g._afterTailConfirm(now, 'reading', { verdict: 'reading', newPos: 120, advanced: false })
  assert.strictEqual(g.state.tailConfirm, null, '中段应退出最终确认')
  const warn = g.trigger.tick(now + 50)
  assert.strictEqual(warn.action, 'warn-start')
  assert.strictEqual(warn.reason, 'T1')
  assert.ok(warn.remaining >= 1950, '应给满警告，实际 ' + warn.remaining)
  assert.strictEqual(g.trigger.tick(now + 2050).action, 'shock')
})

test('识别全程失败、正常读完 214 音节：进入确认，未确认完成，不电击', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 214
  g.state.position = 0
  g.state.silenceSeconds = 5
  g.readingStartTime = now - 70000
  g.audioStartTime = now - 70000
  g.appliedAudioEndMs = 0
  for (let sec = 0; sec < 70; sec++) g.voicedBuckets.set(sec, 1000)
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0, checkContent: false, maxTickGapMs: 1e9 }, () => now)
  g.trigger.reset(now - 70000)
  g.trigger.degraded = true
  g.trigger.unknownStreak = 3
  g.trigger.lastVoiceAt = now - 5000
  g.trigger.lastEnergyAt = now - 5000
  g._finishEndWait(now)
  assert.ok(g.state.tailConfirm, '发声累计足够时应进入最终确认')
  g.state.silenceSeconds = 5
  g._afterTailConfirm(now, 'unknown')
  g.state.silenceSeconds = 5
  g._afterTailConfirm(now + 100, 'unknown')
  assert.strictEqual(g.state.won, true)
  assert.strictEqual(g.state.unconfirmed, true)
  assert.strictEqual(g.state.shockCount, 0)
})

test('识别全程失败、只读到约 30% 停下：T1 满警告后电击', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 214
  g.state.position = 0
  g.readingStartTime = now - 21000
  g.audioStartTime = now - 21000
  g.appliedAudioEndMs = 0
  for (let sec = 0; sec < 21; sec++) g.voicedBuckets.set(sec, 1000)
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0, checkContent: false, maxTickGapMs: 1e9 }, () => now)
  g.trigger.reset(now - 21000)
  g.trigger.degraded = true
  g.trigger.lastVoiceAt = now - 5000
  g.trigger.lastEnergyAt = now - 5000
  g._finishEndWait(now)
  assert.strictEqual(g.state.tailConfirm, null, '发声累计不足时不能免罚')
  const warn = g.trigger.tick(now + 50)
  assert.strictEqual(warn.action, 'warn-start')
  assert.strictEqual(warn.reason, 'T1')
  assert.ok(warn.remaining >= 1950, '必须给满警告，实际 ' + warn.remaining)
  assert.strictEqual(g.trigger.tick(now + 2050).action, 'shock')
})

test('中途停下且最近有 unknown 段：仍走 T1 满警告后电击', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 214
  g.state.position = 60
  g.state.segments = [{ verdict: 'unknown' }, { verdict: 'reading' }]
  g.readingStartTime = now - 20000
  g.audioStartTime = now - 20000
  g.appliedAudioEndMs = 0
  for (let sec = 0; sec < 10; sec++) g.voicedBuckets.set(sec, 1000)
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0, checkContent: false, maxTickGapMs: 1e9 }, () => now)
  g.trigger.reset(now - 20000)
  g.trigger.unknownStreak = 2
  g.trigger.lastVoiceAt = now - 5000
  g.trigger.lastEnergyAt = now - 5000
  g._finishEndWait(now)
  assert.strictEqual(g.state.tailConfirm, null)
  const warn = g.trigger.tick(now + 50)
  assert.strictEqual(warn.action, 'warn-start')
  assert.ok(warn.remaining >= 1950)
  assert.strictEqual(g.trigger.tick(now + 2050).action, 'shock')
})

test('600 音节长文、识别全程失败、读完：不受 45 秒上限影响，不电击', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 600
  g.state.position = 0
  g.state.silenceSeconds = 5
  g.readingStartTime = now - 200000
  g.audioStartTime = now - 200000
  g.appliedAudioEndMs = 0
  for (let sec = 0; sec < 200; sec++) g.voicedBuckets.set(sec, 1000)
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0, checkContent: false, maxTickGapMs: 1e9 }, () => now)
  g.trigger.reset(now - 200000)
  g.trigger.degraded = true
  g.trigger.unknownStreak = 3
  g.trigger.lastVoiceAt = now - 5000
  g.trigger.lastEnergyAt = now - 5000
  assert.ok(g._estimatePosition(now) >= 590, '长文估计必须覆盖 45 秒以上')
  g._finishEndWait(now)
  assert.ok(g.state.tailConfirm)
  g.state.silenceSeconds = 5
  g._afterTailConfirm(now, 'unknown')
  g.state.silenceSeconds = 5
  g._afterTailConfirm(now + 100, 'unknown')
  assert.strictEqual(g.state.unconfirmed, true)
  assert.strictEqual(g.state.shockCount, 0)
})

test('结尾 12 秒延迟尖峰：先等待结果，不电击', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 214
  g.state.position = 166
  g.state.silenceSeconds = 6
  g.readingStartTime = now - 41500
  g.audioStartTime = now - 50000
  g.appliedAudioEndMs = 38000
  g.voiceTicks = []
  for (let i = 0; i < 240; i++) {
    g.voiceTicks.push({ t: now - 12000 + i * 50, voiced: true })
  }
  for (let sec = 38; sec < 50; sec++) g.voicedBuckets.set(sec, 1000)
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0 }, () => now)
  g.trigger.reset(now - 10000)
  g.trigger.pos = 166
  g.trigger.lastVoiceAt = now - 6000
  g.trigger.lastEnergyAt = now - 6000
  g.trigger.setTailGuard(true, now)
  g._finishEndWait(now)
  assert.ok(g.state.tailConfirm, '应进入最终确认')
  assert.strictEqual(g.state.warning, null)
  for (let t = now + 50; t <= now + 8000; t += 50) {
    assert.notStrictEqual(g.trigger.tick(t).action, 'shock')
  }
  assert.strictEqual(g.state.shockCount, 0)
})

test('只读到 120/214 就停下：正常 T1 电击，不会免罚完成', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 214
  g.state.position = 120
  g.state.silenceSeconds = 6
  g.readingStartTime = now - 30000
  g.audioStartTime = now - 40000
  g.appliedAudioEndMs = 40000
  g.voiceTicks = []
  g.trigger = new ReadingTriggerMachine({
    silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0, checkContent: false,
    maxTickGapMs: 1e9
  }, () => now)
  g.trigger.reset(now - 10000)
  g.trigger.pos = 120
  g.trigger.lastVoiceAt = now - 6000
  g.trigger.lastEnergyAt = now - 6000
  g.trigger.setTailGuard(true, now)
  g._finishEndWait(now)
  assert.strictEqual(g.state.tailConfirm, null, '不应进入确认')
  const warn = g.trigger.tick(now + 50)
  assert.strictEqual(warn.action, 'warn-start')
  assert.strictEqual(warn.reason, 'T1')
  assert.ok(warn.remaining >= 1950)
  assert.strictEqual(g.trigger.tick(now + 2050).action, 'shock')
})

test('最终确认返回 reading 但没到结尾：退出确认并恢复满警告 T1', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 214
  g.state.position = 180
  g.state.silenceSeconds = 6
  g.state.tailConfirm = { startedAt: now - 1000, attempts: 1, lastAt: now - 1000, nextAt: 0 }
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0, maxTickGapMs: 1e9 }, () => now)
  g.trigger.reset(now - 10000)
  g.trigger.pos = 180
  g.trigger.lastVoiceAt = now - 6000
  g.trigger.lastEnergyAt = now - 6000
  g.trigger.setTailGuard(true, now)
  g._afterTailConfirm(now, 'reading')
  assert.strictEqual(g.state.tailConfirm, null)
  const warn = g.trigger.tick(now + 50)
  assert.strictEqual(warn.action, 'warn-start')
  assert.ok(warn.remaining >= 1950, '必须重新给满警告，实际 ' + warn.remaining)
})

test('T2 被 reading 前进取消后，游戏状态同步且不阻塞 endWait', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 214
  g.state.position = 100
  g.state.phase = 'warning'
  g.state.warning = { reason: 'T2', startedAt: now - 1000, dueAt: now + 1000, audioStartMs: 0 }
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0, maxTickGapMs: 1e9 }, () => now)
  g.trigger.reset(now - 30000)
  g.trigger.warning = { reason: 'T2', startedAt: now - 1000, dueAt: now + 1000, audioStartMs: 0, t2Confirmed: false }
  g.trigger.setPosition(now, 106)
  g.trigger.onSegment(now, { verdict: 'reading', advanced: true, audioStartMs: 0, audioEndMs: 1000 })
  g._syncWarningState()
  assert.strictEqual(g.state.warning, null)
  assert.strictEqual(g.state.phase, 'reading')
  // 随后沉默时，endWait 仍应能创建
  g.state.position = 206
  g.trigger.pos = 206
  g.state.silenceSeconds = 5
  g.readingStartTime = now - 60000
  g.audioStartTime = now - 70000
  g.trigger.lastEnergyAt = now - 5000
  g.trigger.lastVoiceAt = now - 5000
  g.voiceTicks = []
  for (let i = 0; i < 160; i++) g.voiceTicks.push({ t: now - 8000 + i * 50, voiced: true })
  g.requestStarts = [{ seq: 9, t: now, audioStartMs: 67000, audioEndMs: 70000 }]
  g._updateEndHold(now)
  assert.ok(g.state.endWait, '残留警告不应阻塞 endWait')
})

test('等待 15 秒后停在中段：给满警告并 T1 电击', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 214
  g.state.position = 120
  g.state.silenceSeconds = 5
  g.readingStartTime = now - 30000
  g.audioStartTime = now - 50000
  g.appliedAudioEndMs = 40000
  g.voiceTicks = []
  for (let i = 0; i < 80; i++) g.voiceTicks.push({ t: now - 4000 + i * 50, voiced: true })
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0, checkContent: false, maxTickGapMs: 1e9 }, () => now)
  g.trigger.reset(now - 30000)
  g.trigger.pos = 120
  g.trigger.lastTickAt = now - 50
  g.trigger.lastEnergyAt = now - 5000
  g.trigger.lastVoiceAt = now - 5000
  g.requestStarts = [{ seq: 1, t: now - 2000, audioStartMs: 44000, audioEndMs: 48000 }]
  g._updateEndHold(now)
  assert.ok(g.state.endWait, '应先等待在途结果')
  g.requestStarts = []
  g._updateEndHold(now + 15000)
  assert.strictEqual(g.state.tailConfirm, null, '中段不应进入最终确认')
  const warn = g.trigger.tick(now + 15050)
  assert.strictEqual(warn.action, 'warn-start')
  assert.ok(warn.remaining >= 1950)
  assert.strictEqual(g.trigger.tick(now + 17100).action, 'shock')
})

test('估计位置没到末尾时不进入最终确认', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 214
  g.state.position = 160
  g.readingStartTime = now - 40000
  g.audioStartTime = now - 60000
  g.appliedAudioEndMs = 60000
  g.voiceTicks = []
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0, checkContent: false, maxTickGapMs: 1e9 }, () => now)
  g.trigger.reset(now - 30000)
  g.trigger.pos = 160
  g.trigger.lastTickAt = now - 50
  g.trigger.lastEnergyAt = now - 5000
  g.trigger.lastVoiceAt = now - 5000
  g._finishEndWait(now)
  assert.strictEqual(g.state.tailConfirm, null)
  const warn = g.trigger.tick(now + 50)
  assert.strictEqual(warn.action, 'warn-start')
  assert.ok(warn.remaining >= 1950)
})

test('最终确认两次 unknown：按未确认完成结束，不电击', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 214
  g.state.position = 206
  g.state.silenceSeconds = 5
  g.state.tailConfirm = { startedAt: now, attempts: 2, lastAt: now, nextAt: 0, unknowns: 0 }
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0, maxTickGapMs: 1e9 }, () => now)
  g.trigger.reset(now - 30000)
  g.trigger.pos = 206
  g.trigger.setTailGuard(true, now)
  g._afterTailConfirm(now, 'unknown')
  g.state.silenceSeconds = 5
  g._afterTailConfirm(now + 100, 'unknown')
  assert.strictEqual(g.state.won, true)
  assert.strictEqual(g.state.unconfirmed, true)
  assert.strictEqual(g.state.shockCount, 0)
})

test('最终确认 reading 且终点达到 total-10：通关', () => {
  const g = new ReadingGame()
  g.state = g._initialState()
  const now = Date.now()
  g.state.totalSyllables = 214
  g.state.position = 200
  g.state.tailConfirm = { startedAt: now, attempts: 1, lastAt: now, nextAt: 0, unknowns: 0 }
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, cooldown: 0, maxTickGapMs: 1e9 }, () => now)
  g.trigger.reset(now - 30000)
  g.trigger.pos = 200
  g._afterTailConfirm(now, 'reading', { newPos: 205 })
  assert.strictEqual(g.state.won, true)
  assert.strictEqual(g.state.unconfirmed, false)
})

test('pinyin 的 charIndex 支持数字、英文和省略号', () => {
  const text = '你好2026，Hello……世界'
  const res = pinyinService.textToPinyin(text)
  assert.strictEqual(res.chars.length, text.length)
  assert.strictEqual(res.syllables.find(s => s.char === '世').charIndex, text.indexOf('世'))
  assert.strictEqual(res.syllables.find(s => s.char === '界').charIndex, text.indexOf('界'))
})

function makeDevice (calls, opts) {
  const options = opts || {}
  return {
    setDeviceProperty: async function (logicalId, props) {
      calls.push({ logicalId, props: Object.assign({}, props) })
      if (options.gate && props.shock === 1) await options.gate
      if (options.failUntil && calls.length < options.failUntil) throw new Error('publish failed')
      return true
    }
  }
}

test('end/stop/紧急停止 一律发送 shock:0', async () => {
  const calls = []
  const mockDevice = makeDevice(calls)
  const game = new ReadingGame()
  game.deviceManager = mockDevice
  await game.end()
  assert.ok(calls.length > 0, 'end() 必须发送设备指令')
  assert.strictEqual(calls[calls.length - 1].props.shock, 0)

  calls.length = 0
  const game2 = new ReadingGame()
  game2.deviceManager = mockDevice
  game2.stop()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(calls.length > 0, 'stop() 必须发送设备指令')
  assert.strictEqual(calls[calls.length - 1].props.shock, 0)

  calls.length = 0
  const game3 = new ReadingGame()
  game3.deviceManager = mockDevice
  game3.handleUIEvent('emergencyStop')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.strictEqual(calls[calls.length - 1].props.shock, 0, '紧急停止也必须关闭电击')
})

test('shock:1 卡住时到点停止', async () => {
  const calls = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const g = new ReadingGame()
  g.deviceManager = makeDevice(calls, { gate })
  const pending = g.doShock('T1', Date.now())
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(g.shockTimer, 'shock:1 返回前必须已有停止定时器')
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.strictEqual(calls.filter(c => c.props.shock === 0).length, 1, '卡住时到点必须发 shock:0')
  release()
  await pending
  assert.ok(!g.shockTimer)
})

test('end 期间不再发 shock:1', async () => {
  const calls = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const g = new ReadingGame()
  g.deviceManager = makeDevice(calls, { gate })
  const pending = g.doShock('T1', Date.now())
  await new Promise(resolve => setTimeout(resolve, 50))
  await g.end()
  release()
  await pending
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.strictEqual(calls.filter(c => c.props.shock === 1).length, 1, '结束后不得再发 shock:1')
  assert.strictEqual(calls[calls.length - 1].props.shock, 0)
})

test('stopShock 失败后按退避重试', async () => {
  const calls = []
  const g = new ReadingGame()
  g.deviceManager = makeDevice(calls, { failUntil: 3 })
  await g.stopShock({ silent: true })
  assert.strictEqual(calls.length, 3, '应重试到成功，实际 ' + calls.length)
})

test('旧代际 stopShock 重试中止', async () => {
  const g = new ReadingGame()
  let zeros = 0
  g.deviceManager = { setDeviceProperty: async (id, props) => { if (props.shock === 0) zeros += 1; return true } }
  g.shockGen = 2
  assert.strictEqual(await g._sendShockZero(1), true)
  assert.strictEqual(zeros, 0, '旧代际不得再发 shock:0')
  await g._sendShockZero(2)
  assert.strictEqual(zeros, 1)
})

test('speech 不存在时降级为仅 T1，T2 关闭', async () => {
  const g = new ReadingGame({ speech: null })
  g.config.checkContent = true
  assert.strictEqual(await g._initSpeech(), false)
  assert.strictEqual(g.sttUnavailable, true)
  await g.loadText()
  await g.preparePinyin()
  assert.strictEqual(g.state.degraded, true)
  assert.strictEqual(g.trigger.cfg.checkContent, false, 'T2 必须关闭')
  assert.ok(g.state.totalSyllables > 0, '仍保留原文音节数用于结尾保护')
  assert.strictEqual(g.state.sttStatus, '识别不可用（仅检测出声）')
})

test('speech.status ready=false 时降级', async () => {
  let transcribed = 0
  const g = new ReadingGame({
    speech: {
      status: async () => ({ ready: false, mode: 'none', reason: 'NOT_SIGNED_IN' }),
      transcribe: async () => { transcribed += 1; return { text: '' } }
    }
  })
  assert.strictEqual(await g._initSpeech(), false)
  assert.strictEqual(g.sttUnavailable, true)
  assert.strictEqual(g.speechReason, 'NOT_SIGNED_IN')
  assert.strictEqual(transcribed, 0)
})

test('transcribe reject 记为 unknown，永不惩罚', async () => {
  const g = new ReadingGame({
    speech: {
      status: async () => ({ ready: true, mode: 'relay' }),
      transcribe: async () => { const error = new Error('timeout'); error.code = 'TIMEOUT'; throw error }
    }
  })
  g.state.sourceText = SOURCE
  await g.preparePinyin()
  g.trigger.reset(Date.now())
  await g._processSegment(1, new Uint8Array([1, 2, 3]), false, 0, 1000, false)
  assert.strictEqual(g.state.shockCount, 0, '识别失败不得电击')
  assert.strictEqual(g.state.lastVerdict, 'unknown')
  assert.strictEqual(g.state.degraded, false)
  assert.strictEqual(g.trigger.unknownStreak, 1)
})

test('识别不可用时 uploadSegment 不上传，只记未知', async () => {
  let transcribed = 0
  const g = new ReadingGame({
    speech: {
      status: async () => ({ ready: false }),
      transcribe: async () => { transcribed += 1; return { text: '' } }
    }
  })
  g.sttUnavailable = true
  g.state.sourceText = SOURCE
  await g.preparePinyin()
  g.ringBuffer = { sampleRate: 16000 }
  g.readingStartTime = Date.now() - 10000
  g.audioStartTime = Date.now() - 10000
  g.voiceTicks = []
  g.uploadSegment(Date.now(), false)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.strictEqual(transcribed, 0)
  assert.strictEqual(g.state.lastVerdict, 'unknown')
  assert.strictEqual(g.state.shockCount, 0)
})

function makeLifecycleDom () {
  const docListeners = {}
  const winListeners = {}
  const doc = {
    hidden: false,
    addEventListener: (name, fn) => { docListeners[name] = fn },
    removeEventListener: () => {},
    getElementById: () => null
  }
  const win = {
    addEventListener: (name, fn) => { winListeners[name] = fn },
    removeEventListener: () => {}
  }
  return { doc, win, docListeners, winListeners }
}

test('visibility hidden 立即发 stop，恢复后重新校准', async () => {
  const { doc, win, docListeners } = makeLifecycleDom()
  const calls = []
  const g = new ReadingGame({ document: doc, window: win, deviceManager: makeDevice(calls) })
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, checkContent: true }, () => Date.now())
  g.trigger.reset(Date.now())
  g.state.isGameActive = true
  g.bindLifecycle()
  doc.hidden = true
  docListeners.visibilitychange()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.strictEqual(g.state.hidden, true)
  assert.strictEqual(g.trigger.paused, true, '隐藏时暂停判定')
  assert.ok(calls.some(c => c.props.shock === 0), '隐藏时必须发 shock:0')
})

test('pagehide/beforeunload 发送 stop', async () => {
  const { doc, win, winListeners } = makeLifecycleDom()
  const calls = []
  const g = new ReadingGame({ document: doc, window: win, deviceManager: makeDevice(calls) })
  g.bindLifecycle()
  winListeners.pagehide()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(calls.some(c => c.props.shock === 0), 'pagehide 必须关闭电击')
  calls.length = 0
  winListeners.beforeunload()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(calls.some(c => c.props.shock === 0), 'beforeunload 必须关闭电击')
})

test('rgTestAudio 只接受相对路径和 http(s)/data 音频', () => {
  assert.strictEqual(parseTestAudio('?rgTestAudio=audio/a.wav'), 'audio/a.wav')
  assert.strictEqual(parseTestAudio('?rgTestAudio=%2Ftmp%2Fa.wav'), '/tmp/a.wav')
  assert.strictEqual(parseTestAudio('?rgTestAudio=https%3A%2F%2Fx.test%2Fa.wav'), 'https://x.test/a.wav')
  assert.strictEqual(parseTestAudio('?rgTestAudio=data%3Aaudio%2Fwav%3Bbase64%2CAA'), 'data:audio/wav;base64,AA')
  assert.strictEqual(parseTestAudio('?rgTestAudio=javascript%3Aalert(1)'), '')
  assert.strictEqual(parseTestAudio(''), '')
})

test('电击强度未显式允许时最高 30V', () => {
  const g = new ReadingGame()
  g.config.shockIntensity = 45
  g.config.shockStep = 10
  g.config.shockMax = 100
  g.state.consecutiveShocks = 5
  assert.strictEqual(g._voltage(Date.now()), 30)
  g.config.allowUnsafeIntensity = true
  assert.strictEqual(g._voltage(Date.now()), 95)
})

test('wakeLock 有则申请并释放，无则标记不支持', async () => {
  let requested = 0
  let released = 0
  const lock = { release: async () => { released += 1 }, addEventListener: () => {} }
  const nav = {
    wakeLock: {
      request: async (kind) => { requested += 1; assert.strictEqual(kind, 'screen'); return lock }
    }
  }
  const g = new ReadingGame({ window: { navigator: nav } })
  assert.strictEqual(await g._requestWakeLock(), true)
  assert.strictEqual(requested, 1)
  assert.strictEqual(g.wakeLockSupported, true)
  await g._releaseWakeLock()
  assert.strictEqual(released, 1)

  const g2 = new ReadingGame({ window: { navigator: {} } })
  assert.strictEqual(await g2._requestWakeLock(), false)
  assert.strictEqual(g2.wakeLockSupported, false)
})

console.log('\n[反复朗读与背诵单元测试]')

const maskSample = pinyinService.textToPinyin('春天来了，花儿开了。').chars

test('选字：比例、只遮汉字、至少一个、100% 全遮', () => {
  assert.strictEqual(core.rgMaskRatio(1, 10, 10), 10)
  assert.strictEqual(core.rgMaskRatio(4, 10, 30), 100)
  assert.deepStrictEqual(core.rgSelectMaskChars(maskSample, 0, 1, null, () => 0.5), [])
  const zh = maskSample.filter(c => c.isZh).map(c => c.charIndex)
  const low = core.rgSelectMaskChars(maskSample, 1, 1, null, () => 0.5)
  assert.strictEqual(low.length, 1, '比例 > 0 时至少遮 1 个')
  assert.ok(zh.indexOf(low[0]) >= 0, '只能遮汉字')
  const half = core.rgSelectMaskChars(maskSample, 50, 1, null, () => 0.5)
  assert.strictEqual(half.length, Math.round(zh.length * 0.5))
  const all = core.rgSelectMaskChars(maskSample, 100, 1, null, () => 0.5)
  assert.strictEqual(all.length, zh.length)
  assert.deepStrictEqual(all.slice().sort((a, b) => a - b), zh.slice().sort((a, b) => a - b))
})

test('选字：上一遍遮过的字尽量不再遮，同一档内随机', () => {
  const zhCount = maskSample.filter(c => c.isZh).length
  const first = core.rgSelectMaskChars(maskSample, 30, 1, null, () => 0.1)
  const last = new Map()
  first.forEach(i => last.set(i, 1))
  const second = core.rgSelectMaskChars(maskSample, 30, 2, last, () => 0.9)
  assert.strictEqual(second.length, Math.round(zhCount * 0.3))
  const overlap = second.filter(i => first.indexOf(i) >= 0)
  assert.strictEqual(overlap.length, 0, '还有没遮过的字时不应重复遮')
  const a = core.rgSelectMaskChars(maskSample, 30, 2, null, seqRandom(false))
  const b = core.rgSelectMaskChars(maskSample, 30, 2, null, seqRandom(true))
  assert.notDeepStrictEqual(a, b, '同一档内应受随机数影响')
})

test('正确率：分母扣掉结尾，跳过的字不算', () => {
  assert.strictEqual(core.rgAccuracy(new Set([0, 1, 2]), 10, 10), 0.3)
  // 结尾 10 个没确认时最多只扣 TAIL_ESTIMATE_SLACK
  assert.strictEqual(core.rgAccuracy(new Set([0, 1]), 20, 10), 2 / 10)
  assert.strictEqual(core.rgAccuracy(new Set([0, 1]), 20, 15), 2 / 15)
  assert.strictEqual(core.rgAccuracy(new Set([0, 1, 2, 3]), 4, 4), 1)
  const al = new ReadingAligner(sourceSyllables)
  const r = alignText(sentences[2], cumulativeSyllables(1), al)
  const matched = new Set()
  core.rgAddMatchedPairs(matched, r, r.newPos)
  assert.ok(matched.size > 0)
  assert.ok(Math.max.apply(null, Array.from(matched)) < r.newPos, '只计入采纳位置之前')
  const skipped = core.rgAccuracy(matched, sourceSyllables.length, r.newPos)
  assert.ok(skipped < 1, '被跳过的句子拉低正确率')
})

function seqRandom (desc) {
  let n = 0
  return () => { n += 1; return desc ? 1 - n / 1000 : n / 1000 }
}

function newFlowGame (cfg, matched) {
  const g = new ReadingGame()
  Object.assign(g.config, cfg || {})
  g.state = g._initialState()
  g.state.startTime = Date.now()
  g.state.mode = g._mode()
  g.state.totalPasses = g.state.mode === 'read' ? g._passCount() : 0
  g.state.passNumber = 1
  g.state.level = g.state.mode === 'recite' ? 1 : 0
  g.state.sourceText = SOURCE
  g.state.chars = pinyinService.textToPinyin(SOURCE).chars
  g.state.totalSyllables = 100
  g.state.position = 100
  g.passId = 1
  g.state.passId = 1
  const hits = typeof matched === 'number'
    ? Array.from({ length: matched }, (_, i) => i)
    : (matched || Array.from({ length: 100 }, (_, i) => i))
  g.passMatched = new Set(hits)
  g.trigger = new ReadingTriggerMachine({ silenceLimit: 6, warnLead: 2, startGrace: 0, checkContent: false, maxTickGapMs: 1e9 }, () => Date.now())
  return g
}

test('多遍流程：朗读 2 遍后通关', () => {
  const g = newFlowGame({ mode: 'read', passes: 2, totalTime: 0, restSeconds: 0 })
  g._onPassDone('won')
  assert.strictEqual(g.state.completedPasses, 1)
  assert.strictEqual(g.state.won, false, '第一遍后不应通关')
  assert.strictEqual(g.passId, 2, '进入下一遍应有新 passId')
  assert.strictEqual(g.state.passNumber, 2)
  assert.strictEqual(g.state.phase, 'reading')
  g.state.position = 100
  g.passMatched = new Set(Array.from({ length: 100 }, (_, i) => i))
  g._onPassDone('won')
  assert.strictEqual(g.state.completedPasses, 2)
  assert.strictEqual(g.state.won, true, '读满 2 遍应通关')
  assert.strictEqual(g.state.unconfirmed, false)
})

test('多遍流程：背诵升级、留级和 100% 遮字通关', () => {
  const up = newFlowGame({ mode: 'recite', passRate: 85, maskStart: 10, maskStep: 50, restSeconds: 20 }, 90)
  up.state.lastAccuracy = null
  up.state.maskRatio = 10
  up.state.level = 1
  up._onPassDone('won')
  assert.strictEqual(up.state.level, 2, '正确率达标应升级')
  assert.strictEqual(up.state.phase, 'rest')
  assert.strictEqual(up.state.maskRatio, 60, '下一遍遮字比例应按新等级')
  assert.strictEqual(up.trigger.paused, true, '休息期间暂停判定')
  assert.strictEqual(up.state.lastPassPassed, true)
  const stay = newFlowGame({ mode: 'recite', passRate: 85, maskStart: 10, maskStep: 50, restSeconds: 20 }, 50)
  stay.state.maskRatio = 10
  stay.state.level = 1
  stay._onPassDone('won')
  assert.strictEqual(stay.state.level, 1, '正确率不够应留级')
  assert.strictEqual(stay.state.lastPassPassed, false)
  assert.strictEqual(stay.state.phase, 'rest')
  const win = newFlowGame({ mode: 'recite', passRate: 85, maskStart: 10, maskStep: 50, restSeconds: 20 }, 100)
  win.state.maskRatio = 100
  win.state.level = 3
  win._onPassDone('won')
  assert.strictEqual(win.state.won, true, '100% 遮字达标应通关')
  assert.strictEqual(win.state.phase, 'won')
})

test('多遍流程：旧 passId 的结果和休息期间的识别结果都被丢弃', async () => {
  const g = newFlowGame({ mode: 'read', passes: 2, totalTime: 0, restSeconds: 20 })
  g.state.position = 10
  g.passId = 2
  g.state.phase = 'reading'
  g._applyResult(1, { verdict: 'reading', newPos: 80, strongStart: 78, chainStart: 76, pairs: [], windowStart: 0 }, '旧遍结果', 0, 1000, false, 1)
  assert.strictEqual(g.state.position, 10, '旧 passId 不得推进')
  g.passId = 3
  g.state.phase = 'rest'
  g._applyResult(2, { verdict: 'reading', newPos: 90, strongStart: 88, chainStart: 86, pairs: [], windowStart: 0 }, '休息期结果', 0, 2000, false, 3)
  assert.strictEqual(g.state.position, 10, '休息期间不得推进')
  const calls = []
  g.deviceManager = makeDevice(calls)
  await g.doShock('T1', Date.now())
  assert.strictEqual(calls.length, 0, '休息期间绝不电击')
  assert.strictEqual(g.state.shockCount, 0)
})

test('背诵每级放宽沉默时限，朗读玩法不变', () => {
  const g = newFlowGame({ mode: 'recite', silenceLimit: 6, silenceBonus: 2, restSeconds: 0 })
  g.state.level = 1
  assert.strictEqual(g._effectiveSilenceLimit(), 8)
  g.state.level = 3
  assert.strictEqual(g._effectiveSilenceLimit(), 12)
  g.config.mode = 'read'
  g.state.level = 3
  assert.strictEqual(g._effectiveSilenceLimit(), 6)
})

test('待定跳转：一次不推进，连续两次推进，回到原位后清除', () => {
  const gate = new core.PendingJumpGate({ minJump: 12, slack: 4 })
  const far = { verdict: 'reading', newPos: 30, strongStart: 28, chainStart: 26 }
  assert.strictEqual(gate.evaluate({ verdict: 'reading', newPos: 4, strongStart: 2, chainStart: 1 }, 0).action, 'advance', '小跳照常推进')
  assert.strictEqual(gate.evaluate(far, 0).action, 'defer')
  assert.ok(gate.pending)
  const second = gate.evaluate({ verdict: 'reading', newPos: 33, strongStart: 31, chainStart: 29 }, 0)
  assert.strictEqual(second.action, 'accept')
  assert.ok(second.newPos >= 33)
  assert.strictEqual(gate.pending, null)
  gate.evaluate(far, 0)
  assert.strictEqual(gate.evaluate({ verdict: 'reading', newPos: 3, strongStart: 2, chainStart: 1 }, 0).action, 'advance')
  assert.strictEqual(gate.pending, null)
})

test('待定跳转接入游戏：跳远先不推进，连续两段后承认', () => {
  const g = newFlowGame({ mode: 'read', passes: 1 })
  g.state.position = 0
  g.state.phase = 'reading'
  g.passMatched = new Set()
  g._applyResult(1, { verdict: 'reading', newPos: 24, strongStart: 20, chainStart: 18, pairs: [{ asrIndex: 0, srcIndex: 20, sim: 0.9 }], windowStart: 0 }, '跳远', 0, 1000, false, 1)
  assert.strictEqual(g.state.position, 0, '第一段跳远先待定')
  assert.ok(g.jumpGate.pending)
  g._applyResult(2, { verdict: 'reading', newPos: 30, strongStart: 26, chainStart: 24, pairs: [{ asrIndex: 0, srcIndex: 24, sim: 0.9 }], windowStart: 0 }, '再跳', 0, 2000, false, 1)
  assert.strictEqual(g.state.position, 30, '连续两段后承认跳转')
  assert.strictEqual(g.jumpGate.pending, null)
})

function makeLockApi (calls, opts) {
  const options = opts || {}
  return {
    device (id) {
      if (id === 'lock') {
        return {
          isMapped: () => options.mapped !== false,
          invoke: async (capability, action, params) => {
            calls.push({ id, capability, action, params })
            if (options.fail) throw new Error('lock failed')
            if (options.result !== undefined) return options.result
            return true
          }
        }
      }
      return { isMapped: () => false, invoke: async () => true }
    }
  }
}

async function startWithStubs (g) {
  g._initSpeech = async () => false
  g.loadText = async () => { g.state.sourceText = '测试'; g.state.sourceTitle = '测试' }
  g.preparePinyin = async () => { g.state.chars = []; g.state.sourceSyllables = []; g.state.totalSyllables = 0 }
  g.bindEsc = () => {}
  g.bindLifecycle = () => {}
  g._requestWakeLock = async () => false
  g.startAudio = async () => {}
  g.startTimers = () => {}
  g.renderUI = () => {}
  await g.start()
}

test('自动锁：开始上锁，结束/通关/离开都解锁', async () => {
  const calls = []
  const g = new ReadingGame({ deviceApi: makeLockApi(calls) })
  await startWithStubs(g)
  assert.deepStrictEqual(calls.filter(c => c.action === 'setOpen').pop().params, { open: false }, '开始应上锁')
  await g.end()
  assert.strictEqual(calls[calls.length - 1].params.open, true, 'end 应解锁')

  const calls2 = []
  const g2 = new ReadingGame({ deviceApi: makeLockApi(calls2) })
  g2.state.startTime = Date.now()
  g2.finishWin()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.strictEqual(calls2[calls2.length - 1].params.open, true, '通关应解锁')

  const calls3 = []
  const listeners = {}
  const win = { addEventListener: (name, fn) => { listeners[name] = fn }, removeEventListener: () => {} }
  const g3 = new ReadingGame({ deviceApi: makeLockApi(calls3), window: win })
  g3.bindLifecycle()
  listeners.pagehide()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.strictEqual(calls3[calls3.length - 1].params.open, true, 'pagehide 应解锁')
})

test('自动锁：开始失败解锁，未映射或发送失败都不影响游戏', async () => {
  const calls = []
  const g = new ReadingGame({ deviceApi: makeLockApi(calls) })
  g._initSpeech = async () => false
  g.loadText = async () => {}
  g.preparePinyin = async () => { g.state.chars = []; g.state.sourceSyllables = []; g.state.totalSyllables = 0 }
  g.bindEsc = () => {}
  g.bindLifecycle = () => {}
  g._requestWakeLock = async () => false
  g.startAudio = async () => { throw new Error('no audio') }
  await assert.rejects(() => g.start())
  assert.strictEqual(calls[calls.length - 1].params.open, true, '开始失败应解锁')

  const unmapped = []
  const g2 = new ReadingGame({ deviceApi: makeLockApi(unmapped, { mapped: false }) })
  assert.strictEqual(await g2._setLock(false), false)
  assert.strictEqual(unmapped.length, 0, '未映射时跳过')

  const failCalls = []
  const g3 = new ReadingGame({ deviceApi: makeLockApi(failCalls, { fail: true }) })
  assert.strictEqual(await g3._setLock(true), false, '发送失败只记日志')
  assert.strictEqual(g3.lockState, true)
})

// ---- 审查修复回归 ----

function restGame (restSeconds) {
  const g = newFlowGame({ mode: 'read', passes: 2, totalTime: 0, restSeconds: restSeconds == null ? 20 : restSeconds })
  g.state.position = 100
  g._onPassDone('won')
  return g
}

test('休息中窗口/麦克风/音频状态变化不会打断休息，也不会凭空通关', () => {
  const g = restGame()
  assert.strictEqual(g.state.phase, 'rest')
  assert.strictEqual(g.trigger.paused, true)
  const passId = g.passId
  const done = g.state.completedPasses

  g.state.hidden = true
  g.onHidden()
  g.onVisible()
  assert.strictEqual(g.state.hidden, false)
  assert.strictEqual(g.state.phase, 'rest', '窗口恢复后仍是休息')
  assert.strictEqual(g.trigger.paused, true, 'trigger 仍保持暂停')
  assert.strictEqual(g.passId, passId)

  let handler = null
  g.audioContext = { state: 'running', addEventListener: (name, fn) => { handler = fn } }
  g._bindAudioState()
  g.audioContext.state = 'suspended'
  handler()
  assert.strictEqual(g.state.phase, 'rest', '音频被打断仍是休息')
  assert.strictEqual(g.trigger.paused, true)
  g.state.paused = true
  g.audioContext.state = 'running'
  handler()
  assert.strictEqual(g.state.phase, 'rest', '音频恢复仍是休息')
  assert.strictEqual(g.state.paused, false)
  assert.strictEqual(g.trigger.paused, true)

  const pos = g.state.position
  g._applyResult(9, { verdict: 'reading', newPos: 100, strongStart: 99, chainStart: 98, pairs: [{ asrIndex: 0, srcIndex: 0, sim: 0.9 }], windowStart: 0 }, '上一遍迟到结果', 0, 999, false, 1)
  assert.strictEqual(g.state.position, pos, '上一遍结果不得推进')
  g._onPassDone('won')
  assert.strictEqual(g.state.completedPasses, done, '同一遍不得重复结算')
  assert.strictEqual(g.state.won, false)
})

test('休息结束后的窗口恢复会直接开始下一遍', () => {
  const g = restGame()
  const passId = g.passId
  g.state.hidden = true
  g.state.restUntil = Date.now() - 10
  g.onVisible()
  assert.strictEqual(g.state.hidden, false)
  assert.strictEqual(g.state.phase, 'reading')
  assert.strictEqual(g.passId, passId + 1)
  assert.strictEqual(g.passEnded, false)
})

test('T1 警告起点使用加上等级奖励后的沉默时限', () => {
  const g = newFlowGame({ mode: 'recite', silenceLimit: 6, silenceBonus: 2, restSeconds: 20 })
  g.config.warnLead = 2
  g.state.level = 2
  g.state.position = 50
  g.state.totalSyllables = 100
  g.state.phase = 'reading'
  let calls = 0
  g._finishEndWait = () => { calls += 1 }
  const now = Date.now()
  g.trigger.lastEnergyAt = now - 7900
  g._updateEndHold(now)
  assert.strictEqual(calls, 0, '有效时限 10 秒时应为 8 秒后再判定')
  g.trigger.lastEnergyAt = now - 8100
  g._updateEndHold(now)
  assert.strictEqual(calls, 1, '超过有效时限后进入警告/结尾判定')
})

test('换遍时重置 VoiceDetector 的 zeroSince 和 voiced 状态', () => {
  const g = newFlowGame({ mode: 'read', passes: 2, restSeconds: 0 })
  g.detector = { zeroSince: 123, isVoiced: true, energyVoiced: true, aboveSince: 1, belowSince: 2, energyAboveSince: 3, energyBelowSince: 4 }
  g.state.paused = true
  g._startNextPass(Date.now())
  assert.strictEqual(g.detector.zeroSince, 0)
  assert.strictEqual(g.detector.isVoiced, false)
  assert.strictEqual(g.detector.energyVoiced, false)
  assert.strictEqual(g.detector.aboveSince, 0)
  assert.strictEqual(g.detector.energyAboveSince, 0)
  assert.strictEqual(g.state.paused, false, '下一遍不能带着上一遍的暂停状态')
})

test('待定跳转：回到原位时清除，defer 不计配对，accept 补两条的配对', () => {
  const g = newFlowGame({ mode: 'read', passes: 1 })
  g.state.position = 20
  g.state.phase = 'reading'
  g.passMatched = new Set()
  g._applyResult(1, { verdict: 'reading', newPos: 50, strongStart: 40, chainStart: 38, pairs: [{ asrIndex: 0, srcIndex: 5, sim: 0.9 }], windowStart: 0 }, '跳远', 0, 1000, false, 1)
  assert.strictEqual(g.state.position, 20)
  assert.ok(g.pendingJumpResult)
  assert.strictEqual(g.passMatched.size, 0, '待定期间不计配对')
  g._applyResult(2, { verdict: 'reading', newPos: 20, strongStart: 10, chainStart: 8, pairs: [{ asrIndex: 0, srcIndex: 18, sim: 0.9 }], windowStart: 0 }, '回到原位', 0, 2000, false, 1)
  assert.strictEqual(g.pendingJumpResult, null)
  assert.strictEqual(g.jumpGate.pending, null)
  assert.strictEqual(g.state.position, 20)
  assert.ok(g.passMatched.has(18), '当前这条结果应计配对')
  assert.strictEqual(g.passMatched.has(5), false, '被否定的跳转结果不计配对')

  const g2 = newFlowGame({ mode: 'read', passes: 1 })
  g2.state.position = 20
  g2.state.phase = 'reading'
  g2.passMatched = new Set()
  g2._applyResult(1, { verdict: 'reading', newPos: 50, strongStart: 40, chainStart: 38, pairs: [{ asrIndex: 0, srcIndex: 5, sim: 0.9 }], windowStart: 0 }, '跳远', 0, 1000, false, 1)
  g2._applyResult(2, { verdict: 'reading', newPos: 55, strongStart: 45, chainStart: 44, pairs: [{ asrIndex: 0, srcIndex: 30, sim: 0.9 }], windowStart: 0 }, '承认跳转', 0, 2000, false, 1)
  assert.strictEqual(g2.state.position, 55)
  assert.ok(g2.passMatched.has(5) && g2.passMatched.has(30), '承认后两条结果的配对都计入')
})

test('正确率比较和展示都按四舍五入后的整数百分比', () => {
  const g = newFlowGame({ mode: 'recite', passRate: 85, maskStart: 10, maskStep: 10, restSeconds: 20 }, 84)
  g.state.totalSyllables = 99
  g.state.position = 99
  g.state.maskRatio = 10
  g.state.level = 1
  g._onPassDone('won')
  assert.strictEqual(g.state.lastPassPassed, true, '84/99=84.85%，四舍五入为 85% 应过关')
  assert.ok(g._restSummary().includes('85%'), '休息摘要显示 85%')
})

test('拼音失败时没有可遮的字，遮字比例显示为 0', () => {
  const g = newFlowGame({ mode: 'recite', maskStart: 50, maskStep: 50 })
  g.state.chars = []
  g.state.maskedChars = [1]
  g.state.maskRatio = 50
  g._selectMask(1, 1)
  assert.strictEqual(g.state.maskRatio, 0)
  assert.deepStrictEqual(g.state.maskedChars, [])
})

test('背诵在没有语音识别时不开始游戏、不上锁', async () => {
  const calls = []
  const g = new ReadingGame({ deviceApi: makeLockApi(calls) })
  g.config.mode = 'recite'
  g._initSpeech = async () => { g._markSpeechUnavailable('no-api'); return false }
  let message = ''
  g.renderIdle = msg => { message = msg || '' }
  const result = await g.start()
  assert.strictEqual(result, false)
  assert.strictEqual(calls.length, 0, '不得发上锁/解锁指令')
  assert.strictEqual(g.state.isGameActive, false)
  assert.ok(message.includes('背诵玩法需要语音识别'))
})

test('在途计数和传输状态按 passId 隔离', () => {
  const g = newFlowGame({ mode: 'read', passes: 2 })
  g.passId = 2
  g.passEnded = false
  g.state.sttInFlight = 1
  g.finalQueue = []
  g.requestStarts = [{ seq: 1, passId: 1 }, { seq: 2, passId: 2 }]
  g._releaseInFlight(1, 1)
  assert.strictEqual(g.state.sttInFlight, 1, '上一遍的在途结果不能扣新一遍计数')
  assert.strictEqual(g.requestStarts.length, 2)
  g._releaseInFlight(2, 2)
  assert.strictEqual(g.state.sttInFlight, 0)
  assert.strictEqual(g.requestStarts.length, 1)
  g._updateTransport(9000, 1)
  assert.strictEqual(g.state.sttSlow, false, '上一遍的迟到延迟不能影响新一遍')
})

test('电击发送失败时不还原提示字', async () => {
  const makeHintGame = () => {
    const g = newFlowGame({ mode: 'recite', hintChars: 2 })
    g.state.phase = 'reading'
    g.state.position = 0
    g.state.sourceText = '你好世界'
    g.state.sourceSyllables = [{ charIndex: 0 }, { charIndex: 1 }, { charIndex: 2 }, { charIndex: 3 }]
    g.state.maskedChars = [0, 1, 2, 3]
    g.state.hintedChars = []
    g.hintedSet = new Set()
    return g
  }
  const bad = makeHintGame()
  bad.deviceManager = { setDeviceProperty: async () => { throw new Error('send failed') } }
  await bad.doShock('T1', Date.now())
  assert.strictEqual(bad.state.hintedChars.length, 0, '发送失败不能还原')

  const good = makeHintGame()
  good.deviceManager = makeDevice([])
  await good.doShock('T1', Date.now())
  assert.strictEqual(good.state.hintedChars.length, 2, '发送成功才还原')
})

test('自动锁返回 false/success:false 记失败，end 等锁最多 3 秒', async () => {
  const logs = []
  const g = new ReadingGame({ deviceApi: makeLockApi([], { result: false }) })
  g.log = msg => logs.push(msg)
  assert.strictEqual(await g._setLock(false), false)
  assert.ok(logs.some(msg => msg.includes('自动锁操作失败')))

  const g2 = new ReadingGame({ deviceApi: makeLockApi([], { result: { success: false } }) })
  assert.strictEqual(await g2._setLock(true), false)

  const fakeTimers = {
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {}
  }
  const hangApi = { device: () => ({ isMapped: () => true, invoke: () => new Promise(() => {}) }) }
  const g3 = new ReadingGame({ deviceApi: hangApi, timers: fakeTimers })
  g3.renderStopped = () => {}
  g3.stopAudio = async () => {}
  g3.stopShock = async () => {}
  g3._releaseWakeLock = async () => {}
  g3.log = () => {}
  const startedAt = Date.now()
  await g3.end()
  assert.ok(Date.now() - startedAt < 1000, '锁设备卡住不能拖住结束界面')
})

test('i18n: 待机/背诵文案齐全，开始朗读不重复', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'games', 'reading-game', 'i18n.js'), 'utf8')
  assert.ok(src.includes('"待机": "Idle"'))
  assert.ok(src.includes('"背诵中": "Reciting"'))
  assert.ok(src.includes('"背诵玩法需要语音识别，请登录账号或在设置里填写 SiliconFlow key"'))
  assert.strictEqual((src.match(/"开始朗读":/g) || []).length, 1, '开始朗读 key 不能重复')
})

test('休息时按下一遍遮字从 0 渲染，不露出被遮的原字', () => {
  const g = newFlowGame({ mode: 'recite', maskStart: 50, maskStep: 50, restSeconds: 20 })
  g.state.sourceText = '你好世界'
  g.state.sourceSyllables = [{ charIndex: 0 }, { charIndex: 1 }, { charIndex: 2 }, { charIndex: 3 }]
  g.state.chars = pinyinService.textToPinyin('你好世界').chars
  g.state.phase = 'rest'
  g.state.position = 4
  g.state.level = 1
  g._selectMask(1, 1)
  assert.ok(g.state.maskedChars.length > 0)
  assert.strictEqual(g._displayCursor(), 0, '休息时从 0 显示')
  const html = g._renderChars('你好世界', 0, 4, 0)
  assert.ok(html.includes('■'))
  for (const idx of g.state.maskedChars) {
    assert.ok(!html.includes('你好世界'.charAt(idx)), '被遮的字不能出现在 DOM')
  }
  g.state.phase = 'reading'
  g.state.position = 2
  assert.strictEqual(g._displayCursor(), 2, '非休息时仍按阅读位置')
})

// ---- 识别滞后/超时不能导致多电 ----

function endHoldGame (overrides) {
  const g = newFlowGame({ mode: 'read', passes: 2, restSeconds: 20, silenceLimit: 6, warnLead: 2, sttTimeout: 20000 })
  g.state.phase = 'reading'
  g.state.hidden = false
  g.state.paused = false
  g.state.totalSyllables = 214
  g.state.position = 67
  g.state.degraded = false
  g.state.sttSlow = false
  g.state.sttInFlight = 0
  g.audioStartTime = 1000
  g.sttErrorAt = 0
  g.requestStarts = []
  g.finalQueue = []
  g.voiceTicks = [{ t: 1000 + 70000, voiced: true }]
  g.voicedBuckets = new Map()
  g.trigger.lastEnergyAt = Date.now() - 8000
  g.state.endWait = { startedAt: Date.now() - 3000, posAtStart: 67, deadline: Date.now() + 5000 }
  Object.assign(g, overrides || {})
  return g
}

test('第二遍末尾识别超时/失败时，沉默按未确认结算而不是电击', () => {
  const now = Date.now()
  const g = endHoldGame({ sttErrorAt: now - 5000 })
  g._updateEndHold(now)
  assert.strictEqual(g.state.completedPasses, 1)
  assert.strictEqual(g.state.lastPassKind, 'unconfirmed')
  assert.strictEqual(g.state.phase, 'rest', '读玩法应进入休息/结算，而不是警告')
  assert.strictEqual(g.state.warning, null, '不得进入电击警告')
  assert.strictEqual(g.state.shockCount, 0)
  assert.strictEqual(g.state.sttInFlight, 0)
})

test('第二遍一直出声但识别全部超时时，末尾不会因沉默电击', () => {
  const now = Date.now()
  const g = endHoldGame({ sttErrorAt: now - 1000 })
  g.state.sttSlow = true
  g.state.degraded = true
  g.trigger.degraded = true
  // 用户一直在读：最后一段有声且刚刚还在出声
  g.trigger.lastEnergyAt = now - 8000
  g._updateEndHold(now)
  assert.strictEqual(g.state.shockCount, 0)
  assert.strictEqual(g.state.warning, null)
  assert.strictEqual(g.state.completedPasses, 1)
  assert.strictEqual(g.state.phase, 'rest')
})

test('识别正常且最后一段有进展时，T1 判定保持原样', () => {
  const now = Date.now()
  const g = endHoldGame()
  g.state.position = 80
  g.trigger.setTailGuard(true, now)
  g._updateEndHold(now)
  assert.strictEqual(g.state.completedPasses, 0, '识别可靠时不能直接按未确认结算')
  assert.strictEqual(g.state.phase, 'reading')
  assert.strictEqual(g.trigger.tailGuard, false, '应退出结尾等待，恢复正常 T1')
  assert.strictEqual(g.state.warning, null)
})

test('换遍重置所有跨遍状态，上一遍失败不影响新一遍', async () => {
  const g = newFlowGame({ mode: 'read', passes: 2, restSeconds: 0 })
  const now = Date.now()
  g.passId = 1
  g.passEnded = true
  g.appliedAudioEndMs = 60000
  g.requestStarts = [{ seq: 1, passId: 1, t: now, audioStartMs: 0, audioEndMs: 60000 }]
  g.voicedBuckets = new Map([[1, 1000], [2, 1000]])
  g.voiceTicks = [{ t: now, voiced: true }]
  g.latencySamples = [{ t: now, ms: 18000 }]
  g.sttErrorAt = now - 1000
  g.lastChunkEndSec = 50
  g.audioStartTime = 1000
  g.testAudioUrl = 'x'
  g.state.endWait = { startedAt: now, posAtStart: 0, deadline: now + 1000 }
  g.state.tailConfirm = { startedAt: now, attempts: 1 }
  g.state.paused = true
  g.trigger.setTransportOk(false)
  g.trigger.degraded = true
  g.trigger.unknownStreak = 3
  g._startNextPass(now)
  assert.strictEqual(g.appliedAudioEndMs, 0)
  assert.deepStrictEqual(g.requestStarts, [])
  assert.strictEqual(g.voicedBuckets.size, 0)
  assert.deepStrictEqual(g.voiceTicks, [])
  assert.deepStrictEqual(g.latencySamples, [])
  assert.strictEqual(g.sttErrorAt, 0)
  assert.strictEqual(g.lastChunkEndSec, 0)
  assert.strictEqual(g.audioStartTime, now)
  assert.strictEqual(g.ringBuffer.total, 0, '测试音频换遍应使用新缓冲区')
  assert.strictEqual(g.state.endWait, null)
  assert.strictEqual(g.state.tailConfirm, null)
  assert.strictEqual(g.state.paused, false)
  assert.strictEqual(g.passEnded, false)
  assert.strictEqual(g.trigger.transportOk, true)
  assert.strictEqual(g.trigger.degraded, false)
  assert.strictEqual(g.trigger.unknownStreak, 0)
  assert.strictEqual(g.trigger.paused, false)

  // 上一遍的失败请求：stale 丢弃，不写 sttErrorAt、不扣新一遍在途计数
  g.passId = 2
  g.passEnded = false
  g.sttErrorAt = 0
  g.latencySamples = []
  g.state.sttInFlight = 1
  g.finalQueue = []
  g.requestStarts = [{ seq: 9, passId: 1, t: now, audioStartMs: 0, audioEndMs: 1000 }]
  g.speech = { transcribe: async () => { const e = new Error('timeout'); e.code = 'TIMEOUT'; throw e } }
  await g._processSegment(9, Buffer.alloc(2), false, 0, 1000, false, 1)
  assert.strictEqual(g.sttErrorAt, 0, '上一遍失败不能污染新一遍的识别可靠标记')
  assert.strictEqual(g.state.sttInFlight, 1, '上一遍的 finally 不能扣新一遍的在途计数')
  assert.deepStrictEqual(g.latencySamples, [], '上一遍的迟到延迟不进入新一遍')
})

test('识别响应变慢时，末尾沉默也按未确认结算而不是电击', () => {
  const now = Date.now()
  const g = endHoldGame()
  g.state.sttSlow = true
  g._updateEndHold(now)
  assert.strictEqual(g.state.completedPasses, 1)
  assert.strictEqual(g.state.phase, 'rest')
  assert.strictEqual(g.state.warning, null)
  assert.strictEqual(g.state.shockCount, 0)
})

test('末尾等待超时但识别请求仍在途时，也不电击', () => {
  const now = Date.now()
  const g = endHoldGame()
  g.state.sttInFlight = 1
  g.requestStarts = [{ seq: 1, passId: 1, t: now - 20000, audioStartMs: 64000, audioEndMs: 70000 }]
  g.state.endWait.deadline = now - 1
  g._updateEndHold(now)
  assert.strictEqual(g.state.completedPasses, 1)
  assert.strictEqual(g.state.phase, 'rest')
  assert.strictEqual(g.state.warning, null)
  assert.strictEqual(g.state.shockCount, 0)
})
