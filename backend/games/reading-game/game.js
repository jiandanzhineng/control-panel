/**
 * 朗读游戏（Reading Game）页面编排
 * 屏幕显示一段文字，用户朗读；停读或长时间不按原文读会先警告再电击，读完通关。
 *
 * 玩法逻辑逐条照搬 electron-client outter-game/reading-game/reading-game.js
 * （分支 feat/reading-game，方案 docs/plans/reading-game.md 第 11 节）。
 * 只替换输入输出：
 *   - 语音识别：DeviceAPI.speech.transcribe
 *   - 拼音：页面内 pinyin.js（原主进程 IPC text-to-pinyin）
 *   - 电击：DeviceAPI.device('shock').invoke('shock','start'/'stop')
 *   - 界面：本页 DOM（首次由 index.html 渲染骨架，之后按 id 局部更新）
 *   - 文本：texts.js（原 texts.json / 自定义文件）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory({
      core: require('./reading-core.js'),
      pinyin: require('./pinyin.js'),
      texts: require('./texts.js')
    })
  } else {
    root.ReadingGameModule = factory({
      core: root.RGCore,
      pinyin: root.RGPinyin,
      texts: root.RG_TEXTS || []
    })
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (mods) {
  'use strict'

  const C = mods.core
  const globalRoot = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null)
  const RG_CONST = C.RG_CONST
  const BUILTIN_TEXTS = mods.texts || []
  const pinyinService = mods.pinyin
  const RGAligner = C.ReadingAligner
  const RGTrigger = C.ReadingTriggerMachine
  const RGVoiceDetector = C.VoiceDetector
  const RGRingBuffer = C.PcmRingBuffer
  const rgEscapeHtml = C.rgEscapeHtml
  const rgBytesToBase64 = C.rgBytesToBase64
  const rgVerdictLabel = C.rgVerdictLabel
  const rgResample = C.rgResample
  const rgEncodeWav = C.rgEncodeWav
  const rgWorkletCode = C.rgWorkletCode
  const rgMaskRatio = C.rgMaskRatio
  const rgSelectMaskChars = C.rgSelectMaskChars
  const rgAccuracy = C.rgAccuracy
  const rgAddMatchedPairs = C.rgAddMatchedPairs
  const PendingJumpGate = C.PendingJumpGate

  function t(zh, vars) {
    if (typeof GameI18n !== 'undefined' && GameI18n.t) return GameI18n.t(zh, vars)
    if (vars && typeof vars === 'object') {
      return String(zh).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])))
    }
    return zh
  }

  // URL ?rgTestAudio=<同目录相对路径或 http URL>：用音频文件代替麦克风
  function parseTestAudio(search) {
    try {
      const raw = new URLSearchParams(search || '').get('rgTestAudio')
      if (!raw) return ''
      const value = String(raw).trim()
      if (!value) return ''
      if (/^(https?:)?\/\//i.test(value) || /^data:audio\//i.test(value)) return value
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return ''
      return value
    } catch (_) {
      return ''
    }
  }

  function createShockManager(deviceApi, logicalId) {
    const targetId = logicalId || 'shock'
    return {
      setDeviceProperty: async function (id, props) {
        if (!deviceApi || typeof deviceApi.device !== 'function') return false
        const dev = deviceApi.device(String(id || '') === 'shock_device' ? targetId : (id || targetId))
        if (props && Number(props.shock) === 1) {
          const params = { voltage: Math.max(0, Number(props.voltage) || 0) }
          return dev.invoke('shock', 'start', params)
        }
        return dev.invoke('shock', 'stop', {})
      }
    }
  }

  class ReadingGame {
    constructor(options) {
      const opts = options || {}
      this.env = opts.window || (typeof window !== 'undefined' ? window : null)
      this.win = this.env
      this.doc = opts.document || (typeof document !== 'undefined' ? document : null)
      this.deviceApi = opts.deviceApi || (this.env && this.env.DeviceAPI) || null
      this.speech = opts.speech !== undefined
        ? opts.speech
        : (this.deviceApi && this.deviceApi.speech) || null
      this.pinyin = opts.pinyin || pinyinService
      this.texts = opts.texts || BUILTIN_TEXTS
      this.timers = opts.timers || {
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (id) => clearInterval(id),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id)
      }
      this.media = opts.media || null
      this.location = opts.location || (this.env && this.env.location) || null
      this.fetchFn = opts.fetch || (this.env && typeof this.env.fetch === 'function' ? this.env.fetch.bind(this.env) : null)
      this.shockLogicalId = opts.shockLogicalId || 'shock'
      this.deviceManager = opts.deviceManager || (this.deviceApi ? createShockManager(this.deviceApi, this.shockLogicalId) : null)
      this.testAudioUrl = opts.testAudioUrl || ''
      this.sttUnavailable = false
      this.started = false
      this.title = t('朗读游戏')
      this.description = t('朗读屏幕上的文字，停下来或长时间不按原文读就会受到电击；支持反复朗读和逐级遮字的背诵玩法')
      this.version = '1.1.0'
      this.author = '游戏设计师'
      this.random = typeof opts.random === 'function' ? opts.random : Math.random
      this.config = {
        // 与 manifest 的 customText 默认值保持一致；清空时退回第一篇内置文本。
        customText: '窗外下了一夜的小雨，早上醒来，空气里都是泥土的味道。我推开门，看见院子里的花开了几朵，叶子上还挂着水珠。邻居家的小狗跑过来，摇着尾巴，好像也在说早上好。',
        mode: 'read',
        passes: 1,
        restSeconds: 20,
        passRate: 85,
        maskStart: 10,
        maskStep: 10,
        hintChars: 8,
        silenceBonus: 2,
        silenceLimit: 6,
        stallLimit: 20,
        warnLead: 2,
        checkContent: true,
        shockIntensity: 20,
        shockDuration: 1,
        shockStep: 0,
        shockMax: 50,
        cooldown: 5,
        startGrace: 5,
        segmentLen: 4,
        segmentHop: 3,
        totalTime: 60,
        sttTimeout: 15000,
        finalConfirmLen: 8,
        beep: true,
        allowUnsafeIntensity: false
      }
      this.state = this._initialState()
      this.uiAPI = true
      this.tickTimer = null
      this.renderTimer = null
      this.shockTimer = null
      this.audioContext = null
      this.stream = null
      this.sourceNode = null
      this.analyser = null
      this.workletNode = null
      this.scriptNode = null
      this.muteNode = null
      this.testAudioNode = null
      this.ringBuffer = null
      this.detector = null
      this.trigger = null
      this.aligner = null
      this.freqData = null
      this.timeData = null
      this.audioStartTime = 0
      this.readingStartTime = 0
      this.nextChunkAt = 0
      this.escHandler = null
      this.visibilityHandler = null
      this.unloadHandler = null
      this.audioStateHandler = null
      this.ending = false
      this.appliedAudioEndMs = 0
      this.requestStarts = []
      this.finalQueue = []
      this.tailConfirmAttempts = 0
      this.latencySamples = []
      this.voicedBuckets = new Map()
      this.shockGen = 0
      this.chunkSeq = 0
      this.latestAppliedSeq = 0
      this.lastChunkEndSec = 0
      this.voiceTicks = []
      this.uiRoot = null
      this._segSig = ''
      this._lastCur = -1
      this._textSig = ''
      this.passId = 0
      this.passMatched = new Set()
      this.lastMaskedPass = new Map()
      this.jumpGate = new PendingJumpGate()
      this.pendingJumpResult = null
      this.hintedSet = new Set()
      this.testAudioBuffer = null
      this.lockState = null
    }
  _initialState() {
    return {
      phase: 'idle',
      startTime: 0,
      readingStartTime: 0,
      sourceText: '',
      sourceTitle: '',
      sourceSyllables: [],
      chars: [],
      totalSyllables: 0,
      position: 0,
      isGameActive: false,
      won: false,
      unconfirmed: false,
      ended: false,
      isShocking: false,
      shockCount: 0,
      consecutiveShocks: 0,
      lastShockAt: 0,
      warning: null,
      cooldownUntil: 0,
      degraded: false,
      paused: false,
      pauseReason: '',
      sttStatus: '待机',
      sttSlow: false,
      sttLatency: 0,
      sttInFlight: 0,
      lastText: '',
      lastVerdict: '',
      segments: [],
      audioLevel: 0,
      threshold: 8,
      floor: 0,
      voiceLevel: 0,
      isVoiced: false,
      lastVoiceAt: 0,
      lastEnergyAt: 0,
      thresholdEnergy: 8,
      silenceSeconds: 0,
      tailConfirm: null,
      endWait: null,
      hidden: false,
      t2Bad: 0,
      t2Advance: 0,
      lastBeepSecond: -1,
      mode: 'read',
      passId: 0,
      passNumber: 1,
      totalPasses: 1,
      completedPasses: 0,
      level: 0,
      maskRatio: 0,
      maskedChars: [],
      hintedChars: [],
      lastAccuracy: null,
      lastPassKind: '',
      lastPassPassed: null,
      restUntil: 0,
      restSeconds: 0,
      restRemaining: 0
    }
  }

    updateParameters(newParams) {
      const params = newParams || {}
      Object.keys(params).forEach(key => {
        if (this.config.hasOwnProperty(key)) this.config[key] = params[key]
      })
      this.log(t('朗读游戏参数已更新: {json}', { json: JSON.stringify(params) }), 'info')
    }

    _mode() {
      return String(this.config.mode) === 'recite' ? 'recite' : 'read'
    }

    _passCount() {
      const n = Math.floor(Number(this.config.passes))
      if (!Number.isFinite(n)) return 1
      return Math.max(1, Math.min(50, n))
    }

    // 背诵时每级多给一点停顿时间；朗读玩法 k = 0
    _effectiveSilenceLimit() {
      const base = Math.max(0.5, Number(this.config.silenceLimit) || 6)
      if (this._mode() !== 'recite') return base
      const bonus = Math.max(0, Number(this.config.silenceBonus) || 0)
      return base + Math.max(1, Number(this.state.level) || 1) * bonus
    }

    // 选本遍要遮的字；朗读玩法不遮
    _selectMask(passNumber, level) {
      const mode = this._mode()
      this.state.level = mode === 'recite' ? Math.max(1, Number(level) || 1) : 0
      if (mode !== 'recite') {
        this.state.maskRatio = 0
        this.state.maskedChars = []
        return []
      }
      const ratio = rgMaskRatio(this.state.level, this.config.maskStart, this.config.maskStep)
      const picked = rgSelectMaskChars(this.state.chars, ratio, passNumber, this.lastMaskedPass, this.random)
      picked.forEach(idx => this.lastMaskedPass.set(idx, passNumber))
      this.state.maskRatio = ratio
      this.state.maskedChars = picked
      this.state.hintedChars = []
      this.hintedSet = new Set()
      return picked
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
    async _setLock(open) {
      const value = !!open
      this.lockState = value
      const dev = this._lockDevice()
      if (!dev) return false
      try {
        await dev.invoke('lock', 'setOpen', { open: value })
        this.log(t(value ? '自动锁已解锁' : '自动锁已上锁'), 'info')
        return true
      } catch (error) {
        this.log(t('自动锁操作失败: {msg}', { msg: (error && error.message) || error }), 'warning')
        return false
      }
    }

    _markSpeechUnavailable(reason) {
      this.sttUnavailable = true
      this.speechReason = reason || 'not-ready'
      this.speechUnavailableText = this._speechReasonText(this.speechReason)
      this.state.degraded = true
      this.state.sttStatus = t(this.speechUnavailableText)
    }

    _speechReasonText(reason) {
      if (reason === 'NOT_SIGNED_IN') return '语音识别未登录（请登录账号或在设置里填写 SiliconFlow key），仅检测是否出声'
      if (reason === 'NO_STT') return '语音识别未配置，仅检测是否出声'
      if (reason === 'REMOTE_LOCKED') return '语音识别正被远程会话占用，仅检测是否出声'
      return '识别不可用（仅检测出声）'
    }

    // DeviceAPI.speech 不存在或 status().ready=false → 降级为仅 T1
    async _initSpeech() {
      const speech = this.speech || (this.deviceApi && this.deviceApi.speech) || null
      this.speech = speech
      if (!speech || typeof speech.transcribe !== 'function') {
        this._markSpeechUnavailable('no-api')
        return false
      }
      let status = null
      try {
        status = await Promise.race([
          Promise.resolve().then(() => (typeof speech.status === 'function' ? speech.status() : null)),
          new Promise(resolve => this.timers.setTimeout(() => resolve(null), 1500))
        ])
      } catch (_) {
        status = null
      }
      if (!status || status.ready !== true) {
        this._markSpeechUnavailable((status && status.reason) || 'not-ready')
        return false
      }
      this.sttUnavailable = false
      return true
    }

    async start(deviceManager, params) {
      this.deviceManager = deviceManager || this.deviceManager
      this.updateParameters(params)
      this.ending = false
      this.started = true
      this.state = this._initialState()
      this.state.startTime = Date.now()
      this.state.phase = 'calibrating'
      this.state.isGameActive = true
      this.state.mode = this._mode()
      this.state.totalPasses = this.state.mode === 'read' ? this._passCount() : 0
      this.state.passId = 1
      this.state.passNumber = 1
      this.state.completedPasses = 0
      this.state.level = this.state.mode === 'recite' ? 1 : 0
      this.passId = 1
      this.passMatched = new Set()
      this.lastMaskedPass = new Map()
      this.jumpGate.reset()
      this.pendingJumpResult = null
      this.hintedSet = new Set()
      this.log(t('朗读游戏 v{version} 正在启动...', { version: this.version }), 'info')
      try {
        await this._initSpeech()
        await this.loadText()
        await this.preparePinyin()
        this._selectMask(1, this.state.level)
        this.bindEsc()
        this.bindLifecycle()
        try { await this._requestWakeLock() } catch (_) {}
        await this.startAudio()
        this.latestAppliedSeq = 0
        this.appliedAudioEndMs = 0
        this.requestStarts = []
        this.finalQueue = []
        this.tailConfirmAttempts = 0
        this.latencySamples = []
        this.chunkSeq = 0
        this.lastChunkEndSec = 0
        this.voiceTicks = []
        this.voicedBuckets = new Map()
        this.state.readingStartTime = 0
        this.nextChunkAt = 0
        this.startTimers()
        this.renderUI()
        await this._setLock(false)
        this.log(t('麦克风校准中，请保持安静约 3 秒，随后开始朗读'), 'warning')
      } catch (error) {
        this.log(t('游戏启动失败: {msg}', { msg: error.message }), 'error')
        await this.safeShockOff()
        await this._setLock(true)
        this.clearTimers()
        this.unbindEsc()
        this.unbindLifecycle()
        await this.stopAudio()
        this.state.ended = true
        this.state.isGameActive = false
        throw error
      }
    }

    _currentTextChoice() {
      const custom = String(this.config.customText == null ? '' : this.config.customText).trim()
      if (custom) return { title: t('朗读文本'), text: custom }
      return this._pickText({ texts: this.texts }, 1)
    }

    _pickText(payload, index) {
      const fallback = BUILTIN_TEXTS[0] || { title: t('内置文本'), text: '' }
      if (typeof payload === 'string' && payload.trim()) {
        return { title: t('自定义文本'), text: payload }
      }
      if (payload && typeof payload.text === 'string' && payload.text.trim()) {
        return { title: payload.title || t('自定义文本'), text: payload.text }
      }
      let list = []
      if (Array.isArray(payload)) list = payload
      else if (payload && Array.isArray(payload.texts)) list = payload.texts
      if (!list.length) return fallback
      let idx = Math.floor(Number(index) || 1) - 1
      if (idx < 0) idx = 0
      if (idx >= list.length) idx = list.length - 1
      const item = list[idx]
      if (typeof item === 'string') return { title: t('文本 {n}', { n: idx + 1 }), text: item }
      if (item && typeof item.text === 'string' && item.text.trim()) {
        return { title: item.title || t('文本 {n}', { n: idx + 1 }), text: item.text }
      }
      return fallback
    }

    async loadText() {
      const picked = this._currentTextChoice()
      this.state.sourceText = picked.text
      this.state.sourceTitle = picked.title
      this.log(t('朗读文本: {title}（{n} 字）', { title: picked.title, n: picked.text.length }), 'info')
    }

    _triggerOptions() {
      return {
        silenceLimit: this._effectiveSilenceLimit(),
        stallLimit: this.config.stallLimit,
        warnLead: this.config.warnLead,
        cooldown: this.config.cooldown,
        startGrace: this.config.startGrace,
        sttTimeout: this.config.sttTimeout,
        checkContent: !!this.config.checkContent && !this.state.degraded && !this.sttUnavailable
      }
    }

    async preparePinyin(sourceText) {
      const text = sourceText != null ? sourceText : this.state.sourceText
      let res = null
      try {
        res = this.pinyin ? this.pinyin.textToPinyin(text) : null
      } catch (error) {
        res = { error: error.message }
      }
      if (!res || res.error || !Array.isArray(res.syllables) || res.syllables.length === 0) {
        this.state.degraded = true
        this.state.sttStatus = t('识别不可用（仅检测出声）')
        this.state.totalSyllables = 0
        this.aligner = null
        this.trigger = new RGTrigger(this._triggerOptions(), () => Date.now())
        this.log(t('文本拼音转换失败，本次仅检测是否出声'), 'error')
        return
      }
      this.state.sourceSyllables = res.syllables
      this.state.chars = res.chars || []
      this.state.totalSyllables = res.syllables.length
      this.aligner = new RGAligner(res.syllables)
      this.trigger = new RGTrigger(this._triggerOptions(), () => Date.now())
      if (this.sttUnavailable) {
        this.state.degraded = true
        this.state.sttStatus = t('识别不可用（仅检测出声）')
      }
      this.log(t('文本已转换为 {n} 个拼音音节', { n: res.syllables.length }), 'success')
    }

    _audioCtor() {
      if (this.media && this.media.AudioContext) return this.media.AudioContext
      if (this.env && (this.env.AudioContext || this.env.webkitAudioContext)) {
        return this.env.AudioContext || this.env.webkitAudioContext
      }
      return typeof AudioContext !== 'undefined' ? AudioContext : null
    }

    _workletCtor() {
      if (this.env && this.env.AudioWorkletNode) return this.env.AudioWorkletNode
      return typeof AudioWorkletNode !== 'undefined' ? AudioWorkletNode : null
    }

    // 必须在点击手势里同步调用（iOS/Android WebView 限制）
    _primeAudioGesture() {
      if (!this.audioContext) {
        const Ctx = this._audioCtor()
        if (Ctx) {
          try { this.audioContext = new Ctx() } catch (_) { this.audioContext = null }
        }
      }
      if (this.audioContext && this.audioContext.state === 'suspended') {
        try { this.audioContext.resume() } catch (_) {}
      }
    }

    async startAudio() {
      const Ctx = this._audioCtor()
      if (!Ctx) throw new Error(t('当前环境不支持音频采集'))
      let nav = (this.env && this.env.navigator) || (typeof navigator !== 'undefined' ? navigator : null)
      if (!this.testAudioUrl) {
        if (!nav || !nav.mediaDevices || !nav.mediaDevices.getUserMedia) {
          throw new Error(t('当前环境不支持麦克风采集'))
        }
      }
      if (!this.audioContext) this.audioContext = new Ctx()
      if (this.audioContext.state === 'suspended') {
        try { await this.audioContext.resume() } catch (_) { /* 用户手势后会自动恢复 */ }
      }
      const sr = this.audioContext.sampleRate || RG_CONST.SAMPLE_RATE
      this.ringBuffer = new RGRingBuffer(30, sr)
      this.detector = new RGVoiceDetector()
      this.analyser = this.audioContext.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyser.smoothingTimeConstant = 0.3
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount)
      this.timeData = new Float32Array(this.analyser.fftSize)
      this._bindAudioState()
      if (this.testAudioUrl) await this._startTestAudio()
      else await this._startMicAudio(nav)
      this.audioStartTime = Date.now()
      this.log(t('音频已连接，采样率 {sr}Hz', { sr }), 'success')
    }

    async _startMicAudio(nav) {
      this.stream = await nav.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      const track = this.stream.getAudioTracks()[0]
      if (track) {
        track.onended = () => this.onMicAbnormal(t('麦克风已断开'))
        track.onmute = () => this.onMicAbnormal(t('麦克风被静音或被打断'))
      }
      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream)
      this.sourceNode.connect(this.analyser)
      await this._connectRecorder()
    }

    async _startTestAudio() {
      const fetchFn = this.fetchFn || (this.env && this.env.fetch)
      if (!fetchFn) throw new Error(t('无法加载测试音频'))
      const res = await fetchFn(this.testAudioUrl)
      if (!res || res.ok === false) throw new Error(t('测试音频加载失败'))
      const buffer = await res.arrayBuffer()
      const audioBuffer = await new Promise((resolve, reject) => {
        try { this.audioContext.decodeAudioData(buffer, resolve, reject) } catch (error) { reject(error) }
      })
      this.testAudioBuffer = audioBuffer
      const source = this.audioContext.createBufferSource()
      source.buffer = audioBuffer
      source.connect(this.analyser)
      this.sourceNode = source
      await this._connectRecorder()
      source.start(this.audioContext.currentTime + 0.02)
      this.testAudioNode = source
      this.log(t('测试音频模式：使用 {name}', { name: this.testAudioUrl }), 'warning')
    }

    // 每遍开始时测试音频从头重新播放（自动化测试多遍用）
    _restartTestAudio() {
      if (!this.testAudioUrl || !this.testAudioBuffer || !this.audioContext) return false
      const ctx = this.audioContext
      try {
        if (this.testAudioNode) {
          try { this.testAudioNode.stop() } catch (_) {}
          try { this.testAudioNode.disconnect() } catch (_) {}
        }
        const source = ctx.createBufferSource()
        source.buffer = this.testAudioBuffer
        if (this.analyser) source.connect(this.analyser)
        const recorder = this.workletNode || this.scriptNode
        if (recorder) source.connect(recorder)
        // 必须从当前上下文时间开始：start(0) 在上下文已运行很久时会被当成“立即结束”
        source.start(ctx.currentTime + 0.02)
        this.testAudioNode = source
        this.sourceNode = source
        return true
      } catch (error) {
        this.log(t('测试音频重新播放失败: {msg}', { msg: error.message }), 'warning')
        return false
      }
    }

    async _connectRecorder() {
      const ctx = this.audioContext
      const mute = ctx.createGain()
      mute.gain.value = 0
      this.muteNode = mute
      mute.connect(ctx.destination)
      const WorkletNode = this._workletCtor()
      if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function' && WorkletNode) {
        const BlobCtor = (this.env && this.env.Blob) || (typeof Blob !== 'undefined' ? Blob : null)
        const URLObj = (this.env && this.env.URL) || (typeof URL !== 'undefined' ? URL : null)
        let loaded = false
        if (BlobCtor && URLObj && typeof URLObj.createObjectURL === 'function') {
          const blobUrl = URLObj.createObjectURL(new BlobCtor([rgWorkletCode()], { type: 'application/javascript' }))
          try {
            await ctx.audioWorklet.addModule(blobUrl)
            loaded = true
          } catch (error) {
            this.log(t('AudioWorklet 加载失败，改用 ScriptProcessor'), 'warning')
          } finally {
            try { URLObj.revokeObjectURL(blobUrl) } catch (_) {}
          }
        }
        if (loaded) {
          const node = new WorkletNode(ctx, 'rg-recorder')
          node.port.onmessage = event => {
            if (this.ringBuffer && event.data) this.ringBuffer.push(event.data)
          }
          this.sourceNode.connect(node)
          node.connect(mute)
          this.workletNode = node
          return
        }
      }
      this._connectScriptProcessor(mute)
    }

    _connectScriptProcessor(mute) {
      const ctx = this.audioContext
      const node = ctx.createScriptProcessor(4096, 1, 1)
      node.onaudioprocess = event => {
        if (!this.ringBuffer || !event || !event.inputBuffer) return
        this.ringBuffer.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      }
      this.sourceNode.connect(node)
      node.connect(mute)
      this.scriptNode = node
    }

    _bindAudioState() {
      const ctx = this.audioContext
      if (!ctx) return
      const handler = () => {
        const state = ctx.state
        if (this.state.ended || this.state.won) return
        if (state === 'suspended' || state === 'interrupted') {
          if (!this.state.paused) this.onMicAbnormal(t('音频被系统打断'))
        } else if (state === 'running' && this.state.paused && !this.ending) {
          this.resumeMic(Date.now())
        }
      }
      if (typeof ctx.addEventListener === 'function') ctx.addEventListener('statechange', handler)
      else ctx.onstatechange = handler
      this.audioStateHandler = handler
    }

    async stopAudio() {
      try {
        if (this.testAudioNode) {
          try { this.testAudioNode.stop() } catch (_) {}
          this.testAudioNode.disconnect()
        }
      } catch (_) {}
      try {
        if (this.stream) this.stream.getTracks().forEach(track => track.stop())
      } catch (_) {}
      try {
        if (this.workletNode) this.workletNode.port.onmessage = null
        if (this.scriptNode) this.scriptNode.onaudioprocess = null
        if (this.sourceNode) this.sourceNode.disconnect()
        if (this.workletNode) this.workletNode.disconnect()
        if (this.scriptNode) this.scriptNode.disconnect()
        if (this.muteNode) this.muteNode.disconnect()
      } catch (_) {}
      try {
        if (this.audioContext && this.audioContext.state !== 'closed') {
          if (this.audioStateHandler && typeof this.audioContext.removeEventListener === 'function') {
            this.audioContext.removeEventListener('statechange', this.audioStateHandler)
          }
          await this.audioContext.close()
        }
      } catch (_) {}
      this.audioStateHandler = null
      this.stream = null
      this.workletNode = null
      this.scriptNode = null
      this.muteNode = null
      this.testAudioNode = null
      this.sourceNode = null
      this.analyser = null
      this.audioContext = null
      this.ringBuffer = null
    }

    startTimers() {
      this.clearTimers()
      this.tickTimer = this.timers.setInterval(() => this.onTick(), RG_CONST.FRAME_MS)
      this.renderTimer = this.timers.setInterval(() => {
        if (!this.state.ended && this.state.phase !== 'idle') this.renderUI()
      }, RG_CONST.RENDER_MS)
    }

    clearTimers() {
      if (this.tickTimer) { this.timers.clearInterval(this.tickTimer); this.tickTimer = null }
      if (this.renderTimer) { this.timers.clearInterval(this.renderTimer); this.renderTimer = null }
      if (this.shockTimer) { this.timers.clearTimeout(this.shockTimer); this.shockTimer = null }
    }

    bindEsc() {
      if (this.escHandler || !this.win || typeof this.win.addEventListener !== 'function') return
      this.escHandler = event => {
        if (event && event.key === 'Escape') this.emergencyStop()
      }
      this.win.addEventListener('keydown', this.escHandler)
    }

    unbindEsc() {
      if (this.escHandler && this.win) {
        this.win.removeEventListener('keydown', this.escHandler)
      }
      this.escHandler = null
    }

    bindLifecycle() {
      if (this.doc && !this.visibilityHandler && typeof this.doc.addEventListener === 'function') {
        this.visibilityHandler = () => {
          if (this.doc.hidden) this.onHidden()
          else this.onVisible()
        }
        this.doc.addEventListener('visibilitychange', this.visibilityHandler)
      }
      if (this.win && !this.unloadHandler && typeof this.win.addEventListener === 'function') {
        this.unloadHandler = () => {
          this.safeShockOff()
          this._setLock(true)
        }
        this.win.addEventListener('pagehide', this.unloadHandler)
        this.win.addEventListener('beforeunload', this.unloadHandler)
      }
    }

    unbindLifecycle() {
      if (this.visibilityHandler && this.doc && typeof this.doc.removeEventListener === 'function') {
        this.doc.removeEventListener('visibilitychange', this.visibilityHandler)
      }
      this.visibilityHandler = null
      if (this.unloadHandler && this.win) {
        this.win.removeEventListener('pagehide', this.unloadHandler)
        this.win.removeEventListener('beforeunload', this.unloadHandler)
      }
      this.unloadHandler = null
    }
  onHidden() {
    if (this.state.ended) return
    this.state.hidden = true
    this.state.warning = null
    if (this.trigger) this.trigger.setPaused(Date.now(), true)
    // 页面被打断：立即关闭电击输出（宿主侧看门狗之外的最后一道保险）
    this.stopShock({ silent: true })
    this.log(t('窗口已隐藏，暂停判定并已关闭电击输出'), 'warning')
  }

  onVisible() {
    if (this.state.ended) return
    this.state.hidden = false
    const now = Date.now()
    this._requestWakeLock()
    if (this.audioContext && this.audioContext.state === 'suspended') {
      try { this.audioContext.resume() } catch (_) {}
    }
    if (!this.state.paused && this.detector) {
      // 恢复后重新校准，计时重置（手机切后台回来时底噪可能已经变了）
      this.detector.startCalibration(now)
      this.state.phase = 'calibrating'
    }
    if (this.trigger) {
      this.trigger.setPaused(now, false)
      this.trigger.lastVoiceAt = now
      this.trigger.lastEnergyAt = now
    }
    this.nextChunkAt = now + this.config.segmentHop * 1000
    this.log(t('窗口已恢复，重新开始计时'), 'info')
  }

  onMicAbnormal(reason) {
    if (this.state.ended || this.state.paused) return
    this.state.paused = true
    this.state.pauseReason = reason || t('麦克风异常')
    this.state.warning = null
    this.state.phase = 'paused'
    if (this.trigger) this.trigger.setPaused(Date.now(), true)
    this.stopShock({ silent: true })
    this.log(t('麦克风异常，游戏已暂停（不判定惩罚）: {reason}', { reason: this.state.pauseReason }), 'error')
    this.renderUI()
  }

  resumeMic(now) {
    if (!this.state.paused) return
    this.state.paused = false
    this.state.pauseReason = ''
    this.state.phase = 'calibrating'
    if (this.trigger) this.trigger.setPaused(now, false)
    if (this.detector) this.detector.startCalibration(now)
    this.log(t('麦克风恢复，重新校准底噪'), 'success')
  }

  // 屏幕常亮：有 wakeLock 就申请，没有就在界面提示不要锁屏
  async _requestWakeLock() {
    const nav = (this.env && this.env.navigator) || (typeof navigator !== 'undefined' ? navigator : null)
    if (!nav || !nav.wakeLock || typeof nav.wakeLock.request !== 'function') {
      this.wakeLockSupported = false
      return false
    }
    this.wakeLockSupported = true
    if (this.wakeLock) return true
    try {
      const lock = await nav.wakeLock.request('screen')
      this.wakeLock = lock || null
      if (lock && typeof lock.addEventListener === 'function') {
        lock.addEventListener('release', () => {
          if (this.wakeLock === lock) this.wakeLock = null
        })
      }
      return !!this.wakeLock
    } catch (error) {
      this.wakeLock = null
      this.log(t('屏幕常亮申请失败: {msg}', { msg: error.message }), 'warning')
      return false
    }
  }

  async _releaseWakeLock() {
    const lock = this.wakeLock
    this.wakeLock = null
    if (!lock || typeof lock.release !== 'function') return
    try { await lock.release() } catch (_) {}
  }

  _measureAudio() {
    const sr = (this.audioContext && this.audioContext.sampleRate) || RG_CONST.SAMPLE_RATE
    const binHz = sr / this.analyser.fftSize
    const low = Math.max(0, Math.ceil(RG_CONST.BAND_LOW_HZ / binHz))
    const high = Math.min(this.freqData.length - 1, Math.floor(RG_CONST.BAND_HIGH_HZ / binHz))
    let sum = 0
    let count = 0
    for (let i = low; i <= high; i++) {
      sum += this.freqData[i]
      count += 1
    }
    const level = count ? sum / count : 0
    let peak = 0
    for (let i = 0; i < this.timeData.length; i++) {
      const v = Math.abs(this.timeData[i])
      if (v > peak) peak = v
    }
    return { level, peak }
  }

  onTick() {
    if (this.state.ended || this.state.won) return
    const now = Date.now()
    if (this._checkTotalTime(now)) return
    if (this.state.hidden) return
    if (!this.analyser) return
    this.analyser.getByteFrequencyData(this.freqData)
    this.analyser.getFloatTimeDomainData(this.timeData)
    const measured = this._measureAudio()
    this.state.audioLevel = measured.level
    if (this.state.phase === 'rest') {
      this._tickRest(now)
      return
    }
    const info = this.detector.process(measured.level, now, measured.peak)
    this.state.audioLevel = measured.level
    this.state.threshold = info.threshold
    this.state.thresholdEnergy = info.thresholdEnergy
    this.state.floor = info.floor
    this.state.voiceLevel = info.voiceLevel
    this.state.lastVoiceAt = info.lastVoiceAt
    this.state.lastEnergyAt = info.lastEnergyAt
    if (info.calibrating) {
      this.state.phase = 'calibrating'
      return
    }
    if (info.justCalibrated) {
      const firstCalibration = !this.readingStartTime
      if (firstCalibration) {
        this.readingStartTime = now
        this.state.readingStartTime = now
      }
      this.nextChunkAt = now + this.config.segmentLen * 1000
      this.state.phase = 'reading'
      if (this.trigger) {
        if (firstCalibration) {
          this.trigger.reset(now)
        } else {
          this.trigger.setPaused(now, false)
          this.trigger.setPosition(now, this.state.position)
        }
      }
      this.log(firstCalibration ? '麦克风校准完成，请开始朗读' : '重新校准完成，继续朗读', 'success')
    }
    this.state.isVoiced = info.voiced
    this.state.lastVoiceAt = info.lastVoiceAt
    // 测试音频播完后输入端是数字静音（峰值恒为 0），不能当成“麦克风异常”暂停；
    // 否则结尾确认还没跑完就被暂停，测试注入永远无法通关。真实麦克风仍按原逻辑处理。
    if (!this.state.paused && info.micAbnormal && !this.testAudioUrl) {
      this.onMicAbnormal('连续 2 秒没有音频输入')
    }
    if (this.state.paused) {
      if (measured.peak > 0.0005) this.resumeMic(now)
      else return
    }
    if (!this.trigger) return
    if (info.voiced || info.energyAbove) {
      const voiceResult = this.trigger.setVoice(now)
      if (voiceResult.action === 'cancel') this._onWarningCancel('T1')
      if (this.state.endWait) {
        this.state.endWait = null
        this.trigger.clearTailGuard()
      }
      if (this.state.tailConfirm) {
        this.state.tailConfirm = null
        this.trigger.clearTailGuard()
        this.log('检测到声音，退出最终确认', 'success')
      }
    }
    this.trigger.setAudioNow(Math.max(0, now - this.audioStartTime))
    this._checkProactiveTransport(now)
    this._updateEndHold(now)
    this.trigger.setT2Blocked(!!(this.state.endWait || this.state.tailConfirm))
    if (this.state.warning && this.state.warning.reason === 'T2') {
      const reqStart = this._qualifiedT2RequestStart()
      if (reqStart != null) this.trigger.extendWarning(now, true, reqStart)
    }
    const action = this.trigger.tick(now)
    this._handleTriggerAction(action, now)
    this._syncWarningState()
    this.state.silenceSeconds = Math.max(0, (now - this.trigger.lastEnergyAt) / 1000)
    this._maybeTailConfirm(now)
    this.state.degraded = this.trigger.degraded || this.sttUnavailable
    this.state.t2Bad = this.trigger.badSegments.filter(s => now - s.t < this.config.stallLimit * 1000).length
    const from = now - this.config.stallLimit * 1000
    this.state.t2Advance = this.trigger.pos - this.trigger._positionAt(from)
    this.state.cooldownUntil = this.trigger.cooldownUntil
    if (this.state.phase === 'cooldown' && !this.state.warning &&
        now >= this.trigger.cooldownUntil && !this.state.paused) {
      this.state.phase = 'reading'
    }
    this.voiceTicks.push({ t: now, voiced: info.voiced })
    if (this.voiceTicks.length > 900) this.voiceTicks.shift()
    this._recordVoicedTick(now, info.voiced)
    this._updateSttStatus()
    this._scheduleChunk(now)
    this._maybeFinalChunk(now)
  }
  _syncWarningState() {
    if (!this.trigger || !this.state.warning) return
    if (this.trigger.warning) return
    // trigger 已自行取消（reading 前进、条件不再满足等），游戏侧状态必须对账
    const reason = this.state.warning.reason === 'T2' ? 'sync' : 'T1'
    this._onWarningCancel(reason)
  }

  _onWarningCancel(reason) {
    if (!this.state.warning) return
    this.state.warning = null
    if (this.state.phase === 'warning') this.state.phase = 'reading'
    let text = '警告已取消'
    if (reason === 'T1') text = '检测到声音，警告已取消'
    else if (reason === 'T2-limit') text = '离稿确认超时，本次不电击'
    else if (reason === 'T2') text = '离稿判定已恢复，警告取消'
    else if (reason === 'sync') text = '警告判定条件已恢复，警告取消'
    else text = '阅读位置前进，警告取消'
    this.log(text, 'info')
  }

  _qualifiedT2RequestStart() {
    const w = this.state.warning
    if (!w || w.reason !== 'T2') return null
    let best = null
    for (let i = 0; i < this.requestStarts.length; i++) {
      const r = this.requestStarts[i]
      if (Number(r.audioStartMs) >= Number(w.audioStartMs || 0)) {
        if (best == null || r.t > best) best = r.t
      }
    }
    return best
  }

  _handleTriggerAction(action, now) {
    if (!action || action.action === 'none') {
      // 直接驱动状态机的测试/调用路径也要与游戏侧警告状态对账
      this._syncWarningState()
      return
    }
    if (action.action === 'stalled' || action.action === 'paused') {
      // tick 跳变或暂停时界面不能残留旧警告
      if (this.state.warning) {
        this.state.warning = null
        if (this.state.phase === 'warning') this.state.phase = 'reading'
        this.renderUI()
      }
      return
    }
    if (action.action === 'warn-start') {
      this.state.warning = {
        reason: action.reason,
        startedAt: now,
        dueAt: now + Math.max(0, action.remaining || 0),
        audioStartMs: action.audioStartMs || 0
      }
      this.state.phase = 'warning'
      this.state.lastBeepSecond = -1
      this.playBeep(200, 0.18)
      this.log(action.reason === 'T1'
        ? '检测到沉默，' + Math.max(1, Math.round((action.remaining || 0) / 1000)) + ' 秒后电击，请继续朗读！'
        : '检测到长时间未按原文朗读，' + Math.max(1, Math.round((action.remaining || 0) / 1000)) + ' 秒后电击！', 'warning')
      this.renderUI()
      return
    }
    if (action.action === 'cancel') {
      this._onWarningCancel(action.reason)
      return
    }
    if (action.action === 'shock') {
      this.state.warning = null
      this.state.phase = 'cooldown'
      this.doShock(action.reason, now)
      return
    }
    if (action.action === 'limit') {
      this.state.warning = null
      this.state.phase = 'cooldown'
      this.log('已达到每分钟电击次数上限，本次不再电击', 'error')
      this.renderUI()
      return
    }
    if (action.action === 'warning') {
      if (!this.state.warning) {
        this.state.warning = {
          reason: action.reason,
          startedAt: now,
          dueAt: now + (action.remaining || 0),
          audioStartMs: action.audioStartMs || (this.state.warning && this.state.warning.audioStartMs) || 0
        }
      } else {
        this.state.warning.dueAt = now + (action.remaining || 0)
      }
      const sec = Math.ceil((action.remaining || 0) / 1000)
      if (sec >= 0 && sec !== this.state.lastBeepSecond) {
        this.state.lastBeepSecond = sec
        if (sec > 0) this.playBeep(200, 0.1)
      }
    }
  }

  _voiceRatio(startMs, endMs) {
    let total = 0
    let voiced = 0
    for (let i = this.voiceTicks.length - 1; i >= 0; i--) {
      const tick = this.voiceTicks[i]
      if (tick.t < startMs) break
      if (tick.t > endMs) continue
      total += 1
      if (tick.voiced) voiced += 1
    }
    if (!total) return 0
    return voiced / total
  }

  _scheduleChunk(now) {
    if (this.state.paused || this.state.ended || this.state.won) return
    if (this.state.phase === 'rest') return
    if (!this.readingStartTime) return
    if (now - this.readingStartTime < this.config.segmentLen * 1000) return
    if (!this.nextChunkAt) this.nextChunkAt = this.readingStartTime + this.config.segmentLen * 1000
    if (now < this.nextChunkAt) return
    this.nextChunkAt = now + Math.max(0.5, this.config.segmentHop) * 1000
    this.uploadSegment(now, false)
  }

  _maybeFinalChunk(now) {
    if (this.state.silenceSeconds < 2) return
    if (this.state.ended || this.state.won || this.state.paused) return
    if (this.state.phase === 'rest') return
    if (this.state.tailConfirm || this.state.endWait) return
    if (!this.lastChunkEndSec) return
    const nowSec = (now - this.readingStartTime) / 1000
    if (nowSec - this.lastChunkEndSec < 1.5) return
    this.uploadSegment(now, true)
  }

  uploadSegment(now, isFinal, options) {
    if (!this.ringBuffer) return
    const opts = options || {}
    const lenMs = Math.max(1000, Number(opts.lenMs) || this.config.segmentLen * 1000)
    const sr = this.ringBuffer.sampleRate
    const endSample = Math.round((now - this.audioStartTime) * sr / 1000)
    const startSample = endSample - Math.round(lenMs * sr / 1000)
    if (startSample < 0) return
    const startMs = now - lenMs
    const audioStartMs = Math.max(0, now - this.audioStartTime - lenMs)
    const audioEndMs = Math.max(0, now - this.audioStartTime)
    const ratio = this._voiceRatio(startMs, now)
    this.lastChunkEndSec = (now - this.readingStartTime) / 1000
    // 语音识别不可用：不上传，按“识别失败（未知）”处理，永不作为惩罚证据
    if (this.sttUnavailable) {
      const isConfirm = !!opts.confirm
      const passId = this.passId
      this.timers.setTimeout(() => {
        if (this._isStalePass(passId)) return
        this._applyUnknown(0, 'no-speech', t('（语音识别不可用）'), audioStartMs, audioEndMs, isConfirm, passId)
      }, 0)
      return
    }
    if (ratio < 0.2 && !opts.force) {
      this._recordSegment({
        text: '（本段没有检测到声音）',
        verdict: 'silent',
        position: this.state.position,
        advanced: false,
        reason: 'silent'
      })
      return
    }
    const raw = this.ringBuffer.getRange(startSample, endSample)
    if (!raw || !raw.length) return
    const pcm16 = rgResample(raw, sr, RG_CONST.SAMPLE_RATE)
    const item = {
      wav: rgEncodeWav(pcm16, RG_CONST.SAMPLE_RATE),
      isFinal: !!isFinal,
      confirm: !!opts.confirm,
      audioStartMs,
      audioEndMs
    }
    if (this.state.sttInFlight >= 2) {
      // 普通分片也排队，保证位置最终能追上；队列最多 2 段，溢出丢最旧的
      this._enqueueItem(item)
      return
    }
    this._startSegment(item)
  }

  _enqueueItem(item) {
    if (!item) return
    const dup = this.finalQueue.some(q => Math.abs(q.audioEndMs - item.audioEndMs) < 500)
    if (dup) return
    this.finalQueue.push(item)
    while (this.finalQueue.length > 2) this.finalQueue.shift()
  }
  _startSegment(item) {
    if (!item || this.state.ended || this.state.won) return
    if (this.state.phase === 'rest') return
    this.chunkSeq += 1
    const seq = this.chunkSeq
    const passId = this.passId
    this.state.sttInFlight += 1
    this.requestStarts.push({
      seq,
      passId,
      t: Date.now(),
      audioStartMs: Number(item.audioStartMs) || 0,
      audioEndMs: Number(item.audioEndMs) || 0
    })
    this._updateSttStatus()
    this._processSegment(seq, item.wav, item.isFinal, item.audioStartMs, item.audioEndMs, !!item.confirm, passId)
  }

  _drainFinalQueue() {
    if (this.state.ended || this.state.won) { this.finalQueue = []; return }
    while (this.state.sttInFlight < 2 && this.finalQueue.length) {
      const item = this.finalQueue.shift()
      this._startSegment(item)
    }
  }

  _speechSpeed(now) {
    const elapsed = Math.max(1, (now - (this.readingStartTime || now)) / 1000)
    let speed = this.state.position > 0 ? this.state.position / elapsed : 4
    if (!isFinite(speed) || speed <= 0) speed = 4
    return Math.max(1.5, Math.min(8, speed))
  }

  // 最后一段有声区间是否还有结果没回来（在途或排队）
  _pendingCoveringVoice() {
    if (!this.voiceTicks.length || !this.audioStartTime) return false
    let endWall = null
    let startWall = null
    for (let i = this.voiceTicks.length - 1; i >= 0; i--) {
      const tick = this.voiceTicks[i]
      if (tick.voiced) {
        if (endWall == null) endWall = tick.t
        startWall = tick.t
      } else if (endWall != null) break
    }
    if (endWall == null) return false
    const startMs = Math.max(0, startWall - this.audioStartTime)
    const endMs = Math.max(0, endWall - this.audioStartTime)
    const overlaps = item => item &&
      Number(item.audioEndMs) >= startMs &&
      Number(item.audioStartMs) <= endMs + 300
    return this.requestStarts.some(overlaps) || this.finalQueue.some(overlaps)
  }

  _lastVoicedEndWall() {
    for (let i = this.voiceTicks.length - 1; i >= 0; i--) {
      if (this.voiceTicks[i].voiced) return this.voiceTicks[i].t
    }
    return 0
  }

  // 累计有声时长按秒分桶，不受 voiceTicks 的 45 秒回看上限影响
  _recordVoicedTick(now, voiced) {
    if (!voiced || !this.audioStartTime) return
    const relMs = Math.max(0, now - this.audioStartTime)
    const sec = Math.floor(relMs / 1000)
    const bucket = this.voicedBuckets.get(sec) || 0
    this.voicedBuckets.set(sec, Math.min(1000, bucket + RG_CONST.FRAME_MS))
  }

  // 已应用位置 + 语速 × 尚未被结果覆盖的有声秒数
  _estimatePosition(now) {
    const applied = Number(this.appliedAudioEndMs) || 0
    const cutoff = applied + 250
    let voicedMs = 0
    this.voicedBuckets.forEach((ms, sec) => {
      const start = sec * 1000
      const end = start + 1000
      if (end <= cutoff) return
      const from = Math.max(start, cutoff)
      voicedMs += ms * (end - from) / 1000
    })
    // 识别滞后会让“位置/已用时间”低估语速；结尾估计取 6–8 音节/秒的保守区间，
    // 宁可多进一次最终确认（确认到中段仍会恢复 T1），也不漏判真正读完的人
    const speed = Math.max(6, Math.min(8, this._speechSpeed(now)))
    return this.state.position + Math.round(speed * voicedMs / 1000)
  }

  // 沉默达到 T1 阈值时，先等在途结果；等待期间显示“确认中”，不电击
  _updateEndHold(now) {
    if (this.state.ended || this.state.won || this.state.paused || this.state.hidden) return
    if (this.state.tailConfirm) return
    const silenceMs = Math.max(0, now - this.trigger.lastEnergyAt)
    const warnAtMs = Math.max(0, (this.config.silenceLimit - this.config.warnLead) * 1000)
    if (this.state.endWait) {
      if (silenceMs < 1500) {
        this.state.endWait = null
        this.trigger.clearTailGuard()
        return
      }
      const pending = this._pendingCoveringVoice()
      if (!pending || now >= this.state.endWait.deadline) this._finishEndWait(now)
      return
    }
    if (this.state.warning) return
    if (silenceMs < warnAtMs) return
    if (this._pendingCoveringVoice()) {
      this.state.endWait = {
        startedAt: now,
        deadline: now + Math.max(1000, Number(this.config.sttTimeout) || 15000)
      }
      this.trigger.setTailGuard(true, now)
      this.log('最后一段识别仍在途，正在确认；确认期间不会电击', 'info')
      return
    }
    // 没有在途结果：直接按“估计位置 + tailCap”判定，必要时进入最终确认
    this._finishEndWait(now)
  }

  _finishEndWait(now) {
    this.state.endWait = null
    const total = this.state.totalSyllables || 0
    if (total > 0 && this.state.position >= total - RG_CONST.WIN_SLACK_SYLLABLES) {
      this.trigger.clearTailGuard()
      this._onPassDone('won')
      return
    }
    const estimate = this._estimatePosition(now)
    if (total > 0 && estimate >= total - RG_CONST.TAIL_ESTIMATE_SLACK) {
      this.state.tailConfirm = { startedAt: now, attempts: 0, lastAt: 0, nextAt: 0 }
      this.trigger.setTailGuard(true, now)
      this.log('已接近结尾，正在最终确认最后一段朗读；确认期间不会电击', 'info')
      return
    }
    // 其他情况恢复正常 T1；把计时推进到“应立即警告”，仍给满 warnLead
    if (this.trigger.tailGuard) this.trigger.setTailGuard(false, now)
    else this.trigger.armSilenceWarning(now)
  }

  // 最终确认：上传最后一段音频，最多 2 次；确认期间不判 T1/T2
  _maybeTailConfirm(now) {
    if (this.state.ended || this.state.won) return
    if (this.state.hidden || this.state.paused) return
    const c = this.state.tailConfirm
    if (!c) return
    if (this.state.silenceSeconds < 1.5) {
      this.state.tailConfirm = null
      this.trigger.clearTailGuard()
      return
    }
    if (c.nextAt && now < c.nextAt) return
    if (this.state.sttInFlight > 0) return
    if (c.attempts >= 2) { this._finishIncomplete(); return }
    c.attempts += 1
    c.lastAt = now
    c.nextAt = now + Math.max(3000, Number(this.config.sttTimeout) / 2)
    // 锚定在最后一段有声区间的结束点，而不是当前时刻
    const anchor = this._lastVoicedEndWall() || now
    this.uploadSegment(anchor, true, {
      confirm: true,
      force: true,
      lenMs: Number(this.config.finalConfirmLen) * 1000
    })
  }
  _afterTailConfirm(now, verdict, result) {
    const c = this.state.tailConfirm
    if (!c || this.state.ended || this.state.won) return
    if (verdict === 'superseded') {
      // 确认结果被更新的结果覆盖：退回这次尝试，稍后重试
      c.attempts = Math.max(0, c.attempts - 1)
      c.unknowns = Math.max(0, c.unknowns || 0)
      c.nextAt = now + 500
      return
    }
    const total = this.state.totalSyllables || 0
    if (verdict === 'reading') {
      const endpoint = Number(result && result.newPos)
      if (isFinite(endpoint) && endpoint >= total - RG_CONST.TAIL_ESTIMATE_SLACK) {
        this.state.tailConfirm = null
        this._onPassDone('won')
        return
      }
      // 读到原文但停在中段：退出确认，恢复 T1，警告给满
      this.state.tailConfirm = null
      this.trigger.setTailGuard(false, now)
      this.log('最终确认停在中段，恢复沉默判定', 'warning')
      return
    }
    if (verdict === 'offtext') {
      this.state.tailConfirm = null
      this.trigger.setTailGuard(false, now)
      this.log('最终确认判定为离稿，恢复沉默判定', 'warning')
      return
    }
    if (this.state.silenceSeconds < 1.5) {
      this.state.tailConfirm = null
      this.trigger.clearTailGuard()
      return
    }
    c.unknowns = (c.unknowns || 0) + 1
    if (c.unknowns >= 2) { this._finishIncomplete(); return }
    c.nextAt = now + 2500
  }

  // 读完但末尾无法确认：本遍按“已完成（未能确认结尾）”计，不电击
  _finishIncomplete() {
    if (this.state.ended || this.state.won) return
    this.state.tailConfirm = null
    if (this.trigger) this.trigger.clearTailGuard()
    this._onPassDone('unconfirmed')
  }

  // 一遍结束：朗读按遍数推进；背诵按正确率升级/留级，100% 遮字过关即通关
  _onPassDone(kind) {
    if (this.state.ended || this.state.won || this.state.phase === 'rest') return
    const now = Date.now()
    const accuracy = rgAccuracy(this.passMatched, this.state.totalSyllables, this.state.position)
    this.state.lastAccuracy = accuracy
    this.state.lastPassKind = kind === 'unconfirmed' ? 'unconfirmed' : 'won'
    this.state.completedPasses += 1
    if (this.trigger) this.trigger.setPaused(now, true)
    this.stopShock({ silent: true })
    this.state.warning = null
    this.state.endWait = null
    this.state.tailConfirm = null
    if (this.state.mode !== 'recite') {
      this.state.lastPassPassed = null
      if (this.state.completedPasses >= this.state.totalPasses) {
        this._finishGame(kind)
      } else {
        this._enterRest(now)
      }
      return
    }
    const pct = accuracy * 100
    const line = Math.max(0, Math.min(100, Number(this.config.passRate) || 85))
    const passed = pct >= line - 1e-9
    this.state.lastPassPassed = passed
    if (passed && this.state.maskRatio >= 100) {
      this._finishGame(kind)
      return
    }
    if (passed) this.state.level = (Number(this.state.level) || 1) + 1
    this.log(passed
      ? t('第 {n} 遍正确率 {pct}%，过关，升到第 {lv} 级', { n: this.state.passNumber, pct: Math.round(pct), lv: this.state.level })
      : t('第 {n} 遍正确率 {pct}%，未达到 {line}%，留在第 {lv} 级重读', { n: this.state.passNumber, pct: Math.round(pct), line, lv: this.state.level }),
    passed ? 'success' : 'warning')
    this._enterRest(now)
  }

  _finishGame(kind) {
    this.state.unconfirmed = kind === 'unconfirmed'
    this.finishWin()
  }

  _enterRest(now) {
    const seconds = Math.max(0, Number(this.config.restSeconds) || 0)
    this.state.phase = 'rest'
    this.state.restSeconds = seconds
    this.state.restUntil = now + seconds * 1000
    this.state.restRemaining = seconds
    this.state.hintedChars = []
    this.hintedSet = new Set()
    if (this.state.mode === 'recite') {
      // 下一遍按（升级后的或留级的）当前级重新选遮字
      this._selectMask(this.state.passNumber + 1, this.state.level)
    } else {
      this.state.maskRatio = 0
      this.state.maskedChars = []
    }
    this.log(seconds > 0
      ? t('第 {n} 遍完成，休息 {sec} 秒', { n: this.state.passNumber, sec: seconds })
      : t('第 {n} 遍完成，立即开始下一遍', { n: this.state.passNumber }), 'info')
    if (seconds <= 0) {
      this._startNextPass(now)
      return
    }
    this.renderUI()
  }

  _tickRest(now) {
    const left = Math.max(0, this.state.restUntil - now)
    this.state.restRemaining = Math.ceil(left / 1000)
    if (left <= 0) this._startNextPass(now)
  }

  _startNextPass(now) {
    if (this.state.ended || this.state.won) return
    this.passId += 1
    this.state.passId = this.passId
    this.state.passNumber = (Number(this.state.passNumber) || 1) + 1
    this.state.position = 0
    this.state.sttInFlight = 0
    this.state.sttSlow = false
    this.state.sttStatus = t('待机')
    this.state.warning = null
    this.state.cooldownUntil = 0
    this.state.silenceSeconds = 0
    this.state.endWait = null
    this.state.tailConfirm = null
    this.state.hintedChars = []
    this.state.lastText = ''
    this.state.lastVerdict = ''
    this.state.segments = []
    this.state.phase = 'reading'
    this._segSig = ''
    this._textSig = ''
    this._lastCur = -1
    this.passMatched = new Set()
    this.jumpGate.reset()
    this.pendingJumpResult = null
    this.hintedSet = new Set()
    this.appliedAudioEndMs = 0
    this.requestStarts = []
    this.finalQueue = []
    this.voiceTicks = []
    this.voicedBuckets = new Map()
    this.lastChunkEndSec = 0
    this.readingStartTime = now
    this.state.readingStartTime = now
    this.nextChunkAt = now + this.config.segmentLen * 1000
    if (this.trigger) {
      this.trigger.reset(now)
      this.trigger.cfg.silenceLimit = this._effectiveSilenceLimit()
    }
    if (this.testAudioUrl) {
      // 测试音频每遍重播：休息期间没有音频写入，环形缓冲区的写入进度会落后于
      // “开始时刻”若干秒，若继续按全局时间取区间会读到上一遍的尾部。换新缓冲区
      // 并把音频时钟重置到本遍起点，保证取到的就是正在播放的这一遍音频。
      const sr = (this.audioContext && this.audioContext.sampleRate) || RG_CONST.SAMPLE_RATE
      this.ringBuffer = new RGRingBuffer(30, sr)
      this.audioStartTime = now
      this._restartTestAudio()
    }
    this.log(t('第 {n} 遍开始', { n: this.state.passNumber }) +
      (this.state.mode === 'recite' ? t('，第 {lv} 级遮字 {pct}%', { lv: this.state.level, pct: this.state.maskRatio }) : ''), 'info')
    this.renderUI()
  }

  _checkTotalTime(now) {
    if (this.state.ended || this.state.won) return false
    const minutes = Number(this.config.totalTime) || 0
    if (minutes <= 0 || !this.state.startTime) return false
    if (now - this.state.startTime < minutes * 60 * 1000) return false
    this.log(t('已到达游戏时间上限，自动结束'), 'error')
    this.end()
    return true
  }

  async _processSegment(seq, wav, isFinal, audioStartMs, audioEndMs, confirm, passId) {
    const startedAt = Date.now()
    try {
      if (!this.speech || typeof this.speech.transcribe !== 'function') {
        const error = new Error('NO_STT')
        error.code = 'NO_STT'
        throw error
      }
      const res = await this.speech.transcribe({
        audio: rgBytesToBase64(wav),
        format: 'wav',
        timeoutMs: this.config.sttTimeout
      })
      this._updateTransport(Date.now() - startedAt)
      if (this._isStalePass(passId)) return
      if (this._isStaleEnd(audioEndMs, confirm)) {
        if (confirm) this._afterTailConfirm(Date.now(), 'superseded')
        return
      }
      const text = String((res && res.text) || '').trim()
      if (!text) {
        this._applyUnknown(seq, 'empty', t('（没有识别到文字）'), audioStartMs, audioEndMs, confirm, passId)
        return
      }
      let py = null
      try {
        py = this.pinyin ? this.pinyin.textToPinyin(text) : null
      } catch (error) {
        py = null
      }
      if (this._isStalePass(passId)) return
      if (this._isStaleEnd(audioEndMs, confirm)) {
        if (confirm) this._afterTailConfirm(Date.now(), 'superseded')
        return
      }
      if (!py || py.error || !Array.isArray(py.syllables)) {
        this._applyUnknown(seq, 'pinyin-failed', text, audioStartMs, audioEndMs, confirm, passId)
        return
      }
      const result = this.aligner
        ? this.aligner.align(py.syllables, this.state.position)
        : { verdict: 'unknown', newPos: this.state.position, advanced: false, reason: 'no-aligner' }
      if (result.verdict === 'unknown') {
        this._applyUnknown(seq, result.reason || 'short-result', text, audioStartMs, audioEndMs, confirm, passId)
        return
      }
      this._applyResult(seq, result, text, audioStartMs, audioEndMs, confirm, passId)
    } catch (error) {
      this._updateTransport(Date.now() - startedAt)
      if (!this._isStalePass(passId)) {
        const reason = error && error.code === 'NO_STT' ? 'no-speech' : 'exception'
        this._applyUnknown(seq, reason, null, audioStartMs, audioEndMs, confirm, passId)
      }
    } finally {
      this.state.sttInFlight = Math.max(0, this.state.sttInFlight - 1)
      for (let i = this.requestStarts.length - 1; i >= 0; i--) {
        if (this.requestStarts[i].seq === seq) this.requestStarts.splice(i, 1)
      }
      this._updateSttStatus()
      this._drainFinalQueue()
    }
  }
  _isStaleEnd(endMs, confirm) {
    const end = Number(endMs) || 0
    if (confirm) return end < this.appliedAudioEndMs - 4000
    return end <= this.appliedAudioEndMs
  }

  // 上一遍在途的识别结果必须丢弃；休息期间也不接受任何结果
  _isStalePass(passId) {
    if (this.state.ended || this.state.won || this.state.phase === 'rest') return true
    if (passId == null) return false
    return Number(passId) !== Number(this.passId)
  }

  _applyUnknown(seq, reason, text, audioStartMs, audioEndMs, confirm, passId) {
    if (this._isStalePass(passId)) return
    const endMs = Number(audioEndMs) || 0
    if (this._isStaleEnd(endMs, confirm)) {
      if (confirm) this._afterTailConfirm(Date.now(), 'superseded')
      return
    }
    const now = Date.now()
    const wasDegraded = this.state.degraded
    if (this.trigger) {
      this.trigger.onSegment(now, {
        verdict: 'unknown',
        audioStartMs: Number(audioStartMs) || 0,
        audioEndMs: endMs
      })
      this.state.degraded = this.trigger.degraded || this.sttUnavailable
    }
    this._recordSegment({
      text: text || '（识别失败:' + reason + '）',
      verdict: 'unknown',
      position: this.state.position,
      advanced: false,
      reason
    })
    if (this.state.degraded && !wasDegraded) {
      this.log('识别连续失败，已退化为仅检测出声；识别恢复后会自动重新开启内容检测', 'error')
    }
    this._updateSttStatus()
    if (!this.state.ended && !this.state.won) this.renderUI()
    if (confirm) this._afterTailConfirm(now, 'unknown')
  }

  _applyResult(seq, result, text, audioStartMs, audioEndMs, confirm, passId) {
    if (this._isStalePass(passId)) return
    const endMs = Number(audioEndMs) || 0
    if (this._isStaleEnd(endMs, confirm)) {
      if (confirm) this._afterTailConfirm(Date.now(), 'superseded')
      return
    }
    this.appliedAudioEndMs = Math.max(this.appliedAudioEndMs, endMs)
    this.latestAppliedSeq = seq
    const now = Date.now()
    const posBefore = this.state.position
    const wasDegraded = this.state.degraded
    let advanced = false
    let pendingJump = false
    let deferredResult = null
    let targetPos = posBefore
    if (result.verdict === 'reading' && result.newPos > posBefore) {
      const decision = this.jumpGate.evaluate(result, posBefore)
      if (decision.action === 'defer') {
        pendingJump = true
        this.pendingJumpResult = result
      } else if (decision.action === 'accept') {
        deferredResult = this.pendingJumpResult
        this.pendingJumpResult = null
        targetPos = Math.max(posBefore, Number(decision.newPos) || 0)
      } else {
        this.pendingJumpResult = null
        targetPos = result.newPos
      }
    }
    if (targetPos > posBefore) {
      this.state.position = targetPos
      advanced = true
      if (this.trigger) this.trigger.setPosition(now, this.state.position)
    }
    // 正确率：只计入采纳后位置之前的配对；待定跳转先按当前位置记，确认后再补齐
    if (result.verdict === 'reading') {
      rgAddMatchedPairs(this.passMatched, result, pendingJump ? posBefore : this.state.position)
      if (!pendingJump && deferredResult) rgAddMatchedPairs(this.passMatched, deferredResult, this.state.position)
    }
    if (this.trigger) {
      // 识别结果反向佐证这段音频确实有人在读/出声，刷新 T1 计时
      const audioEndWall = this.audioStartTime + endMs
      if (result.verdict === 'reading' || result.verdict === 'offtext') {
        this.trigger.markAudioEvidence(now, audioEndWall)
      }
      this.trigger.onSegment(now, {
        verdict: result.verdict,
        advanced,
        pendingJump,
        matchRate: result.matchRate,
        strongCount: result.strongCount,
        audioStartMs: Number(audioStartMs) || 0,
        audioEndMs: endMs
      })
      this.state.degraded = this.trigger.degraded || this.sttUnavailable
    }
    this._recordSegment({
      text,
      verdict: result.verdict,
      position: this.state.position,
      advanced,
      reason: pendingJump ? ((result.reason || '') + '-pending-jump') : result.reason
    })
    if (!wasDegraded && this.state.degraded) {
      this.log('识别连续失败，已退化为仅检测出声', 'error')
    } else if (wasDegraded && !this.state.degraded) {
      this.log('识别已恢复，重新开启内容检测', 'success')
    }
    this._updateSttStatus()
    if (!this.state.ended && !this.state.won) this.renderUI()
    if (!pendingJump && this.state.totalSyllables > 0 &&
        this.state.position >= this.state.totalSyllables - RG_CONST.WIN_SLACK_SYLLABLES) {
      this._onPassDone('won')
      return
    }
    if (confirm && !this._isStalePass(passId)) this._afterTailConfirm(now, result.verdict, result)
  }

  _recordSegment(entry) {
    const record = {
      t: entry.t || Date.now(),
      text: entry.text || '',
      verdict: entry.verdict || 'unknown',
      position: entry.position != null ? entry.position : this.state.position,
      advanced: !!entry.advanced,
      reason: entry.reason || ''
    }
    this.state.segments.unshift(record)
    if (this.state.segments.length > 3) this.state.segments.length = 3
    this.state.lastText = record.text
    this.state.lastVerdict = record.verdict
  }

  _updateSttStatus() {
    if (this.sttUnavailable) {
      this.state.sttStatus = t(this.speechUnavailableText || '识别不可用（仅检测出声）')
    } else if (this.state.degraded) {
      this.state.sttStatus = t('识别不可用（仅检测出声）')
    } else if (this.state.sttSlow) {
      this.state.sttStatus = t('响应变慢（仅检测沉默）')
    } else if (this.state.sttInFlight > 0) {
      this.state.sttStatus = t('识别中（{n}）', { n: this.state.sttInFlight })
    } else {
      this.state.sttStatus = t('正常')
    }
  }

  _updateTransport(latency) {
    const ms = Math.round(Number(latency) || 0)
    this.latencySamples.push({ t: Date.now(), ms })
    if (this.latencySamples.length > 200) this.latencySamples.shift()
    const hopMs = Math.max(1000, (Number(this.config.segmentHop) || 3) * 1000)
    const limit = Math.max(4000, hopMs + 1000)
    this._setTransportSlow(ms > limit, ms)
  }

  _setTransportSlow(slow, latencyMs) {
    const ms = Math.round(Number(latencyMs) || 0)
    this.state.sttLatency = ms
    if (slow === this.state.sttSlow) return
    this.state.sttSlow = slow
    if (this.trigger) this.trigger.setTransportOk(!slow)
    this.log(slow
      ? '识别响应 ' + (ms / 1000).toFixed(1) + ' 秒，已暂停离稿判定，仅检测沉默'
      : '识别响应恢复（' + (ms / 1000).toFixed(1) + ' 秒），重新开启离稿判定',
    slow ? 'warning' : 'success')
    this._updateSttStatus()
    if (!this.state.ended && !this.state.won) this.renderUI()
  }

  _checkProactiveTransport(now) {
    if (this.state.sttSlow) return
    const hopMs = Math.max(1000, (Number(this.config.segmentHop) || 3) * 1000)
    const limit = Math.max(4000, hopMs + 1000)
    for (let i = 0; i < this.requestStarts.length; i++) {
      const elapsed = now - this.requestStarts[i].t
      if (elapsed > limit) {
        this._setTransportSlow(true, elapsed)
        return
      }
    }
  }

  _voltage(now) {
    if (this.state.lastShockAt && now - this.state.lastShockAt > 30000) {
      this.state.consecutiveShocks = 0
    }
    const raw = Number(this.config.shockIntensity) + Number(this.config.shockStep) * this.state.consecutiveShocks
    // 安全上限参照 maid-punishment：未显式允许时最高 30V
    const hardCap = this.config.allowUnsafeIntensity ? 100 : 30
    const declared = Number(this.config.shockMax) || Number(this.config.shockIntensity) || 1
    const cap = Math.max(1, Math.min(hardCap, declared))
    return Math.max(1, Math.min(cap, Math.round(raw)))
  }

  async doShock(reason, now) {
    if (this.state.isShocking || this.state.ended || this.state.phase === 'rest') return
    this.state.shockCount += 1
    this.state.lastShockAt = now
    this.state.consecutiveShocks += 1
    this.state.isShocking = true
    this.shockGen += 1
    const gen = this.shockGen
    const voltage = this._voltage(now)
    this.state.lastVoltage = voltage
    this.playBeep(120, 0.3)
    this.log('电击 #' + this.state.shockCount + '（' + (reason === 'T1' ? '沉默' : '离稿') + '），强度 ' + voltage + 'V', 'error')
    const ms = Math.max(100, Number(this.config.shockDuration) * 1000)
    // 先挂停止定时器再发 shock:1：即使 shock:1 的 IPC 卡住，到点也一定会发 shock:0
    if (this.shockTimer) this.timers.clearTimeout(this.shockTimer)
    this.shockTimer = this.timers.setTimeout(() => { this.stopShock({ gen }) }, ms)
    try {
      if (this.state.ended) return
      if (this.deviceManager && this.deviceManager.setDeviceProperty) {
        await this.deviceManager.setDeviceProperty('shock_device', {
          voltage,
          shock: 1,
          maxMs: ms + 3000
        })
      }
    } catch (error) {
      this.log('开始电击失败: ' + error.message, 'error')
    }
    this._applyHint()
    this.renderUI()
  }

  // 背诵卡壳被电后：从当前位置往后还原 hintChars 个被遮住的字
  _applyHint() {
    if (this.state.mode !== 'recite' || this.state.phase === 'rest') return 0
    const limit = Math.max(0, Math.floor(Number(this.config.hintChars) || 0))
    if (!limit) return 0
    const text = String(this.state.sourceText || '')
    const syllables = this.state.sourceSyllables || []
    const masked = new Set(this.state.maskedChars || [])
    if (!masked.size) return 0
    const pos = Math.max(0, Number(this.state.position) || 0)
    const from = pos < syllables.length && syllables[pos]
      ? syllables[pos].charIndex
      : text.length
    let added = 0
    for (let i = Math.max(0, from); i < text.length && added < limit; i++) {
      if (!masked.has(i) || this.hintedSet.has(i)) continue
      this.hintedSet.add(i)
      if (this.state.hintedChars.indexOf(i) < 0) this.state.hintedChars.push(i)
      added += 1
    }
    if (added) {
      this.log(t('卡壳提示：从当前位置还原 {n} 个字', { n: added }), 'warning')
      this.renderUI()
    }
    return added
  }

  async stopShock(options) {
    const silent = options && options.silent
    const gen = options && options.gen != null ? options.gen : this.shockGen
    if (this.shockTimer) {
      this.timers.clearTimeout(this.shockTimer)
      this.shockTimer = null
    }
    const was = this.state.isShocking
    this.state.isShocking = false
    const ok = await this._sendShockZero(gen)
    if (!ok) this.log('停止电击发送失败，已由宿主兜底处理', 'error')
    if (was && !silent) this.log('电击已停止', 'info')
    if (was && !this.state.ended && !this.state.won) this.renderUI()
  }

  // shock:0 发送失败时按 0.5s、1s、2s… 退避重试
  async _sendShockZero(gen) {
    if (!this.deviceManager || !this.deviceManager.setDeviceProperty) return true
    const delays = [0, 500, 1000, 2000, 4000]
    for (let i = 0; i < delays.length; i++) {
      if (gen !== this.shockGen) return true
      if (i > 0) await new Promise(resolve => this.timers.setTimeout(resolve, delays[i]))
      if (gen !== this.shockGen) return true
      try {
        const res = await this.deviceManager.setDeviceProperty('shock_device', { shock: 0 })
        if (res === false || (res && res.success === false)) {
          throw new Error((res && res.error) || '设备未确认')
        }
        return true
      } catch (error) {
        if (i === delays.length - 1) return false
      }
    }
    return false
  }
  playBeep(freq, duration) {
    if (!this.config.beep) return
    try {
      const ctx = this.audioContext
      if (!ctx || ctx.state === 'closed') return
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq || 880
      const dur = Math.max(0.05, duration || 0.15)
      const now = ctx.currentTime
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.15, now + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now)
      osc.stop(now + dur + 0.02)
    } catch (error) { /* 提示音失败不影响游戏 */ }
  }

  finishWin() {
    if (this.state.won || this.state.ended) return
    this.state.won = true
    this.state.ended = true
    this.state.isGameActive = false
    this.state.phase = 'won'
    this.state.warning = null
    if (this.trigger) this.trigger.setEnded()
    this.clearTimers()
    this.unbindEsc()
    this.unbindLifecycle()
    this.stopAudio()
    this.stopShock({ silent: true })
    this._setLock(true)
    this._releaseWakeLock()
    this.renderWin()
    const seconds = Math.max(0, Math.round((Date.now() - this.state.startTime) / 1000))
    this.log((this.state.mode === 'recite' ? '背诵通关' : '恭喜读完全文') +
      '，用时 ' + seconds + ' 秒，受罚 ' + this.state.shockCount + ' 次', 'success')
  }

  emergencyStop() {
    if (this.state.ended && this.ending) return
    this.log('紧急停止已触发（Esc 或按钮）', 'warning')
    this.end()
  }

  handleUIEvent(eventType) {
    if (eventType === 'emergencyStop' || eventType === 'quit' || eventType === 'stop') {
      this.emergencyStop()
    }
  }

  async loop(deviceManager) {
    if (this.state.ended || !this.state.isGameActive) return false
    if (this.state.won) return false
    if (Number(this.config.totalTime) > 0) {
      const limit = Number(this.config.totalTime) * 60 * 1000
      if (Date.now() - this.state.startTime >= limit) {
        this.log('超过总时限，游戏结束', 'error')
        this.end()
        return false
      }
    }
    return true
  }

  async end(deviceManager) {
    if (this.ending) {
      await this.safeShockOff()
      return
    }
    this.ending = true
    const won = this.state.won
    this.state.ended = true
    this.state.isGameActive = false
    if (this.trigger) this.trigger.setEnded()
    this.clearTimers()
    this.unbindEsc()
    this.unbindLifecycle()
    await this.stopAudio()
    await this.stopShock({ silent: true })
    await this._setLock(true)
    await this._releaseWakeLock()
    if (won) this.renderWin()
    else this.renderStopped()
    this.log('朗读游戏结束', 'info')
  }

  async safeShockOff() {
    try {
      if (this.deviceManager && this.deviceManager.setDeviceProperty) {
        await this.deviceManager.setDeviceProperty('shock_device', { shock: 0 })
      }
    } catch (error) { /* ignore */ }
  }

  stop() {
    this.end()
  }

  renderUI() {
    if (this.state.ended) {
      if (this.state.won) this.renderWin()
      else this.renderStopped()
      return
    }
    const s = this.state
    const now = Date.now()
    const text = s.sourceText || ''
    let cur = text.length
    if (s.position < s.sourceSyllables.length) {
      cur = s.sourceSyllables[s.position].charIndex
    }
    if (cur < 0) cur = 0
    if (cur > text.length) cur = text.length
    const readHtml = this._renderChars(text, 0, cur, cur)
    const currentHtml = cur < text.length ? this._renderChars(text, cur, cur + 1, cur) : ''
    const afterHtml = cur < text.length ? this._renderChars(text, cur + 1, text.length, cur) : ''
    const progress = s.totalSyllables ? Math.min(100, s.position / s.totalSyllables * 100) : 0
    const levelPct = Math.max(0, Math.min(100, (s.audioLevel / 120) * 100))
    const thPct = Math.max(0, Math.min(100, (s.threshold / 120) * 100))
    const phase = s.phase || 'reading'
    const displayPhase = s.isShocking ? 'shock' : phase
    const phaseText = s.isShocking ? t('电击中')
      : phase === 'calibrating' ? t('校准中')
      : phase === 'warning' ? t('警告')
      : phase === 'cooldown' ? t('冷却中')
      : phase === 'paused' ? t('已暂停')
      : phase === 'rest' ? t('休息中')
      : phase === 'won' ? t('已通关') : t('朗读中')
    const silenceText = s.silenceSeconds != null
      ? s.silenceSeconds.toFixed(1) + 's / ' + this._effectiveSilenceLimit().toFixed(1) + 's'
      : '—'
    let t2Text = t('已关闭')
    if (this.config.checkContent && !s.degraded) {
      t2Text = s.sttSlow ? t('识别延迟，已暂停') : t('{bad}/3段 · 前进{adv}字', { bad: s.t2Bad, adv: s.t2Advance })
    } else if (s.degraded) {
      t2Text = t('识别不可用')
    }
    const warning = s.warning
    const warnLeft = warning ? Math.max(0, Math.ceil((warning.dueAt - now) / 1000)) : 0
    let overlay = ''
    if (warning) {
      overlay = '<div class="rg-overlay"><div class="rg-overlay-card">' +
        '<div class="t">' + (warning.reason === 'T1' ? t('检测到沉默') : t('检测到离稿')) + '</div>' +
        '<div class="n">' + warnLeft + '</div>' +
        '<div class="s">' + (warning.reason === 'T1' ? t('请继续朗读') : t('请按原文继续朗读')) + t('，否则将电击') + '</div>' +
        '</div></div>'
    }
    const banners = []
    if (phase === 'calibrating') banners.push('<div class="rg-banner warn">' + t('麦克风校准中，请保持安静约 3 秒…') + '</div>')
    if (s.endWait || s.tailConfirm) banners.push('<div class="rg-banner ok">' + t('正在确认最后一段朗读…确认期间不会电击') + '</div>')
    if (s.paused) banners.push('<div class="rg-banner bad">' + t('麦克风异常，游戏已暂停：{reason}（暂停期间不判定惩罚）', { reason: rgEscapeHtml(s.pauseReason) }) + '</div>')
    if (s.isShocking) banners.push('<div class="rg-banner bad">' + t('电击执行中') + (s.lastVoltage ? t('（强度 {v}V）', { v: s.lastVoltage }) : '') + '</div>')
    else if (phase === 'cooldown' && s.cooldownUntil > now) banners.push('<div class="rg-banner warn">' + t('电击冷却中，剩余 {n} 秒', { n: Math.ceil((s.cooldownUntil - now) / 1000) }) + '</div>')
    if (s.degraded) banners.push('<div class="rg-banner warn">' + t(this.sttUnavailable
      ? (this.speechUnavailableText || '识别不可用（仅检测出声）')
      : '识别不可用，已退化为仅检测是否出声；此期间不会因离稿电击，识别恢复后自动开启') + '</div>')
    if (s.sttSlow && !s.degraded) banners.push('<div class="rg-banner warn">' + t('识别响应变慢，已暂停离稿判定；此期间只检测沉默，恢复后自动开启') + '</div>')
    if (!this.config.checkContent) banners.push('<div class="rg-banner ok">' + t('内容检测已关闭，仅检测是否出声') + '</div>')
    if (this.wakeLockSupported === false) banners.push('<div class="rg-banner warn">' + t('当前设备不支持屏幕常亮，请勿锁屏') + '</div>')
    let segHtml = ''
    if (s.segments && s.segments.length) {
      segHtml = s.segments.map(seg => {
        return '<div class="rg-seg">' +
          '<span class="tag ' + seg.verdict + '">' + t(rgVerdictLabel(seg.verdict)) + '</span>' +
          '<span class="txt">' + rgEscapeHtml(seg.text) + '</span>' +
          '<span class="pos">' + seg.position + '/' + (s.totalSyllables || '—') + '</span>' +
          '</div>'
      }).join('')
    } else {
      segHtml = '<div class="rg-seg"><span class="tag">—</span><span class="txt rg-muted">' + t('等待第一段识别结果…') + '</span></div>'
    }
    const sttClass = s.degraded ? 'rg-bad' : (s.sttInFlight > 0 || s.sttSlow ? 'rg-warn' : 'rg-good')
    const t2Class = s.degraded ? 'rg-bad' : (s.sttSlow || s.t2Bad >= 3 ? 'rg-warn' : 'rg-good')
    const resting = phase === 'rest'
    const restLeft = resting ? Math.max(0, Math.ceil((s.restUntil - now) / 1000)) : 0
    this._paintUI({
      cur, text, readHtml, currentHtml, afterHtml, progress, levelPct, thPct,
      displayPhase, phaseText, silenceText, t2Text, t2Class, sttClass,
      overlay, banners: banners.join(''), segHtml, warning,
      modeText: s.mode === 'recite' ? t('背诵') : t('朗读'),
      passText: s.mode === 'recite'
        ? t('第 {n} 遍', { n: s.passNumber })
        : t('第 {n}/{total} 遍', { n: Math.min(s.passNumber, s.totalPasses), total: s.totalPasses }),
      levelText: t('第 {n} 级', { n: s.level }),
      maskText: t('遮字 {pct}%', { pct: Math.round(Number(s.maskRatio) || 0) }),
      rateText: s.lastAccuracy == null ? '—' : Math.round(s.lastAccuracy * 100) + '%',
      showRecite: s.mode === 'recite',
      resting, restLeft, restSub: resting ? this._restSummary() : ''
    })
  }

  _restSummary() {
    const s = this.state
    const pct = s.lastAccuracy == null ? '—' : Math.round(s.lastAccuracy * 100)
    const tail = s.lastPassKind === 'unconfirmed' ? t('（结尾未确认）') : ''
    if (s.mode === 'recite') {
      const base = s.lastPassPassed
        ? t('上一遍正确率 {pct}%，过关，升到第 {lv} 级', { pct, lv: s.level })
        : t('上一遍正确率 {pct}%，未过关，留在第 {lv} 级', { pct, lv: s.level })
      return base + tail + ' · ' + t('下一遍遮字 {pct}%', { pct: Math.round(Number(s.maskRatio) || 0) })
    }
    return t('已完成 {done}/{total} 遍', { done: s.completedPasses, total: s.totalPasses }) +
      ' · ' + t('上一遍正确率 {pct}%', { pct }) + tail
  }

  // 按字形渲染一段文字：遮字黑块、读过淡色、提示琥珀色
  _renderChars(text, from, to, cur) {
    const s = this.state
    const masked = s.maskedChars && s.maskedChars.length ? new Set(s.maskedChars) : null
    const hinted = this.hintedSet
    let html = ''
    for (let i = from; i < to; i++) {
      const ch = text.charAt(i)
      if (ch === '\n') {
        html += '<br>'
        continue
      }
      const isCurrent = i === cur
      const revealed = i < cur || (hinted && hinted.has(i))
      let cls = ''
      let content = ch === ' ' ? '&nbsp;' : rgEscapeHtml(ch)
      if (masked && masked.has(i) && !revealed) {
        cls = 'rg-mask'
        content = '■'
      } else if (isCurrent) {
        cls = ''
      } else if (hinted && hinted.has(i)) {
        cls = 'rg-hint-char'
      } else if (i < cur) {
        cls = 'rg-read-char'
      }
      html += cls ? '<span class="' + cls + '">' + content + '</span>' : content
    }
    return html
  }

  _paintUI(d) {
    if (!this.doc || typeof this.doc.getElementById !== 'function') return
    const s = this.state
    const byId = id => this.doc.getElementById(id)
    const title = byId('rg-title')
    if (title) title.textContent = s.sourceTitle || this.title
    const sub = byId('rg-sub')
    if (sub) sub.textContent = t('朗读游戏 · 第 {cur} / {total} 字', { cur: d.cur, total: d.text.length })
    const pill = byId('rg-phase')
    if (pill) {
      pill.className = 'rg-pill ' + d.displayPhase
      pill.textContent = d.phaseText
    }
    const prog = byId('rg-progress')
    if (prog) prog.style.width = d.progress.toFixed(1) + '%'
    const sig = d.cur + ':' + (s.maskedChars || []).join(',') + ':' + (s.hintedChars || []).join(',') + ':' + d.text.length
    if (sig !== this._textSig) {
      this._textSig = sig
      const read = byId('rg-read')
      if (read) read.innerHTML = d.readHtml
      const cur = byId('rg-current')
      if (cur) cur.innerHTML = d.currentHtml
      const todo = byId('rg-todo')
      if (todo) todo.innerHTML = d.afterHtml
    }
    const statMode = byId('rg-stat-mode')
    if (statMode) statMode.textContent = d.modeText
    const statPass = byId('rg-stat-pass')
    if (statPass) statPass.textContent = d.passText
    const statLevel = byId('rg-stat-level')
    if (statLevel) statLevel.textContent = d.levelText
    const statMask = byId('rg-stat-mask')
    if (statMask) statMask.textContent = d.maskText
    const statRate = byId('rg-stat-rate')
    if (statRate) statRate.textContent = d.rateText
    const levelWrap = byId('rg-stat-level-wrap')
    if (levelWrap) levelWrap.hidden = !d.showRecite
    const maskWrap = byId('rg-stat-mask-wrap')
    if (maskWrap) maskWrap.hidden = !d.showRecite
    const rest = byId('rg-rest')
    if (rest) rest.hidden = !d.resting
    if (d.resting) {
      const restCount = byId('rg-rest-count')
      if (restCount) restCount.textContent = String(d.restLeft)
      const restSub = byId('rg-rest-sub')
      if (restSub) restSub.textContent = d.restSub
    }
    const overlay = byId('rg-overlay')
    if (overlay) overlay.innerHTML = d.overlay
    const banners = byId('rg-banners')
    if (banners) {
      banners.innerHTML = d.banners
      banners.hidden = !!d.resting
    }
    // 休息时隐藏上一遍遗留的警告和状态卡片，画面只保留休息面板与文本
    const grid = this.doc.querySelector ? this.doc.querySelector('.rg-grid') : null
    if (grid) grid.hidden = !!d.resting
    const segBox = byId('rg-segments')
    if (segBox) segBox.hidden = !!d.resting
    const level = byId('rg-level')
    if (level) level.innerHTML = Math.round(s.audioLevel) + ' <small>' + t('阈值') + ' ' + Math.round(s.threshold) + '</small>'
    const levelBar = byId('rg-levelbar')
    if (levelBar) levelBar.style.width = d.levelPct.toFixed(1) + '%'
    const thBar = byId('rg-thbar')
    if (thBar) thBar.style.left = d.thPct.toFixed(1) + '%'
    const silence = byId('rg-silence')
    if (silence) silence.textContent = d.silenceText
    const t2 = byId('rg-t2')
    if (t2) {
      t2.className = 'v ' + d.t2Class
      t2.textContent = d.t2Text
    }
    const stt = byId('rg-stt')
    if (stt) {
      stt.className = 'v ' + d.sttClass
      stt.textContent = s.sttStatus
    }
    const shock = byId('rg-shock')
    if (shock) {
      shock.className = 'v ' + (s.isShocking ? 'rg-bad' : '')
      shock.innerHTML = s.shockCount + (s.isShocking ? ' <small>' + t('电击中') + '</small>' : '')
    }
    const segs = byId('rg-segments')
    if (segs) {
      segs.hidden = !!d.resting
      const sig = (s.segments || []).map(x => x.t + x.verdict + x.position).join('|')
      if (sig !== this._segSig) {
        this._segSig = sig
        segs.innerHTML = d.segHtml
      }
    }
    const badge = byId('rg-test-badge')
    if (badge) badge.hidden = !this.testAudioUrl
    const startBtn = byId('rg-start-btn')
    if (startBtn) startBtn.hidden = !!s.isGameActive || this.state.ended
    if (this._lastCur !== d.cur) {
      this._lastCur = d.cur
      this._scrollCurrent()
    }
  }

  _scrollCurrent() {
    if (!this.doc) return
    this.timers.setTimeout(() => {
      try {
        if (!this.doc || typeof this.doc.getElementById !== 'function') return
        const el = this.doc.getElementById('rg-current')
        if (!el) return
        const box = el.closest ? el.closest('.rg-scroll') : null
        if (!box) return
        const top = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2
        box.scrollTop = Math.max(0, top)
      } catch (error) { /* 滚动失败不影响游戏 */ }
    }, 0)
  }

  _showWinPanel(kind) {
    if (!this.doc) return
    const stats = this.doc.getElementById('rg-stats')
    if (stats) stats.hidden = true
    const rest = this.doc.getElementById('rg-rest')
    if (rest) rest.hidden = true
    const main = this.doc.getElementById('rg-main')
    if (main) main.hidden = true
    const win = this.doc.getElementById('rg-win')
    if (win) win.hidden = false
    const start = this.doc.getElementById('rg-start-btn')
    if (start) start.disabled = true
    const label = this.doc.getElementById('rg-win-kind')
    if (label) label.textContent = kind
  }

  renderWin() {
    const s = this.state
    const seconds = Math.max(0, Math.round((Date.now() - s.startTime) / 1000))
    const mm = Math.floor(seconds / 60)
    const ss = seconds % 60
    const timeText = mm > 0 ? t('{m} 分 {s} 秒', { m: mm, s: String(ss).padStart(2, '0') }) : t('{s} 秒', { s: ss })
    this._showWinPanel('win')
    if (!this.doc) return
    const byId = id => this.doc.getElementById(id)
    const title = byId('rg-win-title')
    if (title) {
      title.textContent = s.unconfirmed ? t('已完成')
        : (s.mode === 'recite' ? t('背诵通关') : t('朗读完成'))
      title.style.color = s.unconfirmed ? '#fbbf24' : ''
    }
    const winPill = byId('rg-phase')
    if (winPill) { winPill.className = 'rg-pill won'; winPill.textContent = s.unconfirmed ? t('已完成') : t('已通关') }
    const sub = byId('rg-win-sub')
    if (sub) {
      const done = s.mode === 'recite'
        ? t('第 {n} 级 · 遮字 {pct}%', { n: s.level, pct: Math.round(Number(s.maskRatio) || 0) })
        : t('已完成 {n} 遍朗读', { n: s.completedPasses })
      sub.textContent = t('《{title}》', { title: s.sourceTitle || this.title }) +
        (s.unconfirmed ? t('已读完，但最后一句未能确认（未电击）') : done)
    }
    const time = byId('rg-win-time')
    if (time) time.textContent = timeText
    const timeLabel = byId('rg-win-time-label')
    if (timeLabel) timeLabel.textContent = t('用时')
    const shocks = byId('rg-win-shocks')
    if (shocks) shocks.textContent = String(s.shockCount)
    const shocksLabel = byId('rg-win-shocks-label')
    if (shocksLabel) shocksLabel.textContent = t('受罚次数')
    const passes = byId('rg-win-passes')
    if (passes) passes.textContent = String(s.completedPasses)
    const passesLabel = byId('rg-win-passes-label')
    if (passesLabel) passesLabel.textContent = t('遍数')
    const rate = byId('rg-win-rate')
    if (rate) rate.textContent = s.lastAccuracy == null ? '—' : Math.round(s.lastAccuracy * 100) + '%'
    const rateLabel = byId('rg-win-rate-label')
    if (rateLabel) rateLabel.textContent = t('正确率')
    const syllables = byId('rg-win-syllables')
    if (syllables) syllables.textContent = String(s.totalSyllables || '—')
    const syllablesLabel = byId('rg-win-syllables-label')
    if (syllablesLabel) syllablesLabel.textContent = t('音节数')
  }

  renderStopped() {
    const s = this.state
    this._showWinPanel('stopped')
    if (!this.doc) return
    const byId = id => this.doc.getElementById(id)
    const title = byId('rg-win-title')
    if (title) {
      title.textContent = t('游戏已停止')
      title.style.color = '#f87171'
    }
    const stopPill = byId('rg-phase')
    if (stopPill) { stopPill.className = 'rg-pill stopped'; stopPill.textContent = t('已停止') }
    const sub = byId('rg-win-sub')
    if (sub) sub.textContent = s.sourceTitle || this.title
    const time = byId('rg-win-time')
    if (time) time.textContent = s.position + ' / ' + (s.totalSyllables || '—')
    const timeLabel = byId('rg-win-time-label')
    if (timeLabel) timeLabel.textContent = t('阅读进度（音节）')
    const shocks = byId('rg-win-shocks')
    if (shocks) shocks.textContent = String(s.shockCount)
    const shocksLabel = byId('rg-win-shocks-label')
    if (shocksLabel) shocksLabel.textContent = t('受罚次数')
    const passes = byId('rg-win-passes')
    if (passes) passes.textContent = String(s.completedPasses || 0)
    const passesLabel = byId('rg-win-passes-label')
    if (passesLabel) passesLabel.textContent = t('遍数')
    const rate = byId('rg-win-rate')
    if (rate) rate.textContent = s.lastAccuracy == null ? '—' : Math.round(s.lastAccuracy * 100) + '%'
    const rateLabel = byId('rg-win-rate-label')
    if (rateLabel) rateLabel.textContent = t('正确率')
    const syllables = byId('rg-win-syllables')
    if (syllables) syllables.textContent = String(s.totalSyllables || '—')
    const syllablesLabel = byId('rg-win-syllables-label')
    if (syllablesLabel) syllablesLabel.textContent = t('音节数')
  }

  renderIdle(message) {
    if (!this.doc) return
    const byId = id => this.doc.getElementById(id)
    const picked = this._currentTextChoice()
    this.state.sourceText = picked.text
    this.state.sourceTitle = picked.title
    this.state.phase = 'idle'
    const main = byId('rg-main')
    if (main) main.hidden = false
    const stats = byId('rg-stats')
    if (stats) stats.hidden = false
    const win = byId('rg-win')
    if (win) win.hidden = true
    const start = byId('rg-start-btn')
    if (start) {
      start.disabled = false
      start.textContent = this._mode() === 'recite' ? t('开始背诵') : t('开始朗读')
    }
    const title = byId('rg-title')
    if (title) title.textContent = picked.title
    const mode = this._mode()
    this.state.mode = mode
    this.state.totalPasses = mode === 'read' ? this._passCount() : 0
    this.state.level = mode === 'recite' ? 1 : 0
    this.state.maskRatio = mode === 'recite'
      ? rgMaskRatio(1, this.config.maskStart, this.config.maskStep)
      : 0
    this.state.maskedChars = []
    this.state.hintedChars = []
    this.state.lastAccuracy = null
    this.state.passNumber = 0
    this.state.completedPasses = 0
    this.state.phase = 'idle'
    const sub = byId('rg-sub')
    if (sub) {
      sub.textContent = mode === 'recite'
        ? t('共 {n} 字 · 背诵，从遮字 {pct}% 开始', { n: picked.text.length, pct: this.state.maskRatio })
        : t('共 {n} 字 · 朗读 {passes} 遍', { n: picked.text.length, passes: this._passCount() })
    }
    const pill = byId('rg-phase')
    if (pill) { pill.className = 'rg-pill idle'; pill.textContent = t('待开始') }
    const read = byId('rg-read')
    if (read) read.innerHTML = ''
    const cur = byId('rg-current')
    if (cur) cur.innerHTML = ''
    const todo = byId('rg-todo')
    if (todo) todo.innerHTML = this._renderChars(picked.text, 0, picked.text.length, picked.text.length)
    const statMode = byId('rg-stat-mode')
    if (statMode) statMode.textContent = mode === 'recite' ? t('背诵') : t('朗读')
    const statPass = byId('rg-stat-pass')
    if (statPass) {
      statPass.textContent = mode === 'recite'
        ? t('第 {n} 遍', { n: 1 })
        : t('第 {n}/{total} 遍', { n: 1, total: this.state.totalPasses })
    }
    const statLevel = byId('rg-stat-level')
    if (statLevel) statLevel.textContent = t('第 {n} 级', { n: 1 })
    const statMask = byId('rg-stat-mask')
    if (statMask) statMask.textContent = t('遮字 {pct}%', { pct: Math.round(this.state.maskRatio) })
    const statRate = byId('rg-stat-rate')
    if (statRate) statRate.textContent = '—'
    const levelWrap = byId('rg-stat-level-wrap')
    if (levelWrap) levelWrap.hidden = mode !== 'recite'
    const maskWrap = byId('rg-stat-mask-wrap')
    if (maskWrap) maskWrap.hidden = mode !== 'recite'
    const rest = byId('rg-rest')
    if (rest) rest.hidden = true
    this._textSig = ''
    this._lastCur = -1
    const overlay = byId('rg-overlay')
    if (overlay) overlay.innerHTML = ''
    const banners = byId('rg-banners')
    if (banners) banners.innerHTML = message
      ? '<div class="rg-banner bad">' + rgEscapeHtml(message) + '</div>'
      : '<div class="rg-banner ok">' + t('点击下方「开始朗读」，允许麦克风后保持安静约 3 秒') + '</div>'
    const segs = byId('rg-segments')
    if (segs) segs.innerHTML = ''
    const badge = byId('rg-test-badge')
    if (badge) badge.hidden = !this.testAudioUrl
  }

  async startGame() {
    if (this.started || this.state.isGameActive) return
    const startBtn = this.doc && this.doc.getElementById ? this.doc.getElementById('rg-start-btn') : null
    if (startBtn) startBtn.disabled = true
    this._primeAudioGesture()
    try {
      await this.start(this.deviceManager, this.config)
    } catch (error) {
      this.started = false
      this.state.ended = false
      this.state.won = false
      this.state.isGameActive = false
      this.renderIdle(t('启动失败：{msg}', { msg: error.message }))
    }
  }

  bindStartButton() {
    if (!this.doc || typeof this.doc.getElementById !== 'function') return
    const start = this.doc.getElementById('rg-start-btn')
    if (start && typeof start.addEventListener === 'function') {
      start.addEventListener('click', () => { this.startGame() })
    }
    const stop = this.doc.getElementById('rg-stop-btn')
    if (stop && typeof stop.addEventListener === 'function') {
      stop.addEventListener('click', () => this.emergencyStop())
    }
    const skip = this.doc.getElementById('rg-rest-skip')
    if (skip && typeof skip.addEventListener === 'function') {
      skip.addEventListener('click', () => {
        if (this.state.phase !== 'rest') return
        this.log(t('休息已跳过，立即开始下一遍'), 'info')
        this._startNextPass(Date.now())
      })
    }
  }

  log(message, level) {
    const lv = level || 'info'
    if (this.deviceApi && typeof this.deviceApi.log === 'function') {
      try { this.deviceApi.log(lv, message) } catch (_) {}
    }
    if (this.doc && typeof console !== 'undefined' && console.log) {
      console.log('[READING-' + lv.toUpperCase() + '] ' + message)
    }
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
      const game = new ReadingGame({ window: win, document: doc, deviceApi })
      game.updateParameters(deviceApi && deviceApi.params ? deviceApi.params : {})
      game.testAudioUrl = parseTestAudio(win.location && win.location.search)
      game.bindStartButton()
      game.renderIdle()
      win.__game = game
      win.ReadingGame = ReadingGame
      // 宿主可直接调用：window.__game.startGame() / emergencyStop() / end()
      win.__readingGame = game
    })
  }

  if (globalRoot && globalRoot.document) {
    if (globalRoot.document.readyState === 'loading') {
      globalRoot.document.addEventListener('DOMContentLoaded', () => bootstrap(globalRoot, globalRoot.document))
    } else {
      bootstrap(globalRoot, globalRoot.document)
    }
  }

  return { ReadingGame, parseTestAudio, createShockManager }
})
