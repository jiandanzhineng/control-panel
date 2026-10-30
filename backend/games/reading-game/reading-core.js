/**
 * 朗读游戏纯逻辑核心（Reading Game core）
 * 对齐、T1/T2 判定状态机、VAD、环形缓冲、重采样、WAV 编码。
 * 不碰 DOM 和网络；浏览器挂 window.RGCore，Node 可直接 require。
 * 逻辑逐条照搬 electron-client outter-game/reading-game/reading-game.js（分支 feat/reading-game）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.RGCore = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'
const RG_CONST = {
  SAMPLE_RATE: 16000,
  FRAME_MS: 50,
  RENDER_MS: 250,
  BAND_LOW_HZ: 300,
  BAND_HIGH_HZ: 3400,
  CALIBRATE_MS: 3000,
  ONSET_MS: 150,
  HANGOVER_MS: 300,
  MAX_SHOCKS_PER_MINUTE: 6,
  WIN_SLACK_SYLLABLES: 3,
  TAIL_ESTIMATE_SLACK: 10,
  WINDOW_BACK: 30,
  WINDOW_FORWARD: 60
}

const RG_FUZZY_INITIAL = { zh: 'z', ch: 'c', sh: 's', n: 'l' }
const RG_FUZZY_FINAL = {
  ing: 'in', eng: 'en', ang: 'an', iang: 'ian', uang: 'uan',
  ueng: 'uen', 'ü': 'u', 'üe': 'ue', 'üan': 'uan', 'ün': 'un'
}
function rgNormInitial(initial) {
  const s = String(initial || '').toLowerCase()
  return RG_FUZZY_INITIAL[s] || s
}

function rgNormFinal(final) {
  let s = String(final || '').toLowerCase().replace(/ü/g, 'u')
  if (RG_FUZZY_FINAL[s]) return RG_FUZZY_FINAL[s]
  return s
}

// 两个拼音串的编辑相似度（0-1），用于处理近音韵母
function rgEditSim(a, b) {
  if (a === b) return 1
  if (!a || !b) return 0
  const m = a.length
  const n = b.length
  if (!m || !n) return 0
  let prev = new Array(n + 1)
  let cur = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    const tmp = prev
    prev = cur
    cur = tmp
  }
  const dist = prev[n]
  return Math.max(0, 1 - dist / Math.max(m, n))
}

// 音节相似度：模糊声母/韵母归一后比较。同音字（ASR 常见错误）归一后为 1
function rgSyllableSim(a, b) {
  if (!a || !b) return 0
  const ia = rgNormInitial(a.initial)
  const ib = rgNormInitial(b.initial)
  const fa = rgNormFinal(a.final)
  const fb = rgNormFinal(b.final)
  if (!fa || !fb) return 0
  const initSim = ia === ib ? 1 : 0
  const finalSim = rgEditSim(fa, fb)
  // 只有声母、韵母在模糊归一后都完全相同才算“确定匹配”（同音字、n/l、zh/z 等）
  const exact = (ia === ib && fa === fb) || (a.pinyin && b.pinyin && a.pinyin === b.pinyin)
  if (exact) return 1
  // 近似匹配最高 0.79，避免大量随机的近音被当成确定证据
  return Math.min(0.79, 0.6 * initSim + 0.4 * finalSim)
}

function rgMatchScore(sim) {
  if (sim >= 0.82) return 2.2
  if (sim >= 0.65) return 0.7
  return -1.5
}

function rgEscapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
/**
 * 本地对齐器：把一段 ASR 拼音和原文窗口做带仿射 gap 的局部对齐。
 * 位置只前进；往回读（重读）只判为 reading，不回退位置。
 */
