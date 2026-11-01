/**
 * 背单词游戏页面编排（Vocabulary Game）
 * 负责：开始页/答题页/完成页、每题倒计时、电击、自动锁、语音口令、云存档同步。
 * 纯逻辑在 vocab-core.js，语音采集在 voice.js；规格见 docs/plans/vocab-game.md。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory({
      core: require('./vocab-core.js'),
      voice: require('./voice.js')
    })
  } else {
    root.VocabGameModule = factory({
      core: root.VocabCore,
      voice: root.VocabVoice
    })
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (mods) {
  'use strict'

  const VC = mods.core
  const VV = mods.voice
  const t = (zh, vars) => {
    if (typeof GameI18n !== 'undefined' && GameI18n.t) return GameI18n.t(zh, vars)
    if (vars && typeof vars === 'object') {
      return String(zh).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])))
    }
    return zh
  }

  const BANK_IDS = ['gaokao', 'cet4', 'cet6', 'ielts']
  const BANK_LABELS = { gaokao: '高考', cet4: '四级', cet6: '六级', ielts: '雅思' }
  const DEFAULT_CONFIG = {
    bank: 'cet4',
    newPerDay: 20,
    reviewCap: 100,
    questionTime: 20,
    totalTime: 60,
    inputMode: 'touch',
    autoSpeak: true,
    punishUnknown: true,
    shockVoltage: 15,
    shockDuration: 2
  }

  function clamp(value, min, max) {
    const n = Number(value)
    if (!isFinite(n)) return min
    return Math.max(min, Math.min(max, n))
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round(Number(ms) / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return m + ':' + (s < 10 ? '0' + s : String(s))
  }

  function formatPhonetic(text) {
    const raw = String(text == null ? '' : text).trim()
    if (!raw) return ''
    if (raw.charAt(0) === '/' && raw.charAt(raw.length - 1) === '/') return raw
    return '/' + raw + '/'
  }

  function memoryStorage() {
    const map = new Map()
    return {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)) },
      removeItem: key => { map.delete(key) }
    }
  }

  function safeStorage(env) {
    try {
      const storage = env && env.localStorage
      const probe = '__vg_probe__'
      storage.setItem(probe, '1')
      storage.removeItem(probe)
      return storage
    } catch (_) {
      return memoryStorage()
    }
  }

  function loadBank(env, id) {
    const banks = env && env.VG_BANKS
    if (!banks || !banks[id]) return null
    const bank = banks[id]
    const words = VC.normalizeBank(bank)
    if (!words.length) return null
    return {
      id: id,
      name: String(bank.name || BANK_LABELS[id] || id),
      nameEn: String(bank.nameEn || ''),
      words: words
    }
  }

  class VocabGame {
    constructor(options) {
      const opts = options || {}
      this.env = opts.window || (typeof window !== 'undefined' ? window : null)
      this.doc = opts.document || (typeof document !== 'undefined' ? document : null)
      this.deviceApi = opts.deviceApi || (this.env && this.env.DeviceAPI) || null
      this.cloud = opts.cloud !== undefined
        ? opts.cloud
        : (this.deviceApi && this.deviceApi.cloud) || null
      this.timers = opts.timers || {
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: id => clearInterval(id),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: id => clearTimeout(id)
      }
      this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
      this.random = typeof opts.random === 'function' ? opts.random : Math.random
      this.storage = opts.storage || safeStorage(this.env)
      this.config = Object.assign({}, DEFAULT_CONFIG)
      this.testAudioUrl = opts.testAudioUrl || VV.parseTestAudioFromLocation(this.env && this.env.location)
      this.voice = opts.voice || new VV.VoiceCommandListener({
        window: this.env,
        deviceApi: this.deviceApi,
        timers: this.timers,
        now: this.now,
        testAudioUrl: this.testAudioUrl,
        onResult: result => this._onVoiceResult(result),
        onStatus: (status, detail) => this._onVoiceStatus(status, detail),
        onError: error => this._log('语音识别失败: ' + ((error && error.message) || error), 'warning')
      })
      this.plan = null
      this.save = VC.normalizeSave(null)
      this.bank = null
      this.bankWords = []
      this.wordMap = new Map()
      this.bankName = ''
      this.userId = ''
      this.signedIn = false
      this.loginText = t('读取中…')
      this.cloudVersion = 0
      this.online = false
      this.planReady = false
      this.starting = false
      this.syncState = 'offline'
      this.dirty = false
      this.uploading = false
      this.uploadPending = false
      this.answersSinceUpload = 0
      this.lastUploadAt = 0
      this.session = { answers: 0, startedAt: 0 }
      this.today = VC.dayIndex(this.now())
      this.queue = new VC.QuizQueue([])
      this.state = {
        view: 'start',
        paused: false,
        pausedAt: 0,
        question: null,
        selected: 0,
        correctIndex: 0,
        questionSeq: 0,
        questionEndsAt: 0,
        totalEndsAt: 0,
        answered: false,
        locked: null
      }
      this.tickTimer = null
      this.answerTimer = null
      this.shockTimer = null
      this.shockGen = 0
      this.toastTimer = null
      this.voiceMissTimer = null
      this.voiceOk = false
      this.voiceFallback = false
      this.voiceMode = String(this.config.inputMode) === 'voice'
      this.visibilityHandler = null
      this.unloadHandler = null
      this.keyHandler = null
    }

    updateParameters(params) {
      const next = params || {}
      Object.keys(next).forEach(key => {
        if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) this.config[key] = next[key]
      })
      this.voiceMode = String(this.config.inputMode) === 'voice'
    }

    _byId(id) {
      return this.doc && typeof this.doc.getElementById === 'function' ? this.doc.getElementById(id) : null
    }

    _setText(id, text) {
      const el = this._byId(id)
      if (el) el.textContent = text == null ? '' : String(text)
    }

    _setHidden(id, hidden) {
      const el = this._byId(id)
      if (el) el.hidden = !!hidden
    }

    _log(message, level) {
      const lv = level || 'info'
      if (this.deviceApi && typeof this.deviceApi.log === 'function') {
        try { this.deviceApi.log(lv, message) } catch (_) {}
      }
      if (typeof console !== 'undefined' && console.log) console.log('[VOCAB-' + lv.toUpperCase() + '] ' + message)
    }

    _withTimeout(promise, ms) {
      return Promise.race([
        Promise.resolve(promise),
        new Promise(resolve => this.timers.setTimeout(() => resolve(null), ms))
      ])
    }

    async init() {
      this._applyI18n()
      this._bindUI()
      this._renderStart()
      this._renderStatus()
      await this.prepare()
      this._renderStart()
      this._renderStatus()
    }

    _applyI18n() {
      if (typeof GameI18n !== 'undefined' && GameI18n.apply) GameI18n.apply()
      if (this.doc && this.doc.body && this.doc.body.classList) {
        if (this.voiceMode) this.doc.body.classList.add('voice-mode')
        else this.doc.body.classList.remove('voice-mode')
      }
    }

    _bindUI() {
      if (!this.doc || typeof this.doc.getElementById !== 'function') return
      const start = this._byId('vg-start-btn')
      if (start && typeof start.addEventListener === 'function') {
        start.addEventListener('click', () => {
          // 必须在用户手势里同步创建/恢复 AudioContext（iOS / Android WebView）。
          this.voice.prime()
          this._handleStart().catch(error => this._startFailed(error))
        })
      }
      const stop = this._byId('vg-stop-btn')
      if (stop && typeof stop.addEventListener === 'function') {
        stop.addEventListener('click', () => this.emergencyStop())
      }
      const cont = this._byId('vg-continue')
      if (cont && typeof cont.addEventListener === 'function') {
        cont.addEventListener('click', () => this.continueQuestion())
      }
      const unknown = this._byId('vg-unknown')
      if (unknown && typeof unknown.addEventListener === 'function') {
        unknown.addEventListener('click', () => this.markUnknown())
      }
      const speak = this._byId('vg-speak')
      if (speak && typeof speak.addEventListener === 'function') {
        speak.addEventListener('click', () => {
          if (this.state.question) this.speakWord(this.state.question.word, true)
        })
      }
      const options = this._byId('vg-options')
      if (options && typeof options.addEventListener === 'function') {
        options.addEventListener('click', event => {
          const target = event && event.target
          const button = target && typeof target.closest === 'function' ? target.closest('.vg-opt') : null
          if (!button) return
          this.answer(Number(button.getAttribute('data-index')))
        })
      }
      const back = this._byId('vg-back')
      if (back && typeof back.addEventListener === 'function') {
        back.addEventListener('click', () => this.backToStart())
      }
      const extra = this._byId('vg-extra')
      if (extra && typeof extra.addEventListener === 'function') {
        extra.addEventListener('click', () => {
          this.voice.prime()
          this._handleStart().catch(error => this._startFailed(error))
        })
      }
      if (this.doc && typeof this.doc.addEventListener === 'function' && !this.visibilityHandler) {
        this.visibilityHandler = () => {
          if (this.doc.hidden) this.pause()
          else this.resume()
        }
        this.doc.addEventListener('visibilitychange', this.visibilityHandler)
      }
      if (this.env && typeof this.env.addEventListener === 'function' && !this.unloadHandler) {
        this.unloadHandler = () => this._onPageHide()
        this.env.addEventListener('pagehide', this.unloadHandler)
        this.env.addEventListener('beforeunload', this.unloadHandler)
        this.keyHandler = event => {
          if (event && event.key === 'Escape') this.emergencyStop()
        }
        this.env.addEventListener('keydown', this.keyHandler)
      }
    }

    async prepare() {
      const api = this.deviceApi
      if (!api || !api.cloud) {
        this.signedIn = false
        this.loginText = t('此客户端不支持云存档')
        this.planReady = true
        this.syncState = 'offline'
        return
      }
      this.cloud = api.cloud
      let status = null
      try {
        status = await this._withTimeout(Promise.resolve().then(() => this.cloud.status()), 1500)
      } catch (_) {
        status = null
      }
      if (!status || status.signedIn !== true) {
        this.signedIn = false
        this.loginText = status ? t('未登录') : t('无法获取登录状态')
        this.planReady = true
        this.syncState = 'offline'
        return
      }
      this.signedIn = true
      const user = status.user || {}
      this.userId = String(user.id || user.nickname || 'user')
      this.loginText = t('已登录：{name}', { name: String(user.nickname || user.id || '') })
      const cache = this._readCache()
      let remote = null
      try {
        remote = await this._withTimeout(Promise.resolve().then(() => this.cloud.get()), 8000)
        this.online = !!remote
      } catch (error) {
        this.online = false
        this._log('读取云存档失败: ' + ((error && error.message) || error), 'warning')
      }
      const remoteData = remote && remote.data ? remote.data : null
      this.save = VC.pruneSave(VC.mergeSaves(cache.save, remoteData), this.today)
      this.cloudVersion = remote && remote.version != null
        ? Number(remote.version) || 0
        : Number(cache.version) || 0
      this._setSync(this.online ? 'synced' : 'offline')
      this._writeCache()
      this._ensurePlan()
      this.planReady = true
      this._renderStart()
      this._renderStatus()
      this._applyI18n()
      if (this.online && this.dirty) this._maybeUpload()
    }

    _cacheKey() {
      return 'vocab-game:save:' + (this.userId || 'user')
    }

    _readCache() {
      try {
        const raw = this.storage.getItem(this._cacheKey())
        const parsed = raw ? JSON.parse(raw) : null
        return {
          save: VC.normalizeSave(parsed && parsed.save),
          version: Number(parsed && parsed.version) || 0
        }
      } catch (_) {
        return { save: VC.normalizeSave(null), version: 0 }
      }
    }

    _writeCache() {
      try {
        this.storage.setItem(this._cacheKey(), JSON.stringify({
          save: this.save,
          version: this.cloudVersion,
          updatedAt: this.now()
        }))
      } catch (_) {}
    }

    _ensurePlan() {
      this.today = VC.dayIndex(this.now())
      const key = VC.dateKey(this.now())
      const stored = this.save.plans[key]
      const storedPlan = stored && Array.isArray(stored.ids) ? stored : null
      let bankId = String(this.config.bank || 'cet4')
      if (bankId !== 'gaokao' && bankId !== 'cet4' && bankId !== 'cet6' && bankId !== 'ielts') bankId = 'cet4'
      // 当天计划已经生成时沿用计划里的词库，避免中途改配置把今天的进度拆开。
      if (storedPlan && storedPlan.bank) bankId = String(storedPlan.bank)
      const bank = loadBank(this.env, bankId)
      this.bank = bank
      this.bankWords = bank ? bank.words : []
      this.wordMap = new Map(this.bankWords.map(word => [word.id, word]))
      this.bankName = bank
        ? ((typeof GameI18n !== 'undefined' && GameI18n.isEn && GameI18n.isEn() && bank.nameEn) ? bank.nameEn : bank.name)
        : t(BANK_LABELS[bankId] || bankId)
      if (storedPlan) {
        this.plan = storedPlan
        return
      }
      if (!bank) {
        this.plan = null
        this._log('词库未加载: ' + bankId, 'error')
        return
      }
      this.plan = VC.buildDailyPlan({
        bank: bankId,
        bankIds: this.bankWords.map(word => word.id),
        progress: this.save.words,
        today: this.today,
        now: this.now(),
        newPerDay: clamp(this.config.newPerDay, 0, 200),
        reviewCap: clamp(this.config.reviewCap, 0, 500),
        random: this.random
      })
      this.save.plans[key] = this.plan
      this.dirty = true
      this._writeCache()
    }

    async _handleStart() {
      if (this.starting) return
      if (!this.signedIn) {
        this._toast(t('请先在客户端登录账号'), 2500)
        return
      }
      if (!this.planReady) {
        this._toast(t('存档读取中…'))
        return
      }
      if (!this.bankWords.length) {
        this._toast(t('词库未加载，请检查 banks 目录'), 3000)
        return
      }
      this.starting = true
      try {
        await this.startGame()
      } catch (error) {
        this._startFailed(error)
      } finally {
        this.starting = false
      }
    }

    _startFailed(error) {
      this._log('启动失败: ' + ((error && error.message) || error), 'error')
      this._stopTick()
      this.stopShock()
      this._stopVoice()
      this.setLock(true)
      this._maybeUpload(true)
      this.state.view = 'start'
      this.state.paused = false
      this._switchView('start')
      this._renderStart()
      this._toast(t('启动失败：{msg}', { msg: (error && error.message) || error }), 3000)
    }

    async startGame() {
      if (!this.plan) return false
      const key = VC.dateKey(this.now())
      const wasComplete = VC.isPlanComplete(this.plan)
      let plan = this.plan
      if (wasComplete) {
        const extra = VC.buildExtraPlan(plan, {
          bankIds: this.bankWords.map(word => word.id),
          progress: this.save.words,
          newPerDay: clamp(this.config.newPerDay, 0, 200),
          now: this.now()
        })
        if (!extra.added) {
          this._toast(t('没有更多新词了'), 2500)
          return false
        }
        plan = extra.plan
        this.plan = plan
        this.save.plans[key] = plan
        this.dirty = true
        this._writeCache()
        this._renderStart()
      }
      const now = this.now()
      this.today = VC.dayIndex(now)
      // 「再学一组」沿用本轮的答题数；正常开始则重新统计。
      if (!wasComplete || !this.session.startedAt) {
        this.session = { answers: 0, startedAt: now }
      }
      this.state.view = 'playing'
      this.state.paused = false
      this.state.pausedAt = 0
      this.state.question = null
      this.state.selected = 0
      this.state.correctIndex = 0
      this.state.questionSeq = 0
      this.state.questionEndsAt = 0
      this.state.answered = false
      this.queue = new VC.QuizQueue(VC.planRemaining(plan))
      const minutes = clamp(this.config.totalTime, 0, 600)
      this.state.totalEndsAt = minutes > 0 ? now + minutes * 60000 : 0
      this._switchView('play')
      this._startTick()
      // 今日任务未完成时上锁；「再学一组」不再上锁。
      if (!wasComplete) this.setLock(false)
      this._log('开始答题：' + this.bankName + '，今天剩余 ' + this.queue.length + ' 题', 'info')
      this.nextQuestion()
      if (this.voiceMode) await this._startVoice()
      this._renderStatus()
      return true
    }

    async _startVoice() {
      if (!this.voiceMode) return false
      const speech = this.deviceApi && this.deviceApi.speech
      if (!speech || typeof speech.transcribe !== 'function') return this._voiceFallback('no-speech-api')
      let status = null
      try {
        status = await this._withTimeout(Promise.resolve().then(() => speech.status()), 1500)
      } catch (_) {
        status = null
      }
      if (status && status.ready === false) return this._voiceFallback(status.reason || 'not-ready')
      try {
        await this.voice.start()
        this.voiceOk = true
        this._setVoiceCapsule('listening')
        return true
      } catch (error) {
        return this._voiceFallback((error && error.code) || (error && error.message))
      }
    }

    _voiceFallback(reason) {
      this.voiceOk = false
      this.voiceFallback = true
      this.voiceMode = false
      try {
        const stopping = this.voice.stop()
        if (stopping && typeof stopping.catch === 'function') stopping.catch(() => {})
      } catch (_) {}
      if (this.doc && this.doc.body && this.doc.body.classList) this.doc.body.classList.remove('voice-mode')
      this._setVoiceCapsule('off')
      this._log('语音识别不可用，退回点选: ' + (reason || ''), 'warning')
      this._toast(t('语音识别不可用，已改用点选'), 2500)
      return false
    }

    _stopVoice() {
      this.voiceOk = false
      this._setVoiceCapsule('off')
      try {
        const stopping = this.voice.stop()
        if (stopping && typeof stopping.catch === 'function') stopping.catch(() => {})
      } catch (_) {}
    }

    _startTick() {
      this._stopTick()
      this.tickTimer = this.timers.setInterval(() => this._tick(), 100)
    }

    _stopTick() {
      if (this.tickTimer) {
        this.timers.clearInterval(this.tickTimer)
        this.tickTimer = null
      }
    }

    nextQuestion() {
      if (this.state.view !== 'playing' || this.state.answered) return
      let question = null
      while (this.queue.length) {
        const id = this.queue.next()
        const word = this.wordMap.get(id)
        if (!word) {
          this._log('词库里找不到单词，已跳过: ' + id, 'warning')
          if (!this.plan.done.includes(id)) this.plan.done.push(id)
          continue
        }
        const choices = VC.buildChoices(this.bankWords, id, this.random, 4)
        if (choices.length < 2) {
          this._log('选项不足，已跳过单词: ' + id, 'warning')
          if (!this.plan.done.includes(id)) this.plan.done.push(id)
          continue
        }
        question = {
          id: id,
          word: word.word,
          phonetic: word.phonetic,
          short: word.short,
          full: word.full,
          choices: choices
        }
        break
      }
      if (!question) {
        this.completePlan()
        return
      }
      const now = this.now()
      const seq = this.state.questionSeq + 1
      const correct = question.choices.findIndex(choice => choice.correct)
      this.state.questionSeq = seq
      this.state.question = question
      this.state.correctIndex = correct + 1
      this.state.selected = 0
      this.state.answered = false
      this.state.view = 'playing'
      const seconds = clamp(this.config.questionTime, 0, 120)
      this.state.questionEndsAt = seconds > 0 ? now + seconds * 1000 : 0
      this.voice.setSeq(seq)
      this._renderQuestion()
      this._renderStatus()
      if (this.config.autoSpeak !== false) this.speakWord(question.word)
    }

    answer(index) {
      const question = this.state.question
      if (!question || this.state.view !== 'playing' || this.state.answered || this.state.paused) return
      const choice = question.choices[index - 1]
      if (!choice) return
      if (choice.correct) this._correctAnswer()
      else this._wrongAnswer('wrong', index)
    }

    markUnknown() {
      if (this.state.view !== 'playing' || this.state.answered) return
      this._wrongAnswer('unknown', 0)
    }

    _correctAnswer() {
      const question = this.state.question
      if (!question) return
      const now = this.now()
      this.state.answered = true
      this.state.questionEndsAt = 0
      this._setOptionsDisabled(true)
      VC.recordAnswer(this.save, question.id, {
        correct: true,
        today: this.today,
        now: now
      })
      this.session.answers += 1
      if (!this.plan.done.includes(question.id)) this.plan.done.push(question.id)
      this.plan.u = now
      this._markDirtyAnswered()
      this._highlight(this.state.correctIndex, 0)
      this._renderStatus()
      const seq = this.state.questionSeq
      this.answerTimer = this.timers.setTimeout(() => this._afterCorrect(seq), 600)
    }

    _afterCorrect(seq) {
      if (seq !== this.state.questionSeq || this.state.view !== 'playing') return
      this.state.answered = false
      if (this.queue.length === 0) this.completePlan()
      else this.nextQuestion()
    }

    _wrongAnswer(reason, selected) {
      const question = this.state.question
      if (!question) return
      const now = this.now()
      this.state.answered = true
      this.state.questionEndsAt = 0
      this.state.selected = selected || 0
      this.state.view = 'answer'
      this._setOptionsDisabled(true)
      VC.recordAnswer(this.save, question.id, {
        correct: false,
        today: this.today,
        now: now
      })
      this.session.answers += 1
      this.plan.u = now
      this._markDirtyAnswered()
      this._highlight(this.state.correctIndex, this.state.selected)
      this._renderAnswer()
      this._renderStatus()
      if (reason !== 'unknown' || this.config.punishUnknown !== false) this.doShock(reason)
    }

    continueQuestion() {
      if (this.state.view !== 'answer' || !this.state.question) return
      this.queue.requeue(this.state.question.id)
      this.state.view = 'playing'
      this.state.answered = false
      this.state.selected = 0
      this.state.questionEndsAt = 0
      this.nextQuestion()
    }

    _markDirtyAnswered() {
      this.dirty = true
      this.answersSinceUpload += 1
      this._writeCache()
      const now = this.now()
      const since = this.lastUploadAt || this.session.startedAt || now
      if (this.answersSinceUpload >= 10 || now - since >= 30000) this._maybeUpload()
    }

    completePlan() {
      if (this.state.view === 'complete' || this.state.view === 'ended') return
      this._finishSession(false, 'complete')
    }

    endGame(reason) {
      if (this.state.view === 'complete' || this.state.view === 'ended') return
      this._finishSession(true, reason)
    }

    emergencyStop() {
      this.endGame('user')
    }

    _finishSession(ended, reason) {
      const now = this.now()
      this.state.view = ended ? 'ended' : 'complete'
      this.state.question = null
      this.state.questionEndsAt = 0
      this.state.answered = false
      this.state.paused = false
      this._stopTick()
      this.stopShock()
      this._stopVoice()
      this.setLock(true)
      const key = VC.dateKey(now)
      if (this.plan) {
        this.plan.u = now
        this.save.plans[key] = this.plan
      }
      this.dirty = true
      this._writeCache()
      this._switchView('complete')
      this._renderComplete(ended)
      this._renderStatus()
      this._maybeUpload(true)
      this._log(ended ? '结束（' + (reason || 'user') + '），已停电击并解锁' : '今日计划完成，已停电击并解锁', 'info')
    }

    pause() {
      if (this.state.view !== 'playing' && this.state.view !== 'answer') return
      if (this.state.paused) return
      this.state.paused = true
      this.state.pausedAt = this.now()
      this.stopShock()
      if (this.voiceOk) this.voice.ignoreUntil(this.state.pausedAt + 200)
      this._log('页面不可见，暂停倒计时并关闭电击', 'warning')
    }

    resume() {
      if (!this.state.paused) return
      const now = this.now()
      const delta = Math.max(0, now - (this.state.pausedAt || now))
      if (this.state.questionEndsAt) this.state.questionEndsAt += delta
      if (this.state.totalEndsAt) this.state.totalEndsAt += delta
      this.state.paused = false
      this.state.pausedAt = 0
      if (this.voiceOk) this.voice.ignoreUntil(now + 300)
      this._log('页面恢复，继续计时', 'info')
      this._renderStatus()
    }

    _tick() {
      const now = this.now()
      if (this.state.paused) return
      if (this.state.view === 'playing' && this.state.questionEndsAt && now >= this.state.questionEndsAt) {
        this._wrongAnswer('timeout', 0)
        return
      }
      if (this.state.totalEndsAt && now >= this.state.totalEndsAt) {
        this._log('到达整体时间上限，自动结束', 'warning')
        this.endGame('timeout')
        return
      }
      this._renderQuestionBar(now)
      this._renderTimeLeft(now)
      if (this.dirty) {
        const since = this.lastUploadAt || this.session.startedAt || now
        if (now - since >= 30000) this._maybeUpload()
      }
    }

    _renderTimeLeft(now) {
      const chip = this._byId('vg-total')
      if (!chip) return
      if (this.state.totalEndsAt) {
        chip.textContent = formatDuration(this.state.totalEndsAt - now)
      } else {
        const minutes = Number(this.config.totalTime) || 0
        chip.textContent = minutes > 0 ? formatDuration(minutes * 60000) : t('不限')
      }
    }

    _shockDevice() {
      if (!this.deviceApi || typeof this.deviceApi.device !== 'function') return null
      try {
        const dev = this.deviceApi.device('shock')
        if (!dev) return null
        if (typeof dev.isMapped === 'function' && !dev.isMapped()) return null
        return dev
      } catch (_) {
        return null
      }
    }

    doShock(reason) {
      const dev = this._shockDevice()
      if (!dev) {
        this._log('没有可用的电击设备，跳过电击', 'warning')
        return false
      }
      const voltage = clamp(this.config.shockVoltage, 0, 100)
      const seconds = clamp(this.config.shockDuration, 1, 10)
      const gen = ++this.shockGen
      if (this.shockTimer) {
        this.timers.clearTimeout(this.shockTimer)
        this.shockTimer = null
      }
      // 先挂停止定时器再发 start：即使 start 卡住，到点也一定会发 stop。
      this.shockTimer = this.timers.setTimeout(() => this.stopShock(gen), Math.round(seconds * 1000))
      this._log('电击（' + (reason || 'wrong') + '）：' + voltage + 'V / ' + seconds + '秒', 'warning')
      try {
        const result = dev.invoke('shock', 'start', { voltage: voltage })
        if (result && typeof result.catch === 'function') result.catch(() => {})
      } catch (error) {
        this._log('电击启动失败: ' + ((error && error.message) || error), 'warning')
      }
      return true
    }

    stopShock(gen) {
      if (gen != null && Number(gen) !== this.shockGen) return false
      if (this.shockTimer) {
        this.timers.clearTimeout(this.shockTimer)
        this.shockTimer = null
      }
      this.shockGen += 1
      const dev = this._shockDevice()
      if (!dev) return false
      try {
        const result = dev.invoke('shock', 'stop', {})
        if (result && typeof result.catch === 'function') result.catch(() => {})
      } catch (_) {}
      return true
    }

    _lockDevice() {
      if (!this.deviceApi || typeof this.deviceApi.device !== 'function') return null
      try {
        const dev = this.deviceApi.device('lock')
        if (!dev) return null
        if (typeof dev.isMapped === 'function' && !dev.isMapped()) return null
        return dev
      } catch (_) {
        return null
      }
    }

    // 自动锁：open=false 上锁，open=true 解锁。没映射时跳过，失败只记日志。
    async setLock(open) {
      const value = !!open
      this.state.locked = value
      const dev = this._lockDevice()
      if (!dev) return false
      try {
        const result = await dev.invoke('lock', 'setOpen', { open: value })
        if (result === false || (result && typeof result === 'object' && result.success === false)) {
          this._log('自动锁操作失败: ' + ((result && (result.error || result.message)) || 'rejected'), 'warning')
          return false
        }
        this._log(value ? '自动锁已解锁' : '自动锁已上锁', 'info')
        return true
      } catch (error) {
        this._log('自动锁操作失败: ' + ((error && error.message) || error), 'warning')
        return false
      }
    }

    speakWord(word, manual) {
      const synth = this.env && this.env.speechSynthesis
      const Utterance = this.env && this.env.SpeechSynthesisUtterance
      if (!synth || !Utterance || typeof synth.speak !== 'function') return false
      const text = String(word || '').trim()
      if (!text) return false
      const start = this.now()
      this.voice.ignoreUntil(start + 500 + text.length * 120)
      try {
        if (typeof synth.cancel === 'function') synth.cancel()
        const utterance = new Utterance(text)
        utterance.lang = 'en-US'
        utterance.rate = 0.9
        const release = () => {
          this.voice.ignoreUntil(this.now() + 500)
        }
        utterance.onend = release
        utterance.onerror = release
        synth.speak(utterance)
        if (manual) this._log('重播单词: ' + text, 'info')
        return true
      } catch (_) {
        return false
      }
    }

    _onVoiceResult(result) {
      if (!this.voiceOk || this.state.paused) return
      const seq = result && result.seq
      if (Number(seq) !== Number(this.state.questionSeq)) return
      const text = String((result && result.text) || '').trim()
      if (!text) {
        this._missed()
        return
      }
      const command = VC.parseVoiceCommand(text)
      this._log('语音识别: ' + text + ' → ' + JSON.stringify(command), 'info')
      if (this.state.view === 'answer') {
        if (command.action === 'continue') this.continueQuestion()
        else this._missed()
        return
      }
      if (this.state.view !== 'playing' || this.state.answered || !this.state.question) return
      if (command.action === 'choice') {
        if (command.index >= 1 && command.index <= this.state.question.choices.length) this.answer(command.index)
        else this._missed()
      } else if (command.action === 'unknown') {
        this.markUnknown()
      } else {
        this._missed()
      }
    }

    _onVoiceStatus(status) {
      if (!this.voiceOk) return
      if (status === 'recognizing') this._setVoiceCapsule('recognizing')
      else if (status === 'mic-error') {
        this._setVoiceCapsule('error')
        this._log('麦克风异常，语音选择可能不可用', 'warning')
      } else if (status === 'listening') {
        if (!this.voiceMissTimer) this._setVoiceCapsule('listening')
      }
    }

    _missed() {
      if (!this.voiceOk) return
      this._setVoiceCapsule('missed')
      if (this.voiceMissTimer) this.timers.clearTimeout(this.voiceMissTimer)
      this.voiceMissTimer = this.timers.setTimeout(() => {
        this.voiceMissTimer = null
        if (this.voiceOk && (this.state.view === 'playing' || this.state.view === 'answer')) {
          this._setVoiceCapsule('listening')
        }
      }, 1500)
    }

    _setVoiceCapsule(status) {
      const el = this._byId('vg-voice')
      if (!el) return
      if (status === 'off' || !this.voiceOk || (this.state.view !== 'playing' && this.state.view !== 'answer')) {
        el.hidden = true
        return
      }
      el.hidden = false
      el.className = 'vg-voice' + (status === 'recognizing' ? ' recognizing' : status === 'missed' ? ' missed' : '')
      const label = this._byId('vg-voice-text')
      if (label) {
        label.textContent = status === 'recognizing'
          ? t('识别中')
          : status === 'missed'
            ? t('没听清')
            : status === 'error'
              ? t('语音不可用')
              : t('监听中')
      }
    }

    _toast(message, ms) {
      const el = this._byId('vg-toast')
      if (!el) return
      el.textContent = String(message || '')
      el.hidden = false
      if (this.toastTimer) this.timers.clearTimeout(this.toastTimer)
      this.toastTimer = this.timers.setTimeout(() => {
        this.toastTimer = null
        el.hidden = true
      }, Math.max(600, ms || 1500))
    }

    _onPageHide() {
      this.stopShock()
      this.setLock(true)
      if (this.plan) {
        this.plan.u = this.now()
        this.save.plans[VC.dateKey(this.now())] = this.plan
        this.dirty = true
        this._writeCache()
      }
      // pagehide 里不能等待网络，能发多少发多少；失败也有本机缓存兜底。
      if (this.cloud && this.signedIn) {
        try {
          const result = this.cloud.put(this.save, this.cloudVersion)
          if (result && typeof result.catch === 'function') result.catch(() => {})
        } catch (_) {}
      }
    }

    _setSync(state) {
      this.syncState = state
      const dot = this._byId('vg-sync-dot')
      if (!dot) return
      dot.className = 'vg-dot ' + state
      dot.title = state === 'synced'
        ? t('已同步')
        : state === 'pending' || state === 'syncing'
          ? t('待同步')
          : t('离线')
    }

    async _maybeUpload(force) {
      if (!this.cloud || !this.signedIn) {
        this._setSync('offline')
        return false
      }
      if (this.uploading) {
        this.uploadPending = true
        return false
      }
      if (!force && !this.dirty) return true
      this.uploading = true
      this._setSync('syncing')
      let ok = false
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await this.cloud.put(this.save, this.cloudVersion)
          this.cloudVersion = result && result.version != null
            ? Number(result.version) || 0
            : this.cloudVersion + 1
          this.dirty = false
          this.answersSinceUpload = 0
          this.lastUploadAt = this.now()
          this.online = true
          this._setSync('synced')
          this._writeCache()
          ok = true
          break
        } catch (error) {
          const code = error && error.code
          if (code === 'VERSION_CONFLICT' && error.remote && error.remote.data) {
            // 冲突：用云端内容合并后重试，最多 3 次。
            this.save = VC.pruneSave(VC.mergeSaves(this.save, error.remote.data), this.today)
            this.cloudVersion = error.remote.version != null
              ? Number(error.remote.version) || 0
              : this.cloudVersion
            const todayKey = VC.dateKey(this.now())
            if (this.save.plans[todayKey]) this.plan = this.save.plans[todayKey]
            this.dirty = true
            this._writeCache()
            this._log('云存档冲突，已合并后重试（第 ' + (attempt + 1) + ' 次）', 'warning')
            continue
          }
          if (code === 'NOT_SIGNED_IN') {
            this.signedIn = false
            this.loginText = t('未登录')
            this._setSync('offline')
          } else if (code === 'NETWORK') {
            this.online = false
            this._setSync('offline')
          } else {
            this._setSync('pending')
          }
          this._log('上传云存档失败: ' + (code || 'unknown') + ' ' + ((error && error.message) || error), 'warning')
          this.lastUploadAt = this.now()
          this._writeCache()
          break
        }
      }
      this.uploading = false
      if (!ok) {
        this.lastUploadAt = this.now()
        if (this.syncState === 'syncing') this._setSync('pending')
      }
      if (this.uploadPending) {
        this.uploadPending = false
        if (this.signedIn) this._maybeUpload(false)
      }
      return ok
    }

    _switchView(view) {
      this._setHidden('vg-start', view !== 'start')
      this._setHidden('vg-play', view !== 'play')
      this._setHidden('vg-complete', view !== 'complete')
      this._setHidden('vg-qbar-wrap', view !== 'play')
      if (view !== 'play') this._setVoiceCapsule('off')
    }

    _renderStart() {
      if (!this.bankName) {
        const id = BANK_IDS.indexOf(String(this.config.bank)) >= 0 ? String(this.config.bank) : 'cet4'
        this.bankName = t(BANK_LABELS[id])
      }
      this._setText('vg-login', this.loginText || t('读取中…'))
      this._setText('vg-start-bank', this.bankName || '—')
      let planText = t('读取中…')
      if (this.planReady) {
        if (!this.signedIn) planText = t('请先登录')
        else if (!this.plan) planText = t('词库未加载')
        else {
          const stats = VC.planStats(this.plan)
          planText = t('新词 {a}/{b} · 复习 {c}/{d}', {
            a: stats.newDone,
            b: stats.newTotal,
            c: stats.reviewDone,
            d: stats.reviewTotal
          })
          if (VC.isPlanComplete(this.plan)) planText += ' · ' + t('已完成')
        }
      }
      this._setText('vg-start-plan', planText)
      const missingBank = this.planReady && !this.bankWords.length
      const note = this._byId('vg-start-note')
      if (note) {
        note.hidden = true
        if (this.planReady && !this.signedIn) {
          note.hidden = false
          note.className = 'vg-note bad'
          note.textContent = t('请先在客户端登录账号')
        } else if (missingBank) {
          note.hidden = false
          note.className = 'vg-note bad'
          note.textContent = t('词库未加载，请检查 banks 目录')
        } else if (this.planReady && this.signedIn && !this.online) {
          note.hidden = false
          note.className = 'vg-note'
          note.textContent = t('无法连接云端，将使用本机缓存（离线模式）')
        }
      }
      const voiceNote = this._byId('vg-voice-note')
      if (voiceNote) voiceNote.hidden = !this.voiceFallback
      const button = this._byId('vg-start-btn')
      if (button) {
        button.disabled = !this.signedIn || !this.planReady || missingBank
        const complete = this.plan ? VC.isPlanComplete(this.plan) : false
        button.textContent = !this.signedIn
          ? t('请先登录')
          : complete
            ? t('再学一组')
            : this.online ? t('开始') : t('离线开始')
      }
      this._switchView(this.state.view === 'play' ? 'play' : this.state.view === 'complete' ? 'complete' : 'start')
      this._renderStatus()
    }

    _renderStatus() {
      this._setText('vg-bank', this.bankName || '—')
      const stats = this.plan ? VC.planStats(this.plan) : { newDone: 0, newTotal: 0, reviewDone: 0, reviewTotal: 0, remaining: 0 }
      this._setText('vg-new', stats.newDone + '/' + stats.newTotal)
      this._setText('vg-review', stats.reviewDone + '/' + stats.reviewTotal)
      this._setText('vg-left', String(stats.remaining))
      this._renderTimeLeft(this.now())
      this._setSync(this.syncState)
    }

    _renderQuestion() {
      const question = this.state.question
      if (!question) return
      this._switchView('play')
      this._setText('vg-word', question.word)
      this._setText('vg-phonetic', formatPhonetic(question.phonetic))
      const options = this._byId('vg-options')
      const buttons = options && options.querySelectorAll ? options.querySelectorAll('.vg-opt') : []
      Array.prototype.forEach.call(buttons, (button, i) => {
        const choice = question.choices[i]
        button.hidden = !choice
        button.disabled = false
        button.className = 'vg-opt'
        const label = button.querySelector ? button.querySelector('.vg-opt-text') : null
        if (label) label.textContent = choice ? choice.text : ''
      })
      const unknown = this._byId('vg-unknown')
      if (unknown) unknown.disabled = false
      this._setHidden('vg-answer', true)
      this._renderQuestionBar(this.now())
      this._setVoiceCapsule(this.voiceOk ? 'listening' : 'off')
    }

    _renderQuestionBar(now) {
      const bar = this._byId('vg-qbar')
      if (!bar) return
      const totalMs = clamp(this.config.questionTime, 0, 120) * 1000
      if (this.state.view !== 'playing' || !this.state.questionEndsAt || totalMs <= 0) {
        bar.style.width = this.state.view === 'answer' ? '0%' : '100%'
        bar.className = ''
        return
      }
      const left = Math.max(0, this.state.questionEndsAt - now)
      const ratio = Math.max(0, Math.min(1, left / totalMs))
      bar.style.width = (ratio * 100).toFixed(1) + '%'
      bar.className = left <= 5000 ? 'urgent' : ''
    }

    _renderAnswer() {
      const question = this.state.question
      if (!question) return
      this._setText('vg-answer-word', question.word)
      this._setText('vg-answer-phonetic', formatPhonetic(question.phonetic))
      this._setText('vg-answer-meaning', question.full || question.short)
      const cont = this._byId('vg-continue')
      if (cont) cont.textContent = this.voiceOk ? t('点击或说“继续”') : t('继续')
      this._setHidden('vg-answer', false)
      this._renderQuestionBar(this.now())
      this._setVoiceCapsule(this.voiceOk ? 'listening' : 'off')
      const panel = this._byId('vg-answer')
      const continueButton = this._byId('vg-continue')
      const target = continueButton || panel
      if (target && typeof target.scrollIntoView === 'function') {
        // 小屏上答案面板可能在折叠区下方，自动滚到可见位置；避开底部固定的紧急停止。
        try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch (_) { target.scrollIntoView() }
      }
    }

    _setOptionsDisabled(disabled) {
      const options = this._byId('vg-options')
      const buttons = options && options.querySelectorAll ? options.querySelectorAll('.vg-opt') : []
      Array.prototype.forEach.call(buttons, button => { button.disabled = !!disabled })
      const unknown = this._byId('vg-unknown')
      if (unknown) unknown.disabled = !!disabled
    }

    _highlight(correctIndex, selected) {
      const options = this._byId('vg-options')
      const buttons = options && options.querySelectorAll ? options.querySelectorAll('.vg-opt') : []
      Array.prototype.forEach.call(buttons, (button, i) => {
        const index = i + 1
        let className = 'vg-opt'
        if (index === correctIndex) className += ' correct'
        if (selected && index === selected && index !== correctIndex) className += ' wrong'
        button.className = className
      })
    }

    _firstAccuracy() {
      // 今天每个词只看第一次作答：k>0 说明今天是首答对，k=0 说明首答错。
      const ids = this.plan && Array.isArray(this.plan.ids) ? this.plan.ids : []
      let total = 0
      let correct = 0
      ids.forEach(id => {
        const entry = this.save.words[id]
        if (!entry || Number(entry.last) !== Number(this.today)) return
        total += 1
        if (Number(entry.k) > 0) correct += 1
      })
      if (!total) return null
      return Math.round(correct / total * 100)
    }

    _tomorrowDueCount() {
      const target = this.today + 1
      let count = 0
      Object.keys(this.save.words || {}).forEach(id => {
        if (Number(this.save.words[id].due) === target) count += 1
      })
      return count
    }

    _renderComplete(ended) {
      const title = this._byId('vg-complete-title')
      if (title) title.textContent = ended ? t('已结束') : t('今日完成')
      const section = this._byId('vg-complete')
      if (section && section.classList) section.classList.toggle('ended', !!ended)
      const sub = this._byId('vg-complete-sub')
      if (sub) sub.textContent = ended ? t('本次已结束，进度已保存') : t('今日计划已完成，已解锁')
      this._setText('vg-stat-answers', String(this.session.answers))
      const accuracy = this._firstAccuracy()
      this._setText('vg-stat-first', accuracy == null ? '—' : accuracy + '%')
      this._setText('vg-stat-due', String(this._tomorrowDueCount()))
      this._setHidden('vg-extra', !!ended)
      this._setHidden('vg-back', !ended)
      this._setVoiceCapsule('off')
    }

    backToStart() {
      this._stopTick()
      this.stopShock()
      this.setLock(true)
      this._stopVoice()
      this.state.view = 'start'
      this.state.question = null
      this.state.questionEndsAt = 0
      this.state.paused = false
      this.state.answered = false
      this._switchView('start')
      this._renderStart()
      this._renderStatus()
    }
  }

  // ---------------------------------------------------------------------------
  // 浏览器启动
  // ---------------------------------------------------------------------------
  function bootstrap(win, doc) {
    if (typeof GameI18n !== 'undefined' && GameI18n.apply) GameI18n.apply()
    const deviceApi = win.DeviceAPI || null
    const ready = deviceApi && deviceApi.ready && typeof deviceApi.ready.then === 'function'
      ? deviceApi.ready.catch(() => {})
      : Promise.resolve()
    const timeout = new Promise(resolve => setTimeout(resolve, 1500))
    Promise.race([ready, timeout]).then(() => {
      const game = new VocabGame({ window: win, document: doc, deviceApi: deviceApi })
      game.updateParameters(deviceApi && deviceApi.params ? deviceApi.params : {})
      win.__game = game
      win.__vocabGame = game
      win.VocabGame = VocabGame
      game.init().catch(error => {
        game._log('初始化失败: ' + ((error && error.message) || error), 'error')
        game.loginText = '初始化失败'
        game.planReady = true
        game._renderStart()
      })
    })
  }

  if (typeof globalThis !== 'undefined' && globalThis.document) {
    const doc = globalThis.document
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', () => bootstrap(globalThis, doc))
    } else {
      bootstrap(globalThis, doc)
    }
  }

  return {
    VocabGame: VocabGame,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    BANK_IDS: BANK_IDS,
    BANK_LABELS: BANK_LABELS,
    loadBank: loadBank,
    formatDuration: formatDuration,
    formatPhonetic: formatPhonetic,
    parseTestAudio: VV.parseTestAudio
  }
})
