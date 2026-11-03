/**
 * 背单词游戏纯逻辑核心（Vocabulary Game core）
 * 日期序号、每日计划、出题队列、间隔更新、干扰项、存档合并、语音口令解析。
 * 不碰 DOM 和网络；浏览器挂 window.VocabCore，Node 可直接 require。
 * 规格见 docs/plans/vocab-game.md 第 2、3、4.3、5 节。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.VocabCore = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  const DAY_BOUNDARY_HOUR = 4
  const DAY_MS = 24 * 60 * 60 * 1000
  const PLAN_KEEP_DAYS = 7
  const BANK_IDS = ['gaokao', 'cet4', 'cet6', 'ielts']
  const DEFAULT_SETTINGS = {
    bank: 'cet4',
    newPerDay: 20,
    reviewCap: 100,
    questionTime: 20,
    inputMode: 'voice',
    autoSpeak: true,
    punishUnknown: true
  }

  function toNumber(value, fallback) {
    const n = Number(value)
    return isFinite(n) ? n : fallback
  }

  function clampInt(value, fallback, min, max) {
    const n = Math.floor(toNumber(value, fallback))
    return Math.max(min, Math.min(max, n))
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n)
  }

  // 日期序号：以本地时间 04:00 为换日点。返回从 1970-01-01 起的天数。
  function dayIndex(nowMs) {
    const ms = toNumber(nowMs, Date.now())
    const shifted = new Date(ms - DAY_BOUNDARY_HOUR * 3600 * 1000)
    return Math.floor(Date.UTC(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()) / DAY_MS)
  }

  // 存档里的日期键：同样按 04:00 换日，格式 YYYY-MM-DD。
  function dateKey(nowMs) {
    const ms = toNumber(nowMs, Date.now())
    const shifted = new Date(ms - DAY_BOUNDARY_HOUR * 3600 * 1000)
    return shifted.getFullYear() + '-' + pad2(shifted.getMonth() + 1) + '-' + pad2(shifted.getDate())
  }

  function indexToDateKey(index) {
    const d = new Date(Math.round(toNumber(index, 0)) * DAY_MS)
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
  }

  function dateKeyToIndex(key) {
    const m = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!m) return null
    return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS)
  }

  // 连续首答对 k 次后，下次到期 = 今天 + 2^(k-1) 天（1、2、4、8……不封顶）。
  function intervalDays(k) {
    return Math.pow(2, Math.max(0, toNumber(k, 0) - 1))
  }

  function isFirstAnswerToday(entry, today) {
    return !entry || Number(entry.last) !== Number(today)
  }

  // 更新单个词的进度；返回 { entry, first }，不修改传入对象。
  // first=true 表示这是今天第一次作答：首答对 k+1、间隔翻倍；首答错 k=0、明天到期。
  // 同一天后续出现时只增加 wrong 计数，不改 k / due。
  function updateWord(entry, opts) {
    const o = opts || {}
    const today = toNumber(o.today, dayIndex(Date.now()))
    const now = toNumber(o.now, Date.now())
    const correct = !!o.correct
    const prev = entry && typeof entry === 'object' ? entry : null
    const first = isFirstAnswerToday(prev, today)
    const next = {
      k: Math.max(0, toNumber(prev && prev.k, 0)),
      due: toNumber(prev && prev.due, today),
      last: toNumber(prev && prev.last, 0),
      wrong: Math.max(0, toNumber(prev && prev.wrong, 0)),
      u: now
    }
    if (first) {
      next.last = today
      if (correct) {
        next.k += 1
        next.due = today + intervalDays(next.k)
      } else {
        next.k = 0
        next.due = today + 1
        next.wrong += 1
      }
    } else if (!correct) {
      next.wrong += 1
    }
    return { entry: next, first }
  }

  function recordAnswer(save, id, opts) {
    if (!save.words || typeof save.words !== 'object') save.words = {}
    const result = updateWord(save.words[id], opts)
    save.words[id] = result.entry
    return result
  }

  function shuffle(list, random) {
    const arr = Array.isArray(list) ? list.slice() : []
    const rnd = typeof random === 'function' ? random : Math.random
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      const tmp = arr[i]
      arr[i] = arr[j]
      arr[j] = tmp
    }
    return arr
  }

  // 把新词均匀插进复习词里，避免新词连续扎堆；随机只用来做一点位置抖动。
  function spreadNewWords(reviewIds, newIds, random) {
    const review = Array.isArray(reviewIds) ? reviewIds.slice() : []
    const fresh = Array.isArray(newIds) ? newIds.slice() : []
    if (!fresh.length) return review
    if (!review.length) return fresh
    const rnd = typeof random === 'function' ? random : Math.random
    const out = review.slice()
    for (let i = 0; i < fresh.length; i++) {
      const ratio = (i + 0.5) / fresh.length
      const jitter = rnd() - 0.5
      let pos = Math.round(ratio * out.length + jitter)
      if (pos < 0) pos = 0
      if (pos > out.length) pos = out.length
      out.splice(pos, 0, fresh[i])
    }
    return out
  }

  function buildDailyPlan(opts) {
    const o = opts || {}
    const now = toNumber(o.now, Date.now())
    const today = o.today != null ? toNumber(o.today, dayIndex(now)) : dayIndex(now)
    const bank = String(o.bank || '')
    const bankIds = (Array.isArray(o.bankIds) ? o.bankIds : []).map(String)
    const progress = o.progress && typeof o.progress === 'object' ? o.progress : {}
    const newPerDay = clampInt(o.newPerDay, 20, 0, 200)
    const reviewCap = clampInt(o.reviewCap, 100, 0, 500)

    const due = []
    bankIds.forEach((id, order) => {
      const entry = progress[id]
      if (!entry) return
      if (toNumber(entry.due, Infinity) <= today) due.push({ id: id, due: toNumber(entry.due, 0), order: order })
    })
    due.sort((a, b) => (a.due - b.due) || (a.order - b.order))
    const reviewIds = due.slice(0, reviewCap).map(item => item.id)

    // “从没学过”按全局进度判断，所以别的词库学过的词不会再当新词出现。
    const newIds = []
    const seen = new Set(Object.keys(progress))
    for (let i = 0; i < bankIds.length && newIds.length < newPerDay; i++) {
      const id = bankIds[i]
      if (seen.has(id)) continue
      newIds.push(id)
    }
    const ids = spreadNewWords(reviewIds, newIds, o.random)
    return { bank: bank, ids: ids, done: [], extra: 0, newIds: newIds, u: now }
  }

  // 完成后再学一组：只加当前词库里没学过的新词；没有新增时 added=0。
  function buildExtraPlan(plan, opts) {
    const o = opts || {}
    const base = plan && Array.isArray(plan.ids) ? plan : { ids: [], done: [], newIds: [], extra: 0 }
    const progress = o.progress && typeof o.progress === 'object' ? o.progress : {}
    const bankIds = (Array.isArray(o.bankIds) ? o.bankIds : []).map(String)
    const have = new Set(base.ids.concat(base.newIds || []))
    const limit = clampInt(o.newPerDay, 20, 0, 200)
    const fresh = []
    for (let i = 0; i < bankIds.length && fresh.length < limit; i++) {
      const id = bankIds[i]
      if (progress[id] || have.has(id)) continue
      fresh.push(id)
    }
    if (!fresh.length) return { added: 0, plan: base }
    return {
      added: fresh.length,
      plan: {
        bank: base.bank,
        ids: base.ids.concat(fresh),
        done: (base.done || []).slice(),
        extra: toNumber(base.extra, 0) + 1,
        newIds: (base.newIds || []).concat(fresh),
        u: toNumber(o.now, Date.now())
      }
    }
  }

  // 当天中途换词书或改每日新词数：复习词与已答过的词不动，
  // 没答过的新词按新设置保留/裁掉/从新词库补齐。
  function rebuildPlan(plan, opts) {
    const o = opts || {}
    const base = normalizePlan(plan) || { bank: '', ids: [], done: [], extra: 0, newIds: [], u: 0 }
    const now = toNumber(o.now, Date.now())
    const today = toNumber(o.today, dayIndex(now))
    const bank = BANK_IDS.indexOf(String(o.bank || base.bank)) >= 0
      ? String(o.bank || base.bank)
      : DEFAULT_SETTINGS.bank
    const bankIds = (Array.isArray(o.bankIds) ? o.bankIds : []).map(String)
    const bankSet = new Set(bankIds)
    const progress = o.progress && typeof o.progress === 'object' ? o.progress : {}
    const newPerDay = clampInt(o.newPerDay, DEFAULT_SETTINGS.newPerDay, 0, 200)
    const oldNew = new Set((base.newIds || []).map(String))
    const done = new Set((base.done || []).map(String))
    const answered = id => !!progress[id] && Number(progress[id].last) === today
    const ids = []
    const newIds = []
    base.ids.forEach(id => {
      if (!oldNew.has(id)) {
        ids.push(id)
        return
      }
      const kept = done.has(id) || answered(id)
      // 没答过的新词：同词库且还有名额就保留，换词书或超出新上限就裁掉。
      if (kept || (bankSet.has(id) && newIds.length < newPerDay)) {
        ids.push(id)
        newIds.push(id)
      }
    })
    const used = new Set(ids)
    for (let i = 0; i < bankIds.length && newIds.length < newPerDay; i++) {
      const id = bankIds[i]
      if (progress[id] || used.has(id)) continue
      used.add(id)
      ids.push(id)
      newIds.push(id)
    }
    return { bank: bank, ids: ids, done: (base.done || []).slice(), extra: base.extra, newIds: newIds, u: now }
  }

  function planDoneSet(plan) {
    return new Set(plan && Array.isArray(plan.done) ? plan.done.map(String) : [])
  }

  function isPlanComplete(plan) {
    if (!plan || !Array.isArray(plan.ids)) return false
    // 空计划（没有新词也没有到期复习）也算今日完成，首页不能一直让人「开始学习」。
    const done = planDoneSet(plan)
    return plan.ids.every(id => done.has(String(id)))
  }

  function planRemaining(plan) {
    if (!plan || !Array.isArray(plan.ids)) return []
    const done = planDoneSet(plan)
    return plan.ids.filter(id => !done.has(String(id)))
  }

  // 状态条用：新词已答/总数、复习已答/总数、剩余题数。
  function planStats(plan) {
    const p = plan || {}
    const ids = Array.isArray(p.ids) ? p.ids : []
    const done = planDoneSet(p)
    const fresh = new Set((Array.isArray(p.newIds) ? p.newIds : []).map(String))
    let newTotal = 0
    let newDone = 0
    let reviewTotal = 0
    let reviewDone = 0
    ids.forEach(id => {
      if (fresh.has(String(id))) {
        newTotal += 1
        if (done.has(String(id))) newDone += 1
      } else {
        reviewTotal += 1
        if (done.has(String(id))) reviewDone += 1
      }
    })
    return {
      newTotal: newTotal,
      newDone: newDone,
      reviewTotal: reviewTotal,
      reviewDone: reviewDone,
      total: ids.length,
      remaining: ids.filter(id => !done.has(String(id))).length
    }
  }

  function normalizeWord(item) {
    if (Array.isArray(item)) {
      const word = String(item[0] || '')
      return {
        id: word.toLowerCase(),
        word: word,
        phonetic: String(item[1] || ''),
        short: String(item[2] || item[3] || ''),
        full: String(item[3] || item[2] || '')
      }
    }
    if (item && typeof item === 'object') {
      const word = String(item.word || item.id || '')
      return {
        id: String(item.id || word).toLowerCase(),
        word: word || String(item.id || ''),
        phonetic: String(item.phonetic == null ? '' : item.phonetic),
        short: String(item.short == null ? (item.meaning || '') : item.short),
        full: String(item.full == null ? (item.meaning || item.short || '') : item.full)
      }
    }
    return null
  }

  // 词库条目：支持 [word, phonetic, short, full]，也兼容旧的 [word, phonetic, meaning]。
  function normalizeBank(bank) {
    const words = bank && Array.isArray(bank.words) ? bank.words : []
    const out = []
    words.forEach(item => {
      const w = normalizeWord(item)
      if (w && w.id && w.short) out.push(w)
    })
    return out
  }

  function firstPos(text) {
    const m = String(text || '').match(/^\s*(?:[\[(（]?)([a-z]+)\./i)
    return m ? m[1].toLowerCase() : ''
  }

  function meaningsOverlap(a, b) {
    const x = String(a || '').replace(/\s+/g, ' ').trim()
    const y = String(b || '').replace(/\s+/g, ' ').trim()
    if (!x || !y) return false
    return x === y || x.includes(y) || y.includes(x)
  }

  // 4 选 1：正确项 + 3 个干扰项。干扰项优先取和正确答案首个词性相同的，
  // 释义不能相同或互相包含；选项顺序随机。
  function buildChoices(words, correctId, random, count) {
    const list = Array.isArray(words) ? words : []
    const want = Math.max(2, Math.min(6, toNumber(count, 4)))
    const target = String(correctId || '').toLowerCase()
    const correct = list.find(w => w && String(w.id).toLowerCase() === target)
    if (!correct) return []
    const correctPos = firstPos(correct.short)
    const usable = list.filter(w => {
      if (!w || String(w.id).toLowerCase() === target) return false
      if (!w.short) return false
      return !meaningsOverlap(w.short, correct.short)
    })
    const samePos = shuffle(usable.filter(w => firstPos(w.short) === correctPos), random)
    const otherPos = shuffle(usable.filter(w => firstPos(w.short) !== correctPos), random)
    const picked = []
    const used = new Set([String(correct.short)])
    const take = source => {
      for (let i = 0; i < source.length && picked.length < want - 1; i++) {
        const candidate = source[i]
        const text = String(candidate.short)
        let conflict = false
        used.forEach(prev => { if (!conflict && meaningsOverlap(text, prev)) conflict = true })
        if (conflict) continue
        used.add(text)
        picked.push({ id: candidate.id, text: text, correct: false })
      }
    }
    take(samePos)
    take(otherPos)
    const options = [{ id: correct.id, text: correct.short, correct: true }].concat(picked)
    return shuffle(options, random)
  }

  // 出题队列：答错/超时/不认识时把词放回队尾；答对直接出队。
  class QuizQueue {
    constructor(ids) {
      this.items = Array.isArray(ids) ? ids.slice() : []
    }

    get length() {
      return this.items.length
    }

    next() {
      return this.items.length ? this.items.shift() : null
    }

    requeue(id) {
      if (id == null) return
      this.items.push(id)
    }

    remaining() {
      return this.items.slice()
    }
  }

  function uniqueStrings(list) {
    const out = []
    const seen = new Set()
    ;(Array.isArray(list) ? list : []).forEach(item => {
      const id = String(item == null ? '' : item)
      if (!id || seen.has(id)) return
      seen.add(id)
      out.push(id)
    })
    return out
  }

  function normalizeWordEntry(raw) {
    if (!raw || typeof raw !== 'object') return null
    return {
      k: Math.max(0, toNumber(raw.k, 0)),
      due: toNumber(raw.due, 0),
      last: toNumber(raw.last, 0),
      wrong: Math.max(0, toNumber(raw.wrong, 0)),
      u: toNumber(raw.u, 0)
    }
  }

  function normalizePlan(raw) {
    if (!raw || typeof raw !== 'object') return null
    return {
      bank: String(raw.bank || ''),
      ids: uniqueStrings(raw.ids),
      done: uniqueStrings(raw.done),
      extra: Math.max(0, toNumber(raw.extra, 0)),
      newIds: uniqueStrings(raw.newIds),
      u: toNumber(raw.u, 0)
    }
  }

  function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {}
    return {
      bank: BANK_IDS.indexOf(String(src.bank)) >= 0 ? String(src.bank) : DEFAULT_SETTINGS.bank,
      newPerDay: clampInt(src.newPerDay, DEFAULT_SETTINGS.newPerDay, 0, 200),
      reviewCap: clampInt(src.reviewCap, DEFAULT_SETTINGS.reviewCap, 0, 500),
      questionTime: clampInt(src.questionTime, DEFAULT_SETTINGS.questionTime, 0, 120),
      inputMode: src.inputMode === 'touch' ? 'touch' : DEFAULT_SETTINGS.inputMode,
      autoSpeak: src.autoSpeak !== false,
      punishUnknown: src.punishUnknown !== false,
      u: toNumber(src.u, 0)
    }
  }

  // 游戏内改设置：整份 settings 带新的 u，合并时取 u 大的那份。
  function updateSettings(current, patch, now) {
    const base = normalizeSettings(current)
    const src = patch && typeof patch === 'object' ? patch : {}
    const merged = Object.assign({}, base, { u: toNumber(now, Date.now()) })
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
      if (Object.prototype.hasOwnProperty.call(src, key)) merged[key] = src[key]
    })
    return normalizeSettings(merged)
  }

  // 电击强度/时长：游戏内改的存本机，并记下当时宿主的值。
  // 下次启动宿主值没变就用本机值；宿主值变了就用宿主值并清掉本机覆盖。
  function resolveShockSettings(host, override) {
    const h = host && typeof host === 'object' ? host : {}
    const hostVoltage = clampInt(h.shockVoltage, 15, 10, 100)
    const hostDuration = clampInt(h.shockDuration, 2, 1, 10)
    const saved = override && typeof override === 'object' ? override : null
    if (!saved) return { voltage: hostVoltage, duration: hostDuration, override: null }
    const sameHost = Number(saved.hostVoltage) === hostVoltage && Number(saved.hostDuration) === hostDuration
    if (!sameHost) return { voltage: hostVoltage, duration: hostDuration, override: null }
    const voltage = clampInt(saved.voltage, hostVoltage, 10, 100)
    const duration = clampInt(saved.duration, hostDuration, 1, 10)
    return {
      voltage: voltage,
      duration: duration,
      override: { hostVoltage: hostVoltage, hostDuration: hostDuration, voltage: voltage, duration: duration }
    }
  }

  function normalizeSave(raw) {
    const out = { v: 1, words: {}, plans: {}, settings: normalizeSettings(raw && raw.settings) }
    if (!raw || typeof raw !== 'object') return out
    const words = raw.words
    if (words && typeof words === 'object') {
      Object.keys(words).forEach(id => {
        const entry = normalizeWordEntry(words[id])
        if (entry && id) out.words[String(id).toLowerCase()] = entry
      })
    }
    const plans = raw.plans
    if (plans && typeof plans === 'object') {
      Object.keys(plans).forEach(key => {
        if (dateKeyToIndex(key) == null) return
        const plan = normalizePlan(plans[key])
        if (plan) out.plans[key] = plan
      })
    }
    return out
  }

  // 同一存档在两台设备上合并：每个词取 u 大的；同一天的计划取 ids/done 并集，
  // 先到的顺序保留（先 local，再 remote），extra 取大，u 取大。
  function mergeSaves(local, remote) {
    const a = normalizeSave(local)
    const b = normalizeSave(remote)
    const words = {}
    const ids = new Set(Object.keys(a.words).concat(Object.keys(b.words)))
    ids.forEach(id => {
      const left = a.words[id]
      const right = b.words[id]
      if (!left) words[id] = right
      else if (!right) words[id] = left
      else words[id] = toNumber(right.u, 0) > toNumber(left.u, 0) ? right : left
    })
    const plans = {}
    const keys = new Set(Object.keys(a.plans).concat(Object.keys(b.plans)))
    keys.forEach(key => {
      const left = a.plans[key]
      const right = b.plans[key]
      if (!left) { plans[key] = right; return }
      if (!right) { plans[key] = left; return }
      plans[key] = {
        bank: left.bank || right.bank,
        ids: uniqueStrings(left.ids.concat(right.ids)),
        done: uniqueStrings(left.done.concat(right.done)),
        extra: Math.max(toNumber(left.extra, 0), toNumber(right.extra, 0)),
        newIds: uniqueStrings((left.newIds || []).concat(right.newIds || [])),
        u: Math.max(toNumber(left.u, 0), toNumber(right.u, 0))
      }
    })
    return { v: 1, words: words, plans: plans, settings: mergedSettings(a.settings, b.settings) }
  }

  function mergedSettings(left, right) {
    return toNumber(right && right.u, 0) > toNumber(left && left.u, 0) ? right : left
  }

  // 只保留最近 7 天（含今天）的计划。
  function pruneSave(save, today, keepDays) {
    const base = normalizeSave(save)
    const current = today != null ? toNumber(today, dayIndex(Date.now())) : dayIndex(Date.now())
    const keep = Math.max(1, toNumber(keepDays, PLAN_KEEP_DAYS))
    const cutoff = current - (keep - 1)
    Object.keys(base.plans).forEach(key => {
      const idx = dateKeyToIndex(key)
      if (idx == null || idx < cutoff) delete base.plans[key]
    })
    return base
  }

  const VOICE_CONTINUE = /(继续|下一个|下一题|下一)/
  const VOICE_UNKNOWN = /(不认识|不会|不知道|不记得|忘了)/
  const VOICE_CHOICE_PATTERNS = [
    { index: 1, patterns: ['第一个', '第一', '一个', '一号', '选一', '一是', '衣', '医'] },
    { index: 2, patterns: ['第二个', '第二', '二个', '两', '两个', '二号', '选二', '二', '儿', '而'] },
    { index: 3, patterns: ['第三个', '第三', '三个', '三号', '选三', '三', '山', '伞'] },
    { index: 4, patterns: ['第四个', '第四', '四个', '四号', '选四', '四', '寺', '似'] }
  ]
  // 单独说的数字/字母/同音字；「是」不算四。
  const VOICE_EXACT = {
    '一': 1, '衣': 1, '医': 1,
    '二': 2, '儿': 2, '而': 2,
    '三': 3, '山': 3, '伞': 3,
    '四': 4, '寺': 4, '似': 4,
    '1': 1, '2': 2, '3': 3, '4': 4,
    'a': 1, 'b': 2, 'c': 3, 'd': 4
  }
  function normalizeVoiceText(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/[\s，。！？、,.!?;；:："'“”‘’（）()【】[\]…—_-]/g, '')
  }

  // 语音识别文本 → 指令。返回 { action: 'choice', index } / 'unknown' / 'continue' / 'ignore'。
  // 识别出多个选项、或同时包含多种意图时忽略（界面提示“没听清”）。
  function parseVoiceCommand(text) {
    const raw = normalizeVoiceText(text)
    if (!raw) return { action: 'ignore', reason: 'empty' }
    const wantsContinue = VOICE_CONTINUE.test(raw)
    const wantsUnknown = VOICE_UNKNOWN.test(raw)
    const choiceText = raw
      .replace(/(继续吧?|下一个|下一题|下一)/g, '')
      .replace(/(不认识|不会|不知道|不记得|忘了)/g, '')
    const hits = new Set()
    VOICE_CHOICE_PATTERNS.forEach(item => {
      item.patterns.forEach(pattern => {
        if (choiceText.indexOf(pattern) >= 0) hits.add(item.index)
      })
    })
    const digit = choiceText.match(/第([1-4])个?/) || choiceText.match(/([1-4])个/)
    if (digit) hits.add(Number(digit[1]))
    const latin = choiceText.match(/选([abcd])/)
    if (latin) hits.add(VOICE_EXACT[latin[1]])
    if (VOICE_EXACT[choiceText] != null) hits.add(VOICE_EXACT[choiceText])
    if (hits.size > 1) return { action: 'ignore', reason: 'multiple-choices' }
    if (hits.size === 1) {
      const index = Array.from(hits)[0]
      if (wantsContinue || wantsUnknown) return { action: 'ignore', reason: 'mixed-intent' }
      return { action: 'choice', index: index }
    }
    if (wantsContinue && wantsUnknown) return { action: 'ignore', reason: 'mixed-intent' }
    if (wantsContinue) return { action: 'continue' }
    if (wantsUnknown) return { action: 'unknown' }
    return { action: 'ignore', reason: 'not-recognized' }
  }

  return {
    DAY_BOUNDARY_HOUR: DAY_BOUNDARY_HOUR,
    DAY_MS: DAY_MS,
    PLAN_KEEP_DAYS: PLAN_KEEP_DAYS,
    BANK_IDS: BANK_IDS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normalizeSettings: normalizeSettings,
    updateSettings: updateSettings,
    resolveShockSettings: resolveShockSettings,
    dayIndex: dayIndex,
    dateKey: dateKey,
    indexToDateKey: indexToDateKey,
    dateKeyToIndex: dateKeyToIndex,
    intervalDays: intervalDays,
    isFirstAnswerToday: isFirstAnswerToday,
    updateWord: updateWord,
    recordAnswer: recordAnswer,
    shuffle: shuffle,
    spreadNewWords: spreadNewWords,
    buildDailyPlan: buildDailyPlan,
    buildExtraPlan: buildExtraPlan,
    rebuildPlan: rebuildPlan,
    planStats: planStats,
    planRemaining: planRemaining,
    isPlanComplete: isPlanComplete,
    normalizeWord: normalizeWord,
    normalizeBank: normalizeBank,
    firstPos: firstPos,
    meaningsOverlap: meaningsOverlap,
    buildChoices: buildChoices,
    QuizQueue: QuizQueue,
    normalizeSave: normalizeSave,
    mergeSaves: mergeSaves,
    pruneSave: pruneSave,
    normalizeVoiceText: normalizeVoiceText,
    parseVoiceCommand: parseVoiceCommand
  }
})