class ReadingAligner {
  constructor(sourceSyllables, options) {
    const opts = options || {}
    this.source = (sourceSyllables || []).map(s => ({
      char: s.char,
      charIndex: s.charIndex,
      pinyin: s.pinyin,
      initial: s.initial,
      final: s.final
    }))
    this.total = this.source.length
    this.backWindow = opts.backWindow != null ? opts.backWindow : RG_CONST.WINDOW_BACK
    this.forwardWindow = opts.forwardWindow != null ? opts.forwardWindow : RG_CONST.WINDOW_FORWARD
    this.gapOpen = opts.gapOpen != null ? opts.gapOpen : -1.4
    this.gapExtend = opts.gapExtend != null ? opts.gapExtend : -0.08
    this.jumpPenaltyRate = opts.jumpPenaltyRate != null ? opts.jumpPenaltyRate : 0.05
    this.jumpPenaltyCap = opts.jumpPenaltyCap != null ? opts.jumpPenaltyCap : 1.5
    this.minAdvanceScore = opts.minAdvanceScore != null ? opts.minAdvanceScore : 3.0
  }

  _result(verdict, pos, extra) {
    return Object.assign({
      verdict,
      newPos: pos,
      advanced: false,
      effectiveCount: 0,
      strongCount: 0,
      weakCount: 0,
      matchRate: 0,
      strongRate: 0,
      consecutiveStrong: 0,
      score: 0,
      reason: '',
      pairs: []
    }, extra || {})
  }

  align(asrSyllables, pos) {
    const asr = Array.isArray(asrSyllables) ? asrSyllables : []
    const basePos = Math.max(0, Math.min(this.total, Number(pos) || 0))
    if (asr.length === 0) return this._result('unknown', basePos, { reason: 'empty' })
    if (asr.length < 2) {
      return this._result('unknown', basePos, { effectiveCount: asr.length, reason: 'too-short' })
    }
    // 少于 6 个音节不判离稿；但如果确实和原文高度吻合（常见于收尾的半句），允许推进位置
    const shortFragment = asr.length < 6

    const lo = Math.max(0, basePos - this.backWindow)
    const hi = Math.min(this.total, basePos + this.forwardWindow)
    const n = hi - lo
    const m = asr.length
    if (n <= 0) return this._result('unknown', basePos, { effectiveCount: m, reason: 'no-window' })

    const W = n + 1
    const size = (m + 1) * W
    const H = new Float32Array(size)
    const E = new Float32Array(size)
    const F = new Float32Array(size)
    const Hpre = new Int8Array(size)
    const Epre = new Int8Array(size)
    const Fpre = new Int8Array(size)
    E.fill(-1e9)
    F.fill(-1e9)
    let bestScore = 0
    let bestI = 0
    let bestJ = 0
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const idx = i * W + j
        const diag = (i - 1) * W + (j - 1)
        let prevBest = H[diag]
        let pre = 1
        if (E[diag] > prevBest) { prevBest = E[diag]; pre = 2 }
        if (F[diag] > prevBest) { prevBest = F[diag]; pre = 3 }
        const sim = rgSyllableSim(asr[i - 1], this.source[lo + j - 1])
        let h = prevBest + rgMatchScore(sim)
        if (h <= 0) { h = 0; pre = 0 }
        H[idx] = h
        Hpre[idx] = pre
        const left = idx - 1
        const eH = H[left] + this.gapOpen
        const eE = E[left] + this.gapExtend
        if (eH >= eE) { E[idx] = eH; Epre[idx] = 1 } else { E[idx] = eE; Epre[idx] = 2 }
        const up = idx - W
        const fH = H[up] + this.gapOpen
        const fF = F[up] + this.gapExtend
        if (fH >= fF) { F[idx] = fH; Fpre[idx] = 1 } else { F[idx] = fF; Fpre[idx] = 3 }
        if (h > bestScore || (h === bestScore && h > 0 && j > bestJ)) {
          bestScore = h
          bestI = i
          bestJ = j
        }
      }
    }

    const pairs = []
    let ti = bestI
    let tj = bestJ
    let state = 1
    while (ti > 0 && tj > 0) {
      const idx = ti * W + tj
      if (state === 1) {
        if (H[idx] <= 0) break
        pairs.push({
          asrIndex: ti - 1,
          srcIndex: tj - 1,
          sim: rgSyllableSim(asr[ti - 1], this.source[lo + tj - 1])
        })
        const pre = Hpre[idx]
        ti -= 1
        tj -= 1
        state = pre
      } else if (state === 2) {
        const pre = Epre[idx]
        tj -= 1
        state = pre
      } else {
        const pre = Fpre[idx]
        ti -= 1
        state = pre
      }
    }
    pairs.reverse()

    let strongCount = 0
    let weakCount = 0
    let run = 0
    let maxRun = 0
    let firstStrongSrc = -1
    let lastStrongSrc = -1
    for (let k = 0; k < pairs.length; k++) {
      const p = pairs[k]
      if (p.sim >= 0.82) {
        strongCount += 1
        if (firstStrongSrc < 0) firstStrongSrc = p.srcIndex
        lastStrongSrc = p.srcIndex
        const prev = k > 0 ? pairs[k - 1] : null
        if (prev && prev.sim >= 0.82 && prev.asrIndex + 1 === p.asrIndex && prev.srcIndex + 1 === p.srcIndex) {
          run += 1
        } else {
          run = 1
        }
        if (run > maxRun) maxRun = run
      } else if (p.sim >= 0.65) {
        weakCount += 1
        run = 0
      } else {
        run = 0
      }
    }

    let advanced = false
    let newPos = basePos
    const canAdvance = (maxRun >= 3) || (strongCount >= 3 && strongCount / m >= 0.3)
    if (canAdvance && lastStrongSrc >= 0) {
      const candidate = lo + lastStrongSrc + 1
      if (candidate > basePos) {
        const overshoot = Math.max(0, firstStrongSrc - (basePos + 8))
        const penalty = Math.min(this.jumpPenaltyCap, overshoot * this.jumpPenaltyRate)
        if (bestScore - penalty >= this.minAdvanceScore) {
          newPos = candidate
          advanced = true
        }
      }
    }
    if (shortFragment) {
      const shortReading = advanced && strongCount >= 2 && strongCount / m >= 0.5
      return this._result(shortReading ? 'reading' : 'unknown', shortReading ? newPos : basePos, {
        advanced: shortReading,
        effectiveCount: m,
        strongCount,
        weakCount,
        matchRate: pairs.length / m,
        strongRate: strongCount / m,
        consecutiveStrong: maxRun,
        score: bestScore,
        reason: shortReading ? 'short-advanced' : 'too-short',
        pairs,
        chainStart: pairs.length ? lo + pairs[0].srcIndex : -1,
        chainEnd: pairs.length ? lo + pairs[pairs.length - 1].srcIndex : -1
      })
    }
    let verdict = 'reading'
    if (maxRun < 3 && strongCount / m < 0.15) verdict = 'offtext'
    return this._result(verdict, newPos, {
      advanced,
      effectiveCount: m,
      strongCount,
      weakCount,
      matchRate: pairs.length / m,
      strongRate: strongCount / m,
      consecutiveStrong: maxRun,
      score: bestScore,
      reason: verdict === 'offtext' ? 'low-match' : (advanced ? 'advanced' : 'behind'),
      pairs,
      chainStart: pairs.length ? lo + pairs[0].srcIndex : -1,
      chainEnd: pairs.length ? lo + pairs[pairs.length - 1].srcIndex : -1
    })
  }
}
/**
 * 惩罚判定状态机（纯逻辑、时间可注入）。
 * 所有方法都显式接收 now（毫秒），便于用假时钟做单元测试。
 */
