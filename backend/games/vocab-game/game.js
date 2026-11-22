/**
 * 背单词游戏页面编排（Vocabulary Game）
 * 首页 / 更换词书 / 设置 / 学习四页；今日计划、倒计时、电击、自动锁、语音、云存档同步。
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
  const BANK_EN = { gaokao: 'Gaokao', cet4: 'CET-4', cet6: 'CET-6', ielts: 'IELTS' }
  const SETTINGS_KEYS = ['bank', 'newPerDay', 'reviewCap', 'questionTime', 'inputMode', 'autoSpeak', 'punishUnknown']
  const SHOCK_KEYS = ['shockVoltage', 'shockDuration']
  const ANSWER_REVIEW_MS = 10000
  const DEFAULT_CONFIG = {
    bank: 'cet4',
    newPerDay: 20,
    reviewCap: 100,
    questionTime: 20,
    inputMode: 'voice',
    autoSpeak: true,
    punishUnknown: true,
    shockVoltage: 15,
    shockDuration: 2,
    totalTime: 60
  }
  const RANGES = {
    newPerDay: [0, 200],
    reviewCap: [0, 500],
    questionTime: [0, 120],
    shockVoltage: [10, 100],
    shockDuration: [1, 10]
  }

  function clamp(value, min, max) {
    const n = Number(value)
    if (!isFinite(n)) return min
    return Math.max(min, Math.min(max, n))
  }

  function clampInt(value, fallback, min, max) {
    const n = Math.floor(Number(value))
    if (!isFinite(n)) return fallback
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
      storage.setItem('__vg_probe__', '1')
      storage.removeItem('__vg_probe__')
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
      nameEn: String(bank.nameEn || BANK_EN[id] || ''),
      words: words
    }
  }

  function loadAllBanks(env) {
    const out = {}
    BANK_IDS.forEach(id => {
      const bank = loadBank(env, id)
      if (bank) out[id] = bank
    })
    return out
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
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
      this.hostParams = {}
      this.autoStart = false
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
      this.allBanks = {}
      this.bank = null
      this.bankWords = []
      this.wordMap = new Map()
      this.bankName = ''
      this.hostShock = { voltage: DEFAULT_CONFIG.shockVoltage, duration: DEFAULT_CONFIG.shockDuration }
      this.shock = { voltage: DEFAULT_CONFIG.shockVoltage, duration: DEFAULT_CONFIG.shockDuration }
      this.userId = ''
      this.signedIn = false
      this.loginText = t('读取中…')
      this.cloudVersion = 0
      this.online = false
      this.planReady = false
      this.starting = false
      this.syncState = 'offline'
      this.dirty = false
      this.saveRev = 0
      this.uploading = false
      this.uploadPending = false
      this.answersSinceUpload = 0
      this.lastUploadAt = 0
      this.session = { answers: 0, startedAt: 0 }
      this.today = VC.dayIndex(this.now())
      this.queue = new VC.QuizQueue([])
      this.returnTo = 'home'
      this.autoEntered = false
      this.completingPromise = null
      this.lastResult = ''
      this.homeDayTimer = null
      this.state = {
        view: 'home',
        paused: false,
        pausedAt: 0,
        question: null,
        selected: 0,
        correctIndex: 0,
        questionSeq: 0,
        questionEndsAt: 0,
        answerEndsAt: 0,
        totalEndsAt: 0,
        answered: false,
        pendingAdvance: false,
        locked: null
      }
      this.tickTimer = null
      this.answerTimer = null
      this.shockTimer = null
      this.shockGen = 0
      this.speechGen = 0
      this.speechTimer = null
      this.toastTimer = null
      this.voiceMissTimer = null
      this.voiceOk = false
      this.voiceFallback = false
      this.voiceStarting = false
      this.voiceStartGen = 0
      this.voiceMode = String(this.config.inputMode) === 'voice'
      this.visibilityHandler = null
      this.unloadHandler = null
      this.keyHandler = null
      this.errorHandler = null
    }

    updateParameters(params) {
      const next = params && typeof params === 'object' ? params : {}
      this.hostParams = next
      if (Object.prototype.hasOwnProperty.call(next, 'totalTime')) {
        this.config.totalTime = clamp(next.totalTime, 0, 600)
      }
      if (Object.prototype.hasOwnProperty.call(next, 'autoStart')) this.autoStart = next.autoStart === true
      this._applyShockSettings()
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
      this._renderHome()
      this._renderStatus()
      await this.prepare()
      this._renderHome()
      this._renderStatus()
      this._startHomeDayTimer()
      this._maybeAutoEnter().catch(error => this._log('自动进入失败: ' + ((error && error.message) || error), 'warning'))
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
      const on = (id, event, fn) => {
        const el = this._byId(id)
        if (el && typeof el.addEventListener === 'function') el.addEventListener(event, fn)
      }
      const startGesture = () => {
        // 用户手势里同步恢复 AudioContext；只有语音模式才申请麦克风，点选模式不弹权限。
        this.voice.prime()
        if (!this.voiceMode) return
        try {
          const pending = this.voice.primeMic()
          if (pending && typeof pending.catch === 'function') pending.catch(() => {})
        } catch (_) {}
      }
      on('vg-start-btn', 'click', () => {
        startGesture()
        this._handleStart().catch(error => this._startFailed(error))
      })
      on('vg-extra', 'click', () => {
        startGesture()
        this._handleStart().catch(error => this._startFailed(error))
      })
      on('vg-gate-btn', 'click', () => {
        this._setHidden('vg-gate', true)
        startGesture()
        this._handleStart().catch(error => this._startFailed(error))
      })
      on('vg-settings-btn', 'click', () => this.openSettings())
      on('vg-change-bank', 'click', () => this.openBanks('home'))
      on('vg-set-bank', 'click', () => this.openBanks('settings'))
      on('vg-banks-back', 'click', () => this._backFromBanks())
      on('vg-settings-back', 'click', () => {
        this.state.view = 'home'
        this._switchView('home')
        this._renderHome()
      })
      on('vg-home-btn', 'click', () => this.backToStart())
      on('vg-continue', 'click', () => this.continueQuestion())
      on('vg-voice-toggle', 'click', () => this.toggleVoice())
      on('vg-unknown', 'click', () => this.markUnknown())
      on('vg-speak', 'click', () => {
        if (this.state.question) this.speakWord(this.state.question.word, true)
      })
      on('vg-options', 'click', event => {
        const target = event && event.target
        const button = target && typeof target.closest === 'function' ? target.closest('.vg-opt') : null
        if (!button) return
        this.answer(Number(button.getAttribute('data-index')))
      })
      on('vg-bank-list', 'click', event => {
        const target = event && event.target
        const button = target && typeof target.closest === 'function' ? target.closest('.vg-bank-item') : null
        if (!button) return
        this.selectBank(String(button.getAttribute('data-bank') || ''))
      })
      const settings = this._byId('vg-settings')
      if (settings && typeof settings.addEventListener === 'function') {
        settings.addEventListener('click', event => this._onSettingsClick(event))
        settings.addEventListener('change', event => this._onSettingsChange(event))
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
        // 未捕获错误/未处理的 Promise 拒绝也是结束路径：至少停电击并解锁，避免锁一直关着。
        this.errorHandler = event => {
          if (event && event.type === 'error' && !event.message && !event.error) return
          const reason = (event && (event.message || (event.reason && event.reason.message))) || 'unknown'
          this._safetyAbort(reason)
        }
        this.env.addEventListener('error', this.errorHandler)
        this.env.addEventListener('unhandledrejection', this.errorHandler)
      }
    }

    _safetyAbort(reason) {
      this.stopSpeaking()
      this._log('未捕获错误，已停电击并解锁: ' + reason, 'error')
      this.stopShock()
      this.setLock(true)
    }
    async prepare() {
      const api = this.deviceApi
      // 未登录也要先加载词库，首页的词书名和总词数才不会是空的。
      this._loadBank()
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
      this._applySaveSettings()
      this._setSync(this.online ? 'synced' : 'offline')
      this._writeCache()
      this._ensurePlan()
      this.planReady = true
      this._renderHome()
      this._renderStatus()
      this._applyI18n()
      if (this.online && this.dirty) this._maybeUpload()
    }

    _applySaveSettings() {
      const settings = VC.normalizeSettings(this.save.settings)
      this.save.settings = settings
      SETTINGS_KEYS.forEach(key => { this.config[key] = settings[key] })
      this.config.totalTime = clamp(this.config.totalTime, 0, 600)
      this._applyShockSettings()
      this.voiceMode = settings.inputMode === 'voice'
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

    _markDirty() {
      this.dirty = true
      this.saveRev += 1
    }

    _shockKey() {
      return 'vocab-game:shock:' + (this.userId || 'local')
    }

    _readShockOverride() {
      try {
        const raw = this.storage.getItem(this._shockKey())
        return raw ? JSON.parse(raw) : null
      } catch (_) {
        return null
      }
    }

    _applyShockSettings() {
      const resolved = VC.resolveShockSettings(this.hostParams, this._readShockOverride())
      this.shock = { voltage: resolved.voltage, duration: resolved.duration }
      this.config.shockVoltage = resolved.voltage
      this.config.shockDuration = resolved.duration
      this.hostShock = {
        voltage: clampInt(this.hostParams.shockVoltage, DEFAULT_CONFIG.shockVoltage, 10, 100),
        duration: clampInt(this.hostParams.shockDuration, DEFAULT_CONFIG.shockDuration, 1, 10)
      }
      // 宿主值变了就清掉本机覆盖，以配置页为准。
      if (!resolved.override) {
        try { this.storage.removeItem(this._shockKey()) } catch (_) {}
      }
    }

    _writeShockOverride() {
      try {
        this.storage.setItem(this._shockKey(), JSON.stringify({
          hostVoltage: this.hostShock.voltage,
          hostDuration: this.hostShock.duration,
          voltage: this.shock.voltage,
          duration: this.shock.duration
        }))
      } catch (_) {}
    }
    _loadBank() {
      this.allBanks = loadAllBanks(this.env)
      const id = BANK_IDS.indexOf(String(this.config.bank)) >= 0 ? String(this.config.bank) : 'cet4'
      const bank = this.allBanks[id] || null
      this.bank = bank
      this.bankWords = bank ? bank.words : []
      const map = new Map()
      Object.keys(this.allBanks).forEach(bankId => {
        this.allBanks[bankId].words.forEach(word => {
          if (!map.has(word.id)) map.set(word.id, word)
        })
      })
      this.wordMap = map
      const en = typeof GameI18n !== 'undefined' && GameI18n.isEn && GameI18n.isEn()
      this.bankName = bank
        ? (en && bank.nameEn ? bank.nameEn : bank.name)
        : t(BANK_LABELS[id] || id)
      if (bank && en && bank.nameEn) this.bankName = bank.nameEn
      return bank
    }

    _ensurePlan() {
      const now = this.now()
      this.today = VC.dayIndex(now)
      const key = VC.dateKey(now)
      this._loadBank()
      const bankId = BANK_IDS.indexOf(String(this.config.bank)) >= 0 ? String(this.config.bank) : 'cet4'
      const storedPlan = this.save.plans[key] && Array.isArray(this.save.plans[key].ids)
        ? this.save.plans[key]
        : null
      if (storedPlan) {
        // 词书设置比计划新（可能在另一台设备改过）：按新设置重建今天没答过的部分。
        this.plan = storedPlan.bank && storedPlan.bank !== bankId
          ? this._rebuildTodayPlan(storedPlan, key)
          : storedPlan
        return this.plan
      }
      if (!this.bank) {
        this.plan = null
        this._log('词库未加载: ' + bankId, 'error')
        return null
      }
      this.plan = VC.buildDailyPlan({
        bank: bankId,
        bankIds: this.bankWords.map(word => word.id),
        progress: this.save.words,
        today: this.today,
        now: now,
        newPerDay: clampInt(this.config.newPerDay, 20, 0, 200),
        reviewCap: clampInt(this.config.reviewCap, 100, 0, 500),
        random: this.random
      })
      this.save.plans[key] = this.plan
      this._markDirty()
      this._writeCache()
      return this.plan
    }

    _rebuildTodayPlan(plan, key) {
      const bankId = BANK_IDS.indexOf(String(this.config.bank)) >= 0 ? String(this.config.bank) : 'cet4'
      const next = VC.rebuildPlan(plan || this.plan, {
        bank: bankId,
        bankIds: this.bankWords.map(word => word.id),
        progress: this.save.words,
        today: this.today,
        now: this.now(),
        newPerDay: clampInt(this.config.newPerDay, 20, 0, 200)
      })
      this.plan = next
      this.save.plans[key || VC.dateKey(this.now())] = next
      this._markDirty()
      this._writeCache()
      return next
    }

    async _maybeAutoEnter() {
      if (this.autoEntered) return false
      if (!this.autoStart || !this.signedIn || !this.online || !this.planReady) return false
      if (!this.plan || VC.isPlanComplete(this.plan)) return false
      if (!Object.keys(this.save.words || {}).length) return false
      if (this.state.view !== 'home') return false
      this.autoEntered = true
      if (this.voiceMode && !(await this._tryPrimeWithoutGesture())) {
        // 先静默尝试（手被束缚时也要能直接开始）；起不来才让用户点一下。
        this._setHidden('vg-gate', false)
        return false
      }
      await this._handleStart()
      return true
    }

    async _tryPrimeWithoutGesture() {
      const speech = this.deviceApi && this.deviceApi.speech
      // 手机宿主统一处理麦克风授权，不显示网页点击启用提示。
      if (speech && speech.requiresUserGesture === false) return true
      // 原生口令采集不经过网页 AudioContext；权限由宿主启动录音时申请。
      if (this.voice.commands) return true
      try {
        this.voice.prime()
        await this.voice.primeMic()
        const ctx = this.voice.audioContext
        if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          await Promise.race([
            Promise.resolve(ctx.resume()).catch(() => {}),
            new Promise(resolve => this.timers.setTimeout(resolve, 800))
          ])
        }
        if (this.voice.micError) return false
        if (this.voice.testAudioUrl) return !ctx || ctx.state !== 'suspended'
        return !!ctx && ctx.state === 'running'
      } catch (_) {
        return false
      }
    }

    _startHomeDayTimer() {
      if (this.homeDayTimer) return
      this.homeDayTimer = this.timers.setInterval(() => {
        if (this.state.view === 'home' && this._checkDay()) {
          this._renderHome()
          this._renderStatus()
        }
      }, 60000)
    }

    _checkDay() {
      const now = this.now()
      const today = VC.dayIndex(now)
      if (today === this.today) return false
      this.today = today
      this._log('跨过 04:00 换日，重新生成今日计划', 'info')
      if (this.state.view === 'playing' || this.state.view === 'answer') {
        this.session = { answers: 0, startedAt: now }
      }
      this._ensurePlan()
      this._writeCache()
      return true
    }
    async _handleStart() {
      if (this.starting) return false
      if (!this.signedIn) {
        this._toast(t('请先在客户端登录账号'), 2500)
        return false
      }
      if (!this.planReady) {
        this._toast(t('存档读取中…'))
        return false
      }
      if (!this.bankWords.length) {
        this._toast(t('词库未加载，请检查 banks 目录'), 3000)
        return false
      }
      this.starting = true
      try {
        return await this.startGame()
      } catch (error) {
        this._startFailed(error)
        return false
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
      this.state.view = 'home'
      this.state.paused = false
      this._switchView('home')
      this._renderHome()
      this._toast(t('启动失败：{msg}', { msg: (error && error.message) || error }), 3000)
    }

    async startGame() {
      if (this._checkDay()) {
        this._renderHome()
        this._renderStatus()
      }
      if (!this.plan) return false
      const now = this.now()
      this.today = VC.dayIndex(now)
      const key = VC.dateKey(now)
      const wasComplete = VC.isPlanComplete(this.plan)
      let plan = this.plan
      if (wasComplete) {
        const extra = VC.buildExtraPlan(plan, {
          bankIds: this.bankWords.map(word => word.id),
          progress: this.save.words,
          newPerDay: clampInt(this.config.newPerDay, 20, 0, 200),
          now: now
        })
        if (!extra.added) {
          this._toast(t('没有更多新词了'), 2500)
          return false
        }
        plan = extra.plan
        this.plan = plan
        this.save.plans[key] = plan
        this._markDirty()
        this._writeCache()
        this._renderHome()
      }
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
      this.state.pendingAdvance = false
      this.queue = new VC.QuizQueue(VC.planRemaining(plan))
      const minutes = clamp(this.config.totalTime, 0, 600)
      this.state.totalEndsAt = minutes > 0 ? now + minutes * 60000 : 0
      this._switchView('playing')
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
      const gen = ++this.voiceStartGen
      this.voiceStarting = true
      this._renderVoiceToggle()
      try {
        const speech = this.deviceApi && this.deviceApi.speech
        if (!speech || (!speech.commands && typeof speech.transcribe !== 'function')) return this._voiceFallback('no-speech-api')
        let status = null
        try {
          status = await this._withTimeout(Promise.resolve().then(() => speech.commands ? speech.commands.status() : speech.status()), 1500)
        } catch (_) {
          status = null
        }
        if (gen !== this.voiceStartGen) return false
        if (status && status.ready === false) return this._voiceFallback(status.reason || 'not-ready')
        try {
          await this.voice.start()
          if (gen !== this.voiceStartGen) {
            await this.voice.stop()
            return false
          }
          this.voiceOk = true
          this.voiceFallback = false
          this._setVoiceCapsule('listening')
          if (this.state.view === 'answer') this._renderAnswer()
          return true
        } catch (error) {
          if (gen !== this.voiceStartGen) return false
          return this._voiceFallback((error && error.code) || (error && error.message))
        }
      } finally {
        if (gen === this.voiceStartGen) this.voiceStarting = false
        this._renderVoiceToggle()
      }
    }

    async toggleVoice() {
      if (this.voiceStarting || this.state.paused || (this.state.view !== 'playing' && this.state.view !== 'answer')) return false
      const enabled = !this.voiceOk
      // 点击的用户手势内申请麦克风；点选模式始终不占用录音。
      if (enabled) {
        this.voice.prime()
        this.voice.primeMic()
      }
      this._applySettingChange({ inputMode: enabled ? 'voice' : 'touch' })
      if (enabled) return this._startVoice()
      this._stopVoice()
      if (this.state.view === 'answer') this._renderAnswer()
      return true
    }

    _renderVoiceToggle() {
      const button = this._byId('vg-voice-toggle')
      if (!button) return
      button.textContent = this.voiceStarting ? t('语音准备中…') : this.voiceOk ? t('语音已开启') : t('开启语音')
      button.disabled = this.voiceStarting
      if (typeof button.setAttribute === 'function') button.setAttribute('aria-pressed', String(this.voiceOk))
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
      this.stopSpeaking()
      this.voiceStartGen += 1
      this.voiceStarting = false
      this.voiceOk = false
      this._renderVoiceToggle()
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
      this.stopSpeaking()
      this.state.answerEndsAt = 0
      this.state.pendingAdvance = false
      let question = null
      while (this.queue.length) {
        const id = this.queue.next()
        const word = this.wordMap.get(id)
        if (!word) {
          this._log('词库里找不到单词，已跳过: ' + id, 'warning')
          if (!this.plan.done.includes(id)) this.plan.done.push(id)
          continue
        }
        // 干扰项优先取当前词库；切换词书后当天残留的旧词也能正常出题。
        const inBank = this.bankWords.some(w => w.id === id)
        const pool = inBank ? this.bankWords : this.bankWords.concat([word])
        const choices = VC.buildChoices(pool, id, this.random, 4)
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
      if (this.state.view !== 'playing' || this.state.answered || this.state.paused) return
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
      // 暂停时不自动跳题；恢复后由 resume() 补上。
      if (this.state.paused) {
        this.state.pendingAdvance = true
        return
      }
      this.state.answered = false
      if (this._checkDay()) {
        this.queue = new VC.QuizQueue(this.plan ? VC.planRemaining(this.plan) : [])
        this._renderStatus()
        this.nextQuestion()
        return
      }
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
      this.state.answerEndsAt = now + ANSWER_REVIEW_MS
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
      if (this.state.view !== 'answer' || !this.state.question || this.state.paused) return
      this.state.answerEndsAt = 0
      const id = this.state.question.id
      if (this._checkDay()) {
        this.state.view = 'playing'
        this.state.answered = false
        this.state.selected = 0
        this.state.questionEndsAt = 0
        this.queue = new VC.QuizQueue(this.plan ? VC.planRemaining(this.plan) : [])
        this._renderStatus()
        this.nextQuestion()
        return
      }
      this.queue.requeue(id)
      this.state.view = 'playing'
      this.state.answered = false
      this.state.selected = 0
      this.state.questionEndsAt = 0
      this.nextQuestion()
    }

    _markDirtyAnswered() {
      this._markDirty()
      this.answersSinceUpload += 1
      this._writeCache()
      const now = this.now()
      const since = this.lastUploadAt || this.session.startedAt || now
      if (this.answersSinceUpload >= 10 || now - since >= 30000) this._maybeUpload()
    }
    completePlan() {
      if (this.state.view === 'home') return Promise.resolve(false)
      if (this.completingPromise) return this.completingPromise
      if (this.state.view !== 'playing' && this.state.view !== 'answer') return Promise.resolve(false)
      this.completingPromise = this._completeWithMerge()
        .catch(error => {
          this._log('完成前合并云存档失败: ' + ((error && error.message) || error), 'warning')
          this._finishSession(false, 'complete')
        })
        .finally(() => { this.completingPromise = null })
      return this.completingPromise
    }

    // 今日完成前先和云端合并：别的设备可能已经答过或加过词，基于合并后的存档判定再解锁。
    async _completeWithMerge() {
      if (this.cloud && this.signedIn && this.online) {
        let remote = null
        try {
          remote = await this._withTimeout(Promise.resolve().then(() => this.cloud.get()), 6000)
        } catch (error) {
          this._log('完成前读取云存档失败: ' + ((error && error.message) || error), 'warning')
          remote = null
        }
        if (remote) {
          this.save = VC.pruneSave(VC.mergeSaves(this.save, remote.data || null), this.today)
          this.cloudVersion = remote.version != null ? Number(remote.version) || 0 : this.cloudVersion
          const key = VC.dateKey(this.now())
          const mergedPlan = this.save.plans[key]
          if (mergedPlan) this.plan = mergedPlan
          this._applySaveSettings()
          this._setSync('synced')
          this._writeCache()
        }
      }
      if (this.plan && !VC.isPlanComplete(this.plan)) {
        // 合并后还有别的设备产生的未答词：继续答，不算完成也不解锁。
        this.state.view = 'playing'
        this.state.answered = false
        this.state.question = null
        this.queue = new VC.QuizQueue(VC.planRemaining(this.plan))
        this._renderStatus()
        this.nextQuestion()
        return false
      }
      this._finishSession(false, 'complete')
      return true
    }

    endGame(reason) {
      if (this.state.view === 'home') return
      this._finishSession(true, reason)
    }

    emergencyStop() {
      // 只有答题中（含答案面板）才需要急停；首页/设置页按了不应把状态改成“已结束”。
      if (this.state.view !== 'playing' && this.state.view !== 'answer') return
      this.endGame('user')
    }

    _finishSession(ended, reason) {
      const now = this.now()
      this.lastResult = ended ? 'ended' : 'complete'
      this.state.view = 'home'
      this.state.question = null
      this.state.questionEndsAt = 0
      this.state.answerEndsAt = 0
      this.state.answered = false
      this.state.pendingAdvance = false
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
      this._markDirty()
      this._writeCache()
      this._switchView('home')
      this._renderHome()
      this._renderStatus()
      this._maybeUpload(true)
      if (ended) this._toast(t('本次已结束，进度已保存'), 2500)
      this._log(ended ? '结束（' + (reason || 'user') + '），已停电击并解锁' : '今日计划完成，已停电击并解锁', 'info')
    }

    pause() {
      if (this.state.view !== 'playing' && this.state.view !== 'answer') return
      if (this.state.paused) return
      this.state.paused = true
      this.state.pausedAt = this.now()
      this.stopSpeaking()
      this.stopShock()
      if (this.voiceOk) this.voice.ignoreUntil(this.state.pausedAt + 200)
      this._log('页面不可见，暂停倒计时并关闭电击', 'warning')
    }

    resume() {
      if (!this.state.paused) {
        // 停在首页跨过换日点时，回到前台按新的一天重算。
        if (this.state.view === 'home' && this._checkDay()) {
          this._renderHome()
          this._renderStatus()
        }
        return
      }
      const now = this.now()
      const delta = Math.max(0, now - (this.state.pausedAt || now))
      if (this.state.questionEndsAt) this.state.questionEndsAt += delta
      if (this.state.answerEndsAt) this.state.answerEndsAt += delta
      if (this.state.totalEndsAt) this.state.totalEndsAt += delta
      this.state.paused = false
      this.state.pausedAt = 0
      if (this.voiceOk) this.voice.ignoreUntil(now + 300)
      this._log('页面恢复，继续计时', 'info')
      this._renderStatus()
      if (this.state.pendingAdvance) {
        this.state.pendingAdvance = false
        this.state.answered = false
        if (this._checkDay()) this.queue = new VC.QuizQueue(this.plan ? VC.planRemaining(this.plan) : [])
        if (this.queue.length === 0) this.completePlan()
        else this.nextQuestion()
      }
    }

    _tick() {
      const now = this.now()
      if (this.state.paused) return
      if (this.state.totalEndsAt && now >= this.state.totalEndsAt) {
        this._log('到达整体时间上限，自动结束', 'warning')
        this.endGame('timeout')
        return
      }
      if (this.state.view === 'playing' && this.state.questionEndsAt && now >= this.state.questionEndsAt) {
        this._wrongAnswer('timeout', 0)
        return
      }
      if (this.state.view === 'answer' && this.state.answerEndsAt) {
        if (now >= this.state.answerEndsAt) {
          this.continueQuestion()
          return
        }
        this._renderAnswerCountdown(now)
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
      const voltage = clamp(this.shock.voltage, 0, 100)
      const seconds = clamp(this.shock.duration, 1, 10)
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
        const started = value => {
          if (gen !== this.shockGen || value == null || value === false || value.success === false) return
          this._setShockActive(true)
        }
        const failed = error => {
          if (gen === this.shockGen) this._setShockActive(false)
          this._log('电击启动失败: ' + ((error && error.message) || error), 'warning')
        }
        if (result && typeof result.then === 'function') result.then(started).catch(failed)
        else started(result)
      } catch (error) {
        this._log('电击启动失败: ' + ((error && error.message) || error), 'warning')
      }
      return true
    }

    stopShock(gen) {
      if (gen != null && Number(gen) !== this.shockGen) return false
      this._setShockActive(false)
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

    _setShockActive(active) {
      const indicator = this._byId('vg-shock')
      if (!indicator) return
      indicator.hidden = !active
      if (typeof indicator.setAttribute === 'function') indicator.setAttribute('aria-label', t('电击中'))
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
      const text = String(word || '').trim()
      if (!text) return false
      const speech = this.deviceApi && this.deviceApi.speech
      const synth = this.env && this.env.speechSynthesis
      const Utterance = this.env && this.env.SpeechSynthesisUtterance
      const native = speech && typeof speech.speak === 'function'
      if (!native && (!synth || !Utterance || typeof synth.speak !== 'function')) {
        if (manual) this._toast(t('朗读不可用，请检查系统英文语音'), 3000)
        return false
      }
      this.stopSpeaking()
      const gen = this.speechGen
      this._setSpeaking(true)
      const ignore = () => this.voice.ignoreUntil(this.now() + 500)
      ignore()
      this.speechTimer = this.timers.setInterval(ignore, 100)
      const release = () => {
        if (gen !== this.speechGen) return
        if (this.speechTimer) this.timers.clearInterval(this.speechTimer)
        this.speechTimer = null
        this._setSpeaking(false)
        ignore()
      }
      const failed = error => {
        if (gen !== this.speechGen) return
        release()
        this._log('单词朗读失败: ' + ((error && error.message) || error), 'warning')
        if (manual) this._toast(t('朗读不可用，请检查系统英文语音'), 3000)
      }
      try {
        if (native) {
          Promise.resolve(speech.speak({ text: text })).then(release).catch(failed)
          if (manual) this._log('重播单词: ' + text, 'info')
          return true
        }
        const utterance = new Utterance(text)
        utterance.lang = 'en-US'
        utterance.rate = 0.9
        utterance.onend = release
        utterance.onerror = failed
        synth.speak(utterance)
        if (manual) this._log('重播单词: ' + text, 'info')
        return true
      } catch (error) {
        failed(error)
        return false
      }
    }

    _setSpeaking(active) {
      const button = this._byId('vg-speak')
      if (!button) return
      if (button.classList) button.classList.toggle('speaking', active)
      if (typeof button.setAttribute === 'function') {
        button.setAttribute('aria-pressed', String(active))
        button.setAttribute('aria-label', t('重播'))
      }
    }

    stopSpeaking() {
      this.speechGen += 1
      if (this.speechTimer) {
        this.timers.clearInterval(this.speechTimer)
        this.speechTimer = null
        this.voice.ignoreUntil(this.now() + 500)
      }
      this._setSpeaking(false)
      try {
        const speech = this.deviceApi && this.deviceApi.speech
        if (speech && typeof speech.stop === 'function') Promise.resolve(speech.stop()).catch(() => {})
        const synth = this.env && this.env.speechSynthesis
        if (synth && typeof synth.cancel === 'function') synth.cancel()
      } catch (_) {}
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
      const command = result.mode === 'kws'
        ? ({ choice_1: { action: 'choice', index: 1 }, choice_2: { action: 'choice', index: 2 }, choice_3: { action: 'choice', index: 3 }, choice_4: { action: 'choice', index: 4 }, continue: { action: 'continue' }, unknown: { action: 'unknown' } }[result.command] || { action: 'ignore' })
        : VC.parseVoiceCommand(text)
      this._log((result.mode === 'kws' ? '口令触发: ' : '语音识别: ') + text + ' → ' + JSON.stringify(command), 'info')
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

    _onVoiceStatus(status, detail) {
      if (!this.voiceOk) return
      if (status === 'command-error') {
        this._voiceFallback(detail || 'NO_KWS')
        this._renderVoiceToggle()
        return
      }
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
      this.stopSpeaking()
      this.stopShock()
      this.setLock(true)
      if (this.plan) {
        this.plan.u = this.now()
        this.save.plans[VC.dateKey(this.now())] = this.plan
        this._markDirty()
        this._writeCache()
      }
      // pagehide 里不能等待网络，能发多少发多少；失败也有本机缓存兜底。
      // 上传中/有新改动时也要发，避免清 dirty 竞态把最后几题丢掉。
      if (this.cloud && this.signedIn && (this.dirty || this.uploading)) {
        try {
          const result = this.cloud.put(this.save, this.cloudVersion)
          if (result && typeof result.catch === 'function') result.catch(() => {})
        } catch (_) {}
      }
    }

    _setSync(state) {
      this.syncState = state
      const title = state === 'synced'
        ? t('已同步')
        : state === 'pending' || state === 'syncing'
          ? t('待同步')
          : t('离线')
      ;['vg-sync-dot', 'vg-sync-dot-play'].forEach(id => {
        const dot = this._byId(id)
        if (!dot) return
        dot.className = 'vg-dot ' + state
        dot.title = title
      })
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
        const rev = this.saveRev
        try {
          const result = await this.cloud.put(this.save, this.cloudVersion)
          this.cloudVersion = result && result.version != null
            ? Number(result.version) || 0
            : this.cloudVersion + 1
          // 上传期间又答了题：只清掉这次快照对应的 dirty，新改动继续待上传。
          if (this.saveRev === rev) this.dirty = false
          else this.uploadPending = true
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
            this._applySaveSettings()
            this._markDirty()
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
        if (this.signedIn && this.dirty) this._maybeUpload(false)
      }
      return ok
    }
    _switchView(view) {
      const play = view === 'playing' || view === 'answer'
      this._setHidden('vg-home', view !== 'home')
      this._setHidden('vg-banks', view !== 'banks')
      this._setHidden('vg-settings', view !== 'settings')
      this._setHidden('vg-play', !play)
      this._setHidden('vg-qbar-wrap', !play)
      if (this._byId('vg-root') && this._byId('vg-root').classList) {
        this._byId('vg-root').classList.toggle('wide', play)
      }
      if (!play) this._setVoiceCapsule('off')
    }

    openSettings() {
      if (this.state.view === 'playing' || this.state.view === 'answer') return
      this._renderSettings()
      this.state.view = 'settings'
      this._switchView('settings')
    }

    openBanks(from) {
      this.returnTo = from === 'settings' ? 'settings' : 'home'
      this._renderBanks()
      this.state.view = 'banks'
      this._switchView('banks')
    }

    _backFromBanks() {
      if (this.returnTo === 'settings') {
        this._renderSettings()
        this.state.view = 'settings'
        this._switchView('settings')
      } else {
        this.state.view = 'home'
        this._switchView('home')
      }
    }

    selectBank(id) {
      if (BANK_IDS.indexOf(id) < 0) return
      if (id !== this.config.bank) {
        this._applySettingChange({ bank: id })
      }
      this._backFromBanks()
      this._renderHome()
      this._renderStatus()
    }

    _onSettingsClick(event) {
      const target = event && event.target
      if (!target) return
      const stepBtn = typeof target.closest === 'function' ? target.closest('.vg-stepper button') : null
      if (stepBtn) {
        const stepper = stepBtn.closest('.vg-stepper')
        if (!stepper) return
        const key = String(stepper.getAttribute('data-key') || '')
        const delta = Number(stepBtn.getAttribute('data-delta')) || 0
        const min = Number(stepper.getAttribute('data-min'))
        const max = Number(stepper.getAttribute('data-max'))
        const input = stepper.querySelector('input')
        const current = input ? Number(input.value) : this.config[key]
        const next = clampInt(current + delta, min, min, max)
        this._applySettingChange({ [key]: next })
        return
      }
      const segBtn = typeof target.closest === 'function' ? target.closest('.vg-seg button') : null
      if (segBtn) {
        const value = String(segBtn.getAttribute('data-value') || '')
        const seg = segBtn.closest('.vg-seg')
        const key = seg ? String(seg.id || '').replace(/^vg-set-/, '') : ''
        if (key) this._applySettingChange({ [key]: value })
        return
      }
      const sw = typeof target.closest === 'function' ? target.closest('.vg-switch') : null
      if (sw) {
        const key = String(sw.id || '').replace(/^vg-set-/, '')
        if (key) this._applySettingChange({ [key]: !sw.classList.contains('on') })
      }
    }

    _onSettingsChange(event) {
      const target = event && event.target
      if (!target || target.tagName !== 'INPUT') return
      const stepper = typeof target.closest === 'function' ? target.closest('.vg-stepper') : null
      if (!stepper) return
      const key = String(stepper.getAttribute('data-key') || '')
      if (!key) return
      const min = Number(stepper.getAttribute('data-min'))
      const max = Number(stepper.getAttribute('data-max'))
      const value = clampInt(target.value, this.config[key], min, max)
      this._applySettingChange({ [key]: value })
    }

    _applySettingChange(patch) {
      const source = patch || {}
      const learning = {}
      let changedLearning = false
      SETTINGS_KEYS.forEach(key => {
        if (!Object.prototype.hasOwnProperty.call(source, key)) return
        learning[key] = source[key]
        changedLearning = true
      })
      if (changedLearning) {
        this.save.settings = VC.updateSettings(this.save.settings, learning, this.now())
        SETTINGS_KEYS.forEach(key => { this.config[key] = this.save.settings[key] })
        this.voiceMode = this.save.settings.inputMode === 'voice'
        if (Object.prototype.hasOwnProperty.call(learning, 'bank') || Object.prototype.hasOwnProperty.call(learning, 'newPerDay')) {
          this._loadBank()
          if (this.plan) this._rebuildTodayPlan(this.plan)
          else this._ensurePlan()
        }
        this._applyI18n()
      }
      SHOCK_KEYS.forEach(key => {
        if (!Object.prototype.hasOwnProperty.call(source, key)) return
        const range = RANGES[key]
        const value = clampInt(source[key], this.config[key], range[0], range[1])
        this.config[key] = value
        if (key === 'shockVoltage') this.shock.voltage = value
        else this.shock.duration = value
        this._writeShockOverride()
      })
      // 电击覆盖只存本机，不进云存档，也不触发上传；只有学习设置才标脏。
      if (changedLearning) {
        this._markDirty()
        this._writeCache()
        if (this.cloud && this.signedIn) this._maybeUpload()
      }
      this._renderSettings()
      this._renderHome()
      this._renderStatus()
    }

    _renderHome() {
      if (!this.bankName) {
        const id = BANK_IDS.indexOf(String(this.config.bank)) >= 0 ? String(this.config.bank) : 'cet4'
        this.bankName = t(BANK_LABELS[id])
      }
      const stats = this.plan ? VC.planStats(this.plan) : { newDone: 0, newTotal: 0, reviewDone: 0, reviewTotal: 0, remaining: 0 }
      this._setText('vg-home-new', String(stats.newDone))
      this._setText('vg-home-new-total', '/' + stats.newTotal)
      this._setText('vg-home-review', String(stats.reviewDone))
      this._setText('vg-home-review-total', '/' + stats.reviewTotal)
      const newBar = this._byId('vg-home-new-bar')
      if (newBar) newBar.style.width = (stats.newTotal ? stats.newDone / stats.newTotal * 100 : 0) + '%'
      const reviewBar = this._byId('vg-home-review-bar')
      if (reviewBar) reviewBar.style.width = (stats.reviewTotal ? stats.reviewDone / stats.reviewTotal * 100 : 0) + '%'
      const complete = this.plan ? VC.isPlanComplete(this.plan) : false
      const missingBank = this.planReady && !this.bankWords.length
      this._setHidden('vg-task-main', complete)
      this._setHidden('vg-task-done', !complete)
      const card = this._byId('vg-task-card')
      if (card && card.classList) card.classList.toggle('done', complete)
      if (complete) {
        this._setText('vg-done-sub', t('今日计划已完成（新词 {a} · 复习 {b}）', { a: stats.newDone, b: stats.reviewDone }))
        const extra = this._byId('vg-extra')
        if (extra) extra.disabled = !this._hasMoreNewWords()
      }
      this._renderHomeButton(complete, missingBank, stats)
      this._renderHomeNotes(complete, missingBank)
      this._renderBankCard()
      const accuracy = this._firstAccuracy()
      this._setText('vg-stat-accuracy', accuracy == null ? '—' : accuracy + '%')
      this._setText('vg-stat-due', String(this._tomorrowDueCount()))
      this._setText('vg-stat-learned', String(Object.keys(this.save.words || {}).length))
      this._setSync(this.syncState)
    }

    _renderHomeButton(complete, missingBank, stats) {
      const button = this._byId('vg-start-btn')
      if (!button) return
      button.disabled = !this.signedIn || !this.planReady || missingBank
      if (!this.signedIn) button.textContent = t('请先登录')
      else if (!this.planReady) button.textContent = t('存档读取中…')
      else if (stats && stats.total > 0 && stats.remaining < stats.total) button.textContent = t('继续学习')
      else button.textContent = t('开始学习')
      const hint = this._byId('vg-lock-hint')
      if (hint) {
        const show = !complete && !!this._lockDevice() && this.signedIn && this.planReady && !missingBank
        hint.hidden = !show
        hint.textContent = show ? t('开始后上锁，完成今日任务自动解锁') : ''
      }
    }

    _renderHomeNotes(complete, missingBank) {
      const note = this._byId('vg-home-note')
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
    }

    _renderBankCard() {
      const bank = this.bank
      const en = typeof GameI18n !== 'undefined' && GameI18n.isEn && GameI18n.isEn()
      const label = bank
        ? (en && bank.nameEn ? bank.nameEn : bank.name + (bank.nameEn ? ' ' + bank.nameEn : ''))
        : t(BANK_LABELS[this.config.bank] || this.config.bank)
      this._setText('vg-home-bank', label || '—')
      const total = this.bankWords.length
      let learned = 0
      this.bankWords.forEach(word => {
        if (this.save.words[word.id]) learned += 1
      })
      this._setText('vg-home-bank-progress', t('已学 {a} / 总 {b}', { a: learned, b: total }))
      const bar = this._byId('vg-home-bank-bar')
      if (bar) bar.style.width = (total ? Math.min(100, learned / total * 100) : 0) + '%'
    }

    _hasMoreNewWords() {
      const used = new Set(this.plan ? this.plan.ids : [])
      return this.bankWords.some(word => !this.save.words[word.id] && !used.has(word.id))
    }

    _renderBanks() {
      const list = this._byId('vg-bank-list')
      if (!list) return
      const en = typeof GameI18n !== 'undefined' && GameI18n.isEn && GameI18n.isEn()
      list.innerHTML = BANK_IDS.map(id => {
        const bank = this.allBanks[id]
        if (!bank) return ''
        let learned = 0
        bank.words.forEach(word => {
          if (this.save.words[word.id]) learned += 1
        })
        const total = bank.words.length
        const pct = total ? Math.min(100, learned / total * 100) : 0
        const current = id === this.config.bank
        const nameEn = bank.nameEn || BANK_EN[id] || ''
        const name = en && bank.nameEn ? bank.nameEn : bank.name
        return '<button class="vg-bank-item vg-bank-' + id + '" type="button" data-bank="' + id + '">' +
          '<div class="vg-bank-item-head"><span class="vg-bank-item-name">' + escapeHtml(name) +
          '<small>' + escapeHtml(nameEn) + '</small></span>' +
          (current ? '<span class="vg-badge-current">' + escapeHtml(t('当前')) + '</span>' : '') +
          '</div>' +
          '<div class="vg-bank-item-meta">' + escapeHtml(t('已学 {a} / 总 {b}', { a: learned, b: total })) + '</div>' +
          '<div class="vg-progress"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
          '</button>'
      }).join('')
    }

    _renderSettings() {
      const bankName = this.bank
        ? this.bank.name + (this.bank.nameEn ? ' ' + this.bank.nameEn : '')
        : t(BANK_LABELS[this.config.bank] || this.config.bank)
      this._setText('vg-set-bank', (bankName || '—') + ' ›')
      const steppers = this.doc && this.doc.querySelectorAll ? this.doc.querySelectorAll('.vg-stepper') : []
      Array.prototype.forEach.call(steppers, stepper => {
        const key = String(stepper.getAttribute('data-key') || '')
        const input = stepper.querySelector('input')
        if (input && Object.prototype.hasOwnProperty.call(this.config, key)) input.value = String(this.config[key])
      })
      const seg = this._byId('vg-set-inputMode')
      if (seg) {
        const buttons = seg.querySelectorAll ? seg.querySelectorAll('button') : []
        Array.prototype.forEach.call(buttons, button => {
          const on = String(button.getAttribute('data-value')) === String(this.config.inputMode)
          button.classList.toggle('on', on)
        })
      }
      const switches = [['vg-set-autoSpeak', 'autoSpeak'], ['vg-set-punishUnknown', 'punishUnknown']]
      switches.forEach(pair => {
        const el = this._byId(pair[0])
        if (el && el.classList) el.classList.toggle('on', this.config[pair[1]] !== false)
      })
    }

    _renderStatus() {
      this._renderVoiceToggle()
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
      this._switchView('playing')
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
      if (unknown) {
        unknown.disabled = false
        unknown.hidden = false
      }
      this._setHidden('vg-answer', true)
      // 换题时回到顶部，露出单词和语音开关。
      if (this.env && typeof this.env.scrollTo === 'function') this.env.scrollTo(0, 0)
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
      if (!this.state.question) return
      this._setHidden('vg-unknown', true)
      this._renderAnswerCountdown(this.now())
      const cont = this._byId('vg-continue')
      if (cont) cont.textContent = this.voiceOk ? t('点击或说“继续”') : t('继续')
      this._setHidden('vg-answer', false)
      this._renderQuestionBar(this.now())
      this._setVoiceCapsule(this.voiceOk ? 'listening' : 'off')
    }

    _setOptionsDisabled(disabled) {
      const options = this._byId('vg-options')
      const buttons = options && options.querySelectorAll ? options.querySelectorAll('.vg-opt') : []
      Array.prototype.forEach.call(buttons, button => { button.disabled = !!disabled })
      const unknown = this._byId('vg-unknown')
      if (unknown) unknown.disabled = !!disabled
    }

    _renderAnswerCountdown(now) {
      const seconds = Math.max(0, Math.ceil((this.state.answerEndsAt - now) / 1000))
      const el = this._byId('vg-answer-countdown')
      const text = t('{seconds} 秒后自动下一题', { seconds: seconds })
      if (el && el.textContent !== text) el.textContent = text
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

    backToStart() {
      if (this.state.view === 'home' || this.state.view === 'banks' || this.state.view === 'settings') {
        this.state.view = 'home'
        this._switchView('home')
        return
      }
      this._stopTick()
      this.stopShock()
      this._stopVoice()
      // 中途返回首页不算失败：进度保留，已上锁的保持上锁（不在这里 setOpen(true)）。
      this.state.view = 'home'
      this.state.question = null
      this.state.questionEndsAt = 0
      this.state.answerEndsAt = 0
      this.state.paused = false
      this.state.pendingAdvance = false
      this.state.answered = false
      this._checkDay()
      this._switchView('home')
      this._renderHome()
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
        game._renderHome()
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
    loadAllBanks: loadAllBanks,
    formatDuration: formatDuration,
    formatPhonetic: formatPhonetic,
    parseTestAudio: VV.parseTestAudio
  }
})