class ReadingTriggerMachine {
  constructor(options, clock) {
    const opts = options || {}
    this.cfg = {
      silenceLimit: 6,
      stallLimit: 20,
      warnLead: 2,
      cooldown: 5,
      startGrace: 5,
      checkContent: true,
      stallAdvanceChars: 5,
      stallBadSegments: 3,
      maxShocksPerMinute: RG_CONST.MAX_SHOCKS_PER_MINUTE,
      maxTickGapMs: 1000,
      sttTimeout: 15000
    }
    Object.keys(opts).forEach(key => {
      if (this.cfg.hasOwnProperty(key) && opts[key] != null) this.cfg[key] = opts[key]
    })
    this.clock = typeof clock === 'function' ? clock : () => Date.now()
    this.reset(this.clock())
  }

  reset(now) {
    const t = Number(now) || 0
    this.startedAt = t
    this.lastVoiceAt = t
    this.lastEnergyAt = t
    this.graceUntil = t + this.cfg.startGrace * 1000
    this.cooldownUntil = 0
    this.warning = null
    this.shockTimes = []
    this.shockCount = 0
    this.pos = 0
    this.ended = false
    this.paused = false
    this.degraded = false
    this.transportOk = true
    this.tailGuard = false
    this.t2Blocked = false
    this.unknownStreak = 0
    this.badSegments = []
    this.advances = []
    this.positionSamples = [{ t, pos: 0 }]
    this.lastSampleAt = t
    this.lastTickAt = t
    this.audioNowMs = 0
  }

  setEnded() {
    this.ended = true
    this.warning = null
  }

  // 警告提前量：按配置完整给出（dueAt 仍会保证至少 now + warnLead）
  _warnLeadMs() {
    return Math.max(0, Number(this.cfg.warnLead) || 0) * 1000
  }

  _addSample(now) {
    this.positionSamples.push({ t: Number(now), pos: this.pos })
    if (this.positionSamples.length > 600) this.positionSamples.shift()
  }

  _positionAt(from) {
    let p = 0
    for (let k = 0; k < this.positionSamples.length; k++) {
      const s = this.positionSamples[k]
      if (s.t <= from) p = s.pos
      else break
    }
    return p
  }

  setVoice(now) {
    const t = Number(now)
    this.lastVoiceAt = t
    this.lastEnergyAt = t
    if (this.warning && this.warning.reason === 'T1') {
      this.warning = null
      return { action: 'cancel', reason: 'T1' }
    }
    return { action: 'none' }
  }

  // 识别结果反向佐证：这段音频确实在读，刷新最后有声时间
  markAudioEvidence(now, audioEndWallMs) {
    const end = Number(audioEndWallMs)
    if (!isFinite(end)) return
    this.lastVoiceAt = Math.max(this.lastVoiceAt, end)
    this.lastEnergyAt = Math.max(this.lastEnergyAt || 0, end)
  }

  setAudioNow(ms) {
    this.audioNowMs = Math.max(0, Number(ms) || 0)
  }

  // T2 延长：只有“音频起点不早于警告起点”的在途请求才允许；
  // 单请求上限 requestStart + sttTimeout + warnLead，总上限警告开始 + 2×sttTimeout
  extendWarning(now, allow, requestStartMs) {
    const t = Number(now)
    if (!this.warning || this.warning.reason !== 'T2') return false
    if (!allow) return false
    const w = this.warning
    const timeout = Math.max(0, Number(this.cfg.sttTimeout) || 0)
    const totalLimit = w.startedAt + timeout * 2
    const reqStart = Number(requestStartMs)
    const reqLimit = isFinite(reqStart) ? reqStart + timeout + this._warnLeadMs() : totalLimit
    const limit = Math.min(totalLimit, reqLimit)
    w.maxDueAt = limit
    const want = Math.max(0, t + this._warnLeadMs() - w.dueAt)
    const add = Math.min(want, limit - w.dueAt)
    if (add <= 0) return false
    w.dueAt += add
    w.extendedMs += add
    return true
  }

  setT2Blocked(on) {
    this.t2Blocked = !!on
  }

  // 把沉默计时推进到“恰好该开始 T1 警告”，下一次 tick 立刻给满 warnLead
  armSilenceWarning(now) {
    const t = Number(now)
    const arm = Math.max(0, this.cfg.silenceLimit * 1000 - this._warnLeadMs())
    this.lastVoiceAt = t - arm
    this.lastEnergyAt = t - arm
    if (this.warning && this.warning.reason === 'T1') this.warning = null
  }

  // 只解除等待标记，不改变沉默计时（用户恢复出声时使用）
  clearTailGuard() {
    this.tailGuard = false
  }

  setPosition(now, pos) {
    const t = Number(now)
    const next = Number(pos) || 0
    if (this.ended || this.paused) return { advanced: false, chars: 0 }
    if (next <= this.pos) return { advanced: false, chars: 0 }
    const chars = next - this.pos
    this.pos = next
    this.advances.push({ t, chars })
    this._addSample(t)
    if (this.warning && this.warning.reason === 'T2') this.warning = null
    return { advanced: true, chars }
  }

  setPaused(now, paused) {
    const t = Number(now)
    this.paused = !!paused
    if (this.paused) {
      this.warning = null
    } else {
      // 恢复时不把暂停期间的沉默算进 T1
      this.lastVoiceAt = t
      this.lastEnergyAt = t
      this.lastTickAt = t
      this.graceUntil = t + this.cfg.startGrace * 1000
    }
  }

  onSegment(now, seg) {
    const t = Number(now)
    if (this.ended) return
    const verdict = seg && seg.verdict
    if (this.warning && this.warning.reason === 'T2') {
      if (verdict === 'reading' && seg.advanced) {
        // 只有真的前进了才取消；reading 但没前进仍算 T2 证据
        this.warning = null
      } else if (verdict === 'offtext' &&
          Number(seg.audioStartMs) >= Number(this.warning.audioStartMs || 0)) {
        // 必须是一段“从警告开始之后才开始录”的音频，旧音频不能确认
        this.warning.t2Confirmed = true
      }
    }
    if (verdict === 'unknown') {
      if (this.cfg.checkContent) {
        this.unknownStreak += 1
        if (this.unknownStreak >= 3) this.degraded = true
      }
      return
    }
    if (verdict === 'reading' || verdict === 'offtext') {
      this.unknownStreak = 0
      if (this.degraded) this.degraded = false
      if (verdict === 'offtext' || (verdict === 'reading' && !seg.advanced)) {
        this.badSegments.push({ t, verdict, advanced: !!seg.advanced })
      }
    }
    const from = t - this.cfg.stallLimit * 1000
    this.badSegments = this.badSegments.filter(s => s.t >= from)
    this.advances = this.advances.filter(a => a.t >= from)
  }

  setTransportOk(ok) {
    this.transportOk = !!ok
  }

  // 临近结尾且还有识别请求在途时，暂缓 T1，避免读完后因识别延迟被误电击
  setTailGuard(on, now) {
    const next = !!on
    if (this.tailGuard && !next) {
      // 等待结束：把沉默计时推进到“刚好该开始警告”，下一次 tick 立刻给满 warnLead
      const t = now != null ? Number(now) : this.clock()
      const arm = Math.max(0, this.cfg.silenceLimit * 1000 - this._warnLeadMs())
      this.lastVoiceAt = t - arm
      this.lastEnergyAt = t - arm
      if (this.warning && this.warning.reason === 'T1') this.warning = null
    }
    this.tailGuard = next
  }

  t2Condition(now) {
    const t = Number(now)
    if (this.t2Blocked) return false
    if (!this.cfg.checkContent || this.degraded || this.paused || this.ended) return false
    if (t - this.startedAt < this.cfg.stallLimit * 1000) return false
    const from = t - this.cfg.stallLimit * 1000
    const advance = this.pos - this._positionAt(from)
    const bad = this.badSegments.filter(s => s.t >= from).length
    const hasAdvance = this.advances.some(a => a.t >= from && a.chars > 0)
    return advance < this.cfg.stallAdvanceChars &&
      bad >= this.cfg.stallBadSegments &&
      !hasAdvance
  }

  tick(now) {
    const t = Number(now)
    this.shockTimes = this.shockTimes.filter(x => t - x < 60000)
    if (this.ended) return { action: 'none' }
    if (this.paused) return { action: 'paused' }
    if (this.lastTickAt != null && t - this.lastTickAt > this.cfg.maxTickGapMs) {
      // 定时器被节流/卡顿：本次不判定，避免拿着过期时间直接电击
      this.lastTickAt = t
      this.lastVoiceAt = t
      this.lastEnergyAt = t
      this.warning = null
      return { action: 'stalled' }
    }
    this.lastTickAt = t
    if (this.warning) {
      const w = this.warning
      if (w.reason === 'T1') {
        if (this.tailGuard) {
          this.warning = null
          return { action: 'cancel', reason: 'T1' }
        }
        if (t - this.lastEnergyAt < (this.cfg.silenceLimit * 1000 - this._warnLeadMs())) {
          this.warning = null
          return { action: 'cancel', reason: 'T1' }
        }
      } else if (w.reason === 'T2') {
        if (!w.t2Confirmed && t >= w.dueAt) {
          this.warning = null
          return { action: 'cancel', reason: 'T2-limit' }
        }
        if (!this.t2Condition(t)) {
          this.warning = null
          return { action: 'cancel', reason: 'T2' }
        }
        if (!w.t2Confirmed) {
          // 没有“警告开始之后才开始录”的离稿结果：延长到上限后取消，绝不按旧时间电击
          return {
            action: 'warning',
            reason: 'T2',
            remaining: Math.max(0, w.dueAt - t)
          }
        }
      }
      if (t >= w.dueAt) {
        this.warning = null
        if (this.shockTimes.length >= this.cfg.maxShocksPerMinute) {
          this.cooldownUntil = t + this.cfg.cooldown * 1000
          this.lastVoiceAt = t
          return { action: 'limit', reason: w.reason }
        }
        this.shockTimes.push(t)
        this.shockCount += 1
        this.cooldownUntil = t + this.cfg.cooldown * 1000
        this.lastVoiceAt = t
        this._addSample(t)
        return { action: 'shock', reason: w.reason, shockCount: this.shockCount }
      }
      return {
        action: 'warning',
        reason: w.reason,
        remaining: Math.max(0, w.dueAt - t)
      }
    }
    if (t < this.graceUntil || t < this.cooldownUntil) return { action: 'none' }
    const silenceMs = t - this.lastEnergyAt
    if (!this.tailGuard && silenceMs >= this.cfg.silenceLimit * 1000 - this._warnLeadMs()) {
      this.warning = {
        reason: 'T1',
        startedAt: t,
        dueAt: Math.max(this.lastVoiceAt + this.cfg.silenceLimit * 1000,
          t + this._warnLeadMs())
      }
      return { action: 'warn-start', reason: 'T1', remaining: this.warning.dueAt - t }
    }
    if (this.transportOk && t - this.startedAt >= this.cfg.stallLimit * 1000 && this.t2Condition(t)) {
      this.warning = {
        reason: 'T2',
        startedAt: t,
        dueAt: t + this._warnLeadMs(),
        audioStartMs: this.audioNowMs,
        t2Confirmed: false,
        extendedMs: 0,
        maxDueAt: t + this._warnLeadMs()
      }
      return { action: 'warn-start', reason: 'T2', remaining: this.warning.dueAt - t, audioStartMs: this.warning.audioStartMs }
    }
    if (t - this.lastSampleAt >= 1000) {
      this.lastSampleAt = t
      this._addSample(t)
    }
    return { action: 'none' }
  }
}
/**
 * 本地 VAD：300-3400Hz 频段能量 + 自适应阈值 + 起音/拖尾。
 * 只回答“有没有出声”，不判断内容。
 */
class VoiceDetector {
  constructor(options) {
    const opts = options || {}
    this.calibrateMs = opts.calibrateMs != null ? opts.calibrateMs : RG_CONST.CALIBRATE_MS
    this.onsetMs = opts.onsetMs != null ? opts.onsetMs : RG_CONST.ONSET_MS
    this.hangoverMs = opts.hangoverMs != null ? opts.hangoverMs : RG_CONST.HANGOVER_MS
    this.floor = 0
    this.voiceLevel = 0
    this.threshold = 8
    this.isVoiced = false
    this.lastVoiceAt = 0
    this.calibrated = false
    this.calibStart = 0
    this.levels = []
    this.aboveSince = 0
    this.belowSince = 0
    this.zeroSince = 0
    this.justCalibrated = false
    this.energyAboveSince = 0
    this.energyBelowSince = 0
    this.energyVoiced = false
    this.lastEnergyAt = 0
    this.thresholdEnergy = 8
  }

  startCalibration(now) {
    const t = Number(now) || 0
    this.calibrated = false
    this.calibStart = t
    this.levels = []
    this.isVoiced = false
    this.energyVoiced = false
    this.aboveSince = 0
    this.belowSince = 0
    this.energyAboveSince = 0
    this.energyBelowSince = 0
    this.lastVoiceAt = t
    this.lastEnergyAt = t
  }

  _percentile(values, p) {
    if (!values.length) return 0
    const sorted = values.slice().sort((a, b) => a - b)
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))))
    return sorted[idx]
  }

  _updateThreshold() {
    // 阈值可以随人声电平回落；校准失误时也不至于长期高到听不见正常朗读
    this.voiceLevel *= 0.97
    if (this.voiceLevel > this.floor + 10) {
      const span = this.voiceLevel - this.floor
      const candidate = this.floor + Math.max(6, span * 0.3)
      this.threshold = Math.min(this.floor + 45, Math.max(this.floor + 6, candidate))
    } else {
      this.threshold = Math.max(8, Math.min(this.threshold, this.floor + 8))
    }
    this.thresholdEnergy = Math.max(6, Math.min(this.floor + 4, this.threshold))
  }

  process(level, now, peak) {
    const t = Number(now)
    const loud = Number(level) || 0
    const peakValue = Number(peak) || 0
    this.justCalibrated = false
    if (!this.calibrated) {
      if (!this.calibStart) {
        this.calibStart = t
        this.lastVoiceAt = t
        this.lastEnergyAt = t
      }
      this.levels.push(loud)
      if (t - this.calibStart >= this.calibrateMs && this.levels.length >= 20) {
        // 分三段取各自低分位，再取最低值：避免某一段有人说话/电视把底噪抬高
        const third = Math.floor(this.levels.length / 3)
        const lows = []
        for (let i = 0; i < 3; i++) {
          const part = this.levels.slice(i * third, i === 2 ? this.levels.length : (i + 1) * third)
          lows.push(this._percentile(part, 0.2))
        }
        this.floor = Math.min.apply(null, lows)
        this.threshold = Math.max(12, Math.min(this.floor + 8, 30))
        this.thresholdEnergy = Math.max(8, Math.min(this.floor + 4, this.threshold))
        this.calibrated = true
        this.lastVoiceAt = t
        this.lastEnergyAt = t
        this.justCalibrated = true
      }
      return {
        voiced: false,
        above: false,
        calibrating: !this.calibrated,
        justCalibrated: this.justCalibrated,
        threshold: this.threshold,
        thresholdEnergy: this.thresholdEnergy,
        floor: this.floor,
        voiceLevel: this.voiceLevel,
        lastVoiceAt: this.lastVoiceAt,
        lastEnergyAt: this.lastEnergyAt,
        energyAbove: false,
        micAbnormal: false
      }
    }

    // 底噪缓慢跟随更低的电平，避免一次大声之后阈值长期居高不下
    if (loud < this.floor) this.floor = this.floor * 0.98 + loud * 0.02
    if (loud > this.floor + 10) this.voiceLevel = Math.max(this.voiceLevel, loud)
    this._updateThreshold()

    const above = loud >= this.threshold
    if (above) {
      this.belowSince = 0
      if (!this.aboveSince) this.aboveSince = t
      if (!this.isVoiced && t - this.aboveSince >= this.onsetMs) {
        this.isVoiced = true
      }
      if (this.isVoiced) this.lastVoiceAt = t
    } else {
      this.aboveSince = 0
      if (this.isVoiced) {
        if (!this.belowSince) this.belowSince = t
        if (t - this.belowSince >= this.hangoverMs) {
          this.isVoiced = false
          this.belowSince = 0
        } else {
          this.lastVoiceAt = t
        }
      }
    }

    // T1 用更宽松的“有能量”门槛：只要持续有能量，就不算沉默
    const energyAbove = loud >= this.thresholdEnergy
    if (energyAbove) {
      this.energyBelowSince = 0
      if (!this.energyAboveSince) this.energyAboveSince = t
      if (!this.energyVoiced && t - this.energyAboveSince >= this.onsetMs) this.energyVoiced = true
      if (this.energyVoiced) this.lastEnergyAt = t
    } else {
      this.energyAboveSince = 0
      if (this.energyVoiced) {
        if (!this.energyBelowSince) this.energyBelowSince = t
        if (t - this.energyBelowSince >= this.hangoverMs) {
          this.energyVoiced = false
          this.energyBelowSince = 0
        } else {
          this.lastEnergyAt = t
        }
      }
    }

    let micAbnormal = false
    if (peakValue < 0.00001) {
      if (!this.zeroSince) this.zeroSince = t
      else if (t - this.zeroSince >= 2000) micAbnormal = true
    } else {
      this.zeroSince = 0
    }

    return {
      voiced: this.isVoiced,
      above,
      energyAbove,
      calibrating: false,
      justCalibrated: false,
      threshold: this.threshold,
      thresholdEnergy: this.thresholdEnergy,
      floor: this.floor,
      voiceLevel: this.voiceLevel,
      lastVoiceAt: this.lastVoiceAt,
      lastEnergyAt: this.lastEnergyAt,
      micAbnormal
    }
  }
}

/**
 * 环形 PCM 缓冲：保存最近 N 秒的 16bit 单声道采样（Float32 存储）
 */
class PcmRingBuffer {
  constructor(seconds, sampleRate) {
    this.sampleRate = sampleRate || RG_CONST.SAMPLE_RATE
    this.cap = Math.max(1, Math.floor(seconds * this.sampleRate))
    this.data = new Float32Array(this.cap)
    this.write = 0
    this.total = 0
  }

  push(chunk) {
    if (!chunk || !chunk.length) return
    const data = this.data
    const cap = this.cap
    let w = this.write
    for (let i = 0; i < chunk.length; i++) {
      data[w] = chunk[i]
      w += 1
      if (w >= cap) w = 0
    }
    this.write = w
    this.total += chunk.length
  }

  availableSeconds() {
    return Math.min(this.total, this.cap) / this.sampleRateValue()
  }

  sampleRateValue() {
    return this.sampleRate || 16000
  }

  // 取绝对采样区间 [start, end)
  getRange(start, end) {
    const cap = this.cap
    let s = Math.max(0, Math.floor(start))
    let e = Math.min(this.total, Math.floor(end))
    if (e - s > cap) s = e - cap
    if (e <= s) return null
    const out = new Float32Array(e - s)
    let idx = s % cap
    for (let i = 0; i < out.length; i++) {
      out[i] = this.data[idx]
      idx += 1
      if (idx >= cap) idx = 0
    }
    return out
  }
}

function rgResample(samples, fromRate, toRate) {
  if (!samples || !samples.length) return new Float32Array(0)
  if (fromRate === toRate) return samples
  const outLen = Math.max(1, Math.round(samples.length * toRate / fromRate))
  const out = new Float32Array(outLen)
  const step = fromRate / toRate
  for (let i = 0; i < outLen; i++) {
    const pos = i * step
    const i0 = Math.floor(pos)
    const i1 = Math.min(samples.length - 1, i0 + 1)
    const frac = pos - i0
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac
  }
  return out
}

function rgEncodeWav(samples, sampleRate) {
  const dataLen = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buffer)
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataLen, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    let v = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true)
    offset += 2
  }
  return new Uint8Array(buffer)
}

function rgWorkletCode() {
  return `
class RGRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(2048)
    this.len = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || !input.length || !input[0]) return true
    const ch = input[0]
    let i = 0
    while (i < ch.length) {
      const n = Math.min(ch.length - i, this.buf.length - this.len)
      this.buf.set(ch.subarray(i, i + n), this.len)
      this.len += n
      i += n
      if (this.len >= this.buf.length) {
        const out = new Float32Array(this.buf)
        this.port.postMessage(out, [out.buffer])
        this.len = 0
      }
    }
    return true
  }
}
registerProcessor('rg-recorder', RGRecorder)
`
}

// 16kHz 单声道 WAV 的 Uint8Array → base64（DeviceAPI.speech.transcribe 的 audio 字段）
function rgBytesToBase64(bytes) {
  if (!bytes || !bytes.length) return ''
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  }
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function rgVerdictLabel(verdict) {
  if (verdict === 'reading') return '在读'
  if (verdict === 'offtext') return '离稿'
  if (verdict === 'silent') return '无声'
  return '未知'
}

  return {
    RG_CONST,
    rgNormInitial,
    rgNormFinal,
    rgEditSim,
    rgSyllableSim,
    rgMatchScore,
    rgEscapeHtml,
    rgBytesToBase64,
    rgVerdictLabel,
    rgResample,
    rgEncodeWav,
    rgWorkletCode,
    ReadingAligner,
    ReadingTriggerMachine,
    VoiceDetector,
    PcmRingBuffer
  }
})
