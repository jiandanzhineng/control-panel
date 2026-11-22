/**
 * 背单词游戏语音输入（Vocabulary Game voice）
 * 手机优先使用宿主 DeviceAPI.speech.commands，持续 KWS 检测固定口令。
 * 未提供 commands 的宿主保留下面的 VAD / 转写兼容路径。
 * 采集链路（VoiceDetector、PcmRingBuffer、重采样、WAV 编码、AudioWorklet）复制自
 * backend/games/reading-game/reading-core.js（朗读游戏，2026-11-01），
 * 兼容路径走宿主 DeviceAPI.speech.transcribe。
 *
 * 与朗读游戏的差异：这里只需要“说一句话”的短口令，VAD 检测到一段语音结束后
 * 切片上传；朗读单词期间及之后 0.5 秒的音频由 game.js 调用 ignoreUntil() 丢弃。
 * 浏览器挂 window.VocabVoice，Node 可直接 require（Node 里只有纯工具函数可用）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.VocabVoice = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  const VG_VOICE_CONST = {
    SAMPLE_RATE: 16000,
    FRAME_MS: 100,
    BAND_LOW_HZ: 300,
    BAND_HIGH_HZ: 3400,
    CALIBRATE_MS: 600,
    ONSET_MS: 120,
    HANGOVER_MS: 320,
    SEGMENT_END_MS: 600,
    // 前置留白：Zipformer 对开头静音敏感。VAD 的 onset 通常在声音开始后才
    // 确认，400ms 扣掉 onset 延迟后只剩几十毫秒，短口令会被吃掉首字；800ms
    // 能留出约 0.4s 静音，手机端实测「第二个」稳定识别。
    SEGMENT_PAD_MS: 800,
    MAX_SEGMENT_MS: 6000,
    MIN_SEGMENT_MS: 260
  }

  // ---------------------------------------------------------------------------
  // 以下来自 reading-core.js：本地 VAD、环形缓冲、重采样、WAV 编码、录音 Worklet
  // ---------------------------------------------------------------------------

  class VoiceDetector {
    constructor(options) {
      const opts = options || {}
      this.calibrateMs = opts.calibrateMs != null ? opts.calibrateMs : VG_VOICE_CONST.CALIBRATE_MS
      this.onsetMs = opts.onsetMs != null ? opts.onsetMs : VG_VOICE_CONST.ONSET_MS
      this.hangoverMs = opts.hangoverMs != null ? opts.hangoverMs : VG_VOICE_CONST.HANGOVER_MS
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
    }

    startCalibration(now) {
      const t = Number(now) || 0
      this.calibrated = false
      this.calibStart = t
      this.levels = []
      this.isVoiced = false
      this.aboveSince = 0
      this.belowSince = 0
      this.zeroSince = 0
      this.lastVoiceAt = t
    }

    _percentile(values, p) {
      if (!values.length) return 0
      const sorted = values.slice().sort((a, b) => a - b)
      const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))))
      return sorted[idx]
    }

    _updateThreshold() {
      this.voiceLevel *= 0.97
      if (this.voiceLevel > this.floor + 10) {
        const span = this.voiceLevel - this.floor
        const candidate = this.floor + Math.max(6, span * 0.3)
        this.threshold = Math.min(this.floor + 45, Math.max(this.floor + 6, candidate))
      } else {
        this.threshold = Math.max(8, Math.min(this.threshold, this.floor + 8))
      }
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
        }
        this.levels.push(loud)
        if (t - this.calibStart >= this.calibrateMs && this.levels.length >= 5) {
          const third = Math.floor(this.levels.length / 3)
          const lows = []
          for (let i = 0; i < 3; i++) {
            const part = this.levels.slice(i * third, i === 2 ? this.levels.length : (i + 1) * third)
            lows.push(this._percentile(part, 0.2))
          }
          this.floor = Math.min.apply(null, lows)
          this.threshold = Math.max(12, Math.min(this.floor + 8, 30))
          this.calibrated = true
          this.lastVoiceAt = t
          this.justCalibrated = true
        }
        return {
          voiced: false,
          calibrating: !this.calibrated,
          justCalibrated: this.justCalibrated,
          threshold: this.threshold,
          floor: this.floor,
          lastVoiceAt: this.lastVoiceAt,
          micAbnormal: false
        }
      }
      if (loud < this.floor) this.floor = this.floor * 0.98 + loud * 0.02
      if (loud > this.floor + 10) this.voiceLevel = Math.max(this.voiceLevel, loud)
      this._updateThreshold()
      const above = loud >= this.threshold
      if (above) {
        this.belowSince = 0
        if (!this.aboveSince) this.aboveSince = t
        if (!this.isVoiced && t - this.aboveSince >= this.onsetMs) this.isVoiced = true
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
      let micAbnormal = false
      if (peakValue < 0.00001) {
        if (!this.zeroSince) this.zeroSince = t
        else if (t - this.zeroSince >= 2000) micAbnormal = true
      } else {
        this.zeroSince = 0
      }
      return {
        voiced: this.isVoiced,
        calibrating: false,
        justCalibrated: false,
        threshold: this.threshold,
        floor: this.floor,
        lastVoiceAt: this.lastVoiceAt,
        micAbnormal: micAbnormal
      }
    }
  }

  class PcmRingBuffer {
    constructor(seconds, sampleRate) {
      this.sampleRate = sampleRate || VG_VOICE_CONST.SAMPLE_RATE
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
      const v = Math.max(-1, Math.min(1, samples[i]))
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      offset += 2
    }
    return new Uint8Array(buffer)
  }

  function rgWorkletCode() {
    return `
class VGRecorder extends AudioWorkletProcessor {
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
registerProcessor('vg-recorder', VGRecorder)
`
  }

  function rgbBytesToBase64(bytes) {
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

  // URL ?vgTestAudio=<同目录相对路径或 http URL>：用音频文件代替麦克风（自动化测试）。
  function parseTestAudio(search) {
    try {
      const params = new URLSearchParams(search || '')
      const raw = params.get('vgTestAudio')
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

  function parseTestAudioFromLocation(location) {
    return parseTestAudio(location && location.search)
  }

  function defaultTimers() {
    return {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: id => clearInterval(id),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: id => clearTimeout(id)
    }
  }

  /**
   * 麦克风/测试音频 → VAD → 切片 → DeviceAPI.speech.transcribe。
   * onResult({ text, seq })：seq 是开始录音时的题目序号，game.js 用它丢弃过期结果。
   * onStatus('listening'|'recognizing'|'error')；onError(err) 只用于日志/提示。
   */
  class VoiceCommandListener {
    constructor(options) {
      const opts = options || {}
      this.env = opts.window || (typeof window !== 'undefined' ? window : null)
      this.media = opts.media || null
      this.deviceApi = opts.deviceApi || (this.env && this.env.DeviceAPI) || null
      this.speech = opts.speech !== undefined
        ? opts.speech
        : (this.deviceApi && this.deviceApi.speech) || null
      this.commands = this.speech && this.speech.commands
      this.commandGen = 0
      this.timers = opts.timers || defaultTimers()
      this.fetchFn = opts.fetch || (this.env && typeof this.env.fetch === 'function' ? this.env.fetch.bind(this.env) : null)
      this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
      this.testAudioUrl = opts.testAudioUrl || parseTestAudioFromLocation(this.env && this.env.location)
      this.onResult = typeof opts.onResult === 'function' ? opts.onResult : function () {}
      this.onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : function () {}
      this.onError = typeof opts.onError === 'function' ? opts.onError : function () {}
      this.running = false
      this.seq = 0
      this.blockedUntil = 0
      this.audioContext = null
      this.stream = null
      this.micPromise = null
      this.micError = null
      this.micGen = 0
      this.sourceNode = null
      this.analyser = null
      this.workletNode = null
      this.scriptNode = null
      this.muteNode = null
      this.testAudioNode = null
      this.testAudioBuffer = null
      this.ringBuffer = null
      this.detector = null
      this.freqData = null
      this.timeData = null
      this.audioStartTime = 0
      this.tickTimer = null
      this.segStartedAt = 0
      this.segSeq = 0
      this.lastVoiceAt = 0
      this.inFlight = false
      this.pendingSegment = null
      this.micWarned = false
    }

    _updateCommands() {
      if (!this.commands || !this.running) return
      this.commands.update({ generation: this.commandGen, seq: this.seq, blockedUntil: this.blockedUntil })
    }

    setSeq(seq) {
      this.seq = Number(seq) || 0
      this.pendingSegment = null
      // 换题时丢掉正在采集的语音：这段音频属于上一题，切片晚于换题时不能再算到新题上。
      this.segStartedAt = 0
      this.segSeq = 0
      this.lastVoiceAt = 0
      this._updateCommands()
    }

    // 朗读单词期间（以及结束后 0.5 秒）丢弃音频，防止识别到游戏的发音。
    ignoreUntil(timestamp) {
      const until = Number(timestamp) || 0
      if (until > this.blockedUntil) this.blockedUntil = until
      this.segStartedAt = 0
      this.lastVoiceAt = 0
      this._updateCommands()
    }

    // 必须在用户手势里同步调用（iOS / Android WebView 限制）。
    prime() {
      if (this.commands) return
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

    // 在同一个用户手势里尽早申请麦克风；start() 会复用这次请求。
    primeMic() {
      if (this.commands) return Promise.resolve(null)
      if (this.testAudioUrl) return Promise.resolve(null)
      if (this.micPromise) return this.micPromise
      const nav = (this.env && this.env.navigator) || (typeof navigator !== 'undefined' ? navigator : null)
      if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
        const error = new Error('MIC_UNAVAILABLE')
        error.code = 'MIC_UNAVAILABLE'
        this.micError = error
        return Promise.resolve(null)
      }
      this.micError = null
      const gen = this.micGen
      this.micPromise = nav.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      }).then(stream => {
        if (gen !== this.micGen) {
          stream.getTracks().forEach(track => track.stop())
          return null
        }
        this.stream = stream
        return stream
      }).catch(error => {
        if (gen === this.micGen) this.micError = error || new Error('MIC_UNAVAILABLE')
        return null
      })
      return this.micPromise
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

    async start() {
      if (this.running) return true
      if (this.commands) {
        const gen = ++this.commandGen
        this.running = true
        try {
          const result = await this.commands.start({ generation: gen, seq: this.seq, blockedUntil: this.blockedUntil }, event => {
            if (!this.running || gen !== this.commandGen || !event || event.generation !== gen) return
            if (event.code) {
              this._emitStatus('command-error', event.code)
              return
            }
            if (event.seq !== this.seq || this.now() < this.blockedUntil) return
            this.onResult({ text: event.text, command: event.command, seq: event.seq, mode: 'kws' })
          })
          if (gen !== this.commandGen || !this.running) return false
          if (!result || !result.ready) throw new Error('NO_KWS')
          this._emitStatus('listening')
          return true
        } catch (error) {
          if (gen === this.commandGen) {
            this.running = false
            Promise.resolve(this.commands.stop(gen)).catch(() => {})
          }
          throw error
        }
      }
      if (!this.speech || typeof this.speech.transcribe !== 'function') {
        const error = new Error('NO_STT')
        error.code = 'NO_STT'
        throw error
      }
      const Ctx = this._audioCtor()
      if (!Ctx) {
        const error = new Error('NO_AUDIO')
        error.code = 'NO_AUDIO'
        throw error
      }
      if (!this.audioContext) this.audioContext = new Ctx()
      if (this.audioContext.state === 'suspended') {
        try { await this.audioContext.resume() } catch (_) {}
      }
      const rate = this.audioContext.sampleRate || VG_VOICE_CONST.SAMPLE_RATE
      this.ringBuffer = new PcmRingBuffer(12, rate)
      this.detector = new VoiceDetector({ calibrateMs: VG_VOICE_CONST.CALIBRATE_MS })
      this.analyser = this.audioContext.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyser.smoothingTimeConstant = 0.3
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount)
      this.timeData = new Float32Array(this.analyser.fftSize)
      this.segStartedAt = 0
      this.segSeq = 0
      this.lastVoiceAt = 0
      this.micWarned = false
      this.audioStartTime = this.now()
      if (this.testAudioUrl) await this._startTestAudio()
      else await this._startMic()
      this.running = true
      this.detector.startCalibration(this.now())
      this.tickTimer = this.timers.setInterval(() => this._tick(), VG_VOICE_CONST.FRAME_MS)
      this._emitStatus('listening')
      return true
    }

    async _startMic() {
      // 复用点击时 primeMic 申请的流，避免同一手机同时打开两路录音。
      this.stream = await this.primeMic()
      if (!this.stream) throw this.micError || new Error('MIC_UNAVAILABLE')
      const track = this.stream.getAudioTracks()[0]
      if (track) {
        track.onended = () => this._emitStatus('mic-error')
        track.onmute = () => this._emitStatus('mic-error')
      }
      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream)
      this.sourceNode.connect(this.analyser)
      await this._connectRecorder()
    }

    async _startTestAudio() {
      const fetchFn = this.fetchFn || (this.env && this.env.fetch)
      if (!fetchFn) {
        const error = new Error('TEST_AUDIO_UNAVAILABLE')
        error.code = 'TEST_AUDIO_UNAVAILABLE'
        throw error
      }
      const res = await fetchFn(this.testAudioUrl)
      if (!res || res.ok === false) {
        const error = new Error('TEST_AUDIO_LOAD_FAILED')
        error.code = 'TEST_AUDIO_LOAD_FAILED'
        throw error
      }
      const buffer = await res.arrayBuffer()
      const decoded = await new Promise((resolve, reject) => {
        try { this.audioContext.decodeAudioData(buffer, resolve, reject) } catch (error) { reject(error) }
      })
      this.testAudioBuffer = decoded
      const source = this.audioContext.createBufferSource()
      source.buffer = decoded
      source.connect(this.analyser)
      this.sourceNode = source
      await this._connectRecorder()
      source.start(this.audioContext.currentTime + 0.02)
      this.testAudioNode = source
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
          } catch (_) {
            loaded = false
          } finally {
            try { URLObj.revokeObjectURL(blobUrl) } catch (_) {}
          }
        }
        if (loaded) {
          const node = new WorkletNode(ctx, 'vg-recorder')
          node.port.onmessage = event => {
            if (this.ringBuffer && event.data) this.ringBuffer.push(event.data)
          }
          this.sourceNode.connect(node)
          node.connect(mute)
          this.workletNode = node
          return
        }
      }
      const node = ctx.createScriptProcessor(4096, 1, 1)
      node.onaudioprocess = event => {
        if (!this.ringBuffer || !event || !event.inputBuffer) return
        this.ringBuffer.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      }
      this.sourceNode.connect(node)
      node.connect(mute)
      this.scriptNode = node
    }

    _measure() {
      const rate = (this.audioContext && this.audioContext.sampleRate) || VG_VOICE_CONST.SAMPLE_RATE
      const binHz = rate / this.analyser.fftSize
      const low = Math.max(0, Math.ceil(VG_VOICE_CONST.BAND_LOW_HZ / binHz))
      const high = Math.min(this.freqData.length - 1, Math.floor(VG_VOICE_CONST.BAND_HIGH_HZ / binHz))
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
      return { level: level, peak: peak }
    }

    _tick() {
      if (!this.running || !this.analyser || !this.detector) return
      const now = this.now()
      this.analyser.getByteFrequencyData(this.freqData)
      this.analyser.getFloatTimeDomainData(this.timeData)
      const measured = this._measure()
      const info = this.detector.process(measured.level, now, measured.peak)
      if (now < this.blockedUntil) {
        // 单词朗读期间及之后 0.5 秒：整段丢弃，不切片；但底噪校准照常进行。
        this.segStartedAt = 0
        this.lastVoiceAt = 0
        this.detector.isVoiced = false
        this.detector.aboveSince = 0
        this.detector.belowSince = 0
        this.detector.lastVoiceAt = now
        return
      }
      if (info.calibrating) return
      if (info.micAbnormal && !this.testAudioUrl && !this.micWarned) {
        this.micWarned = true
        this._emitStatus('mic-error')
      } else if (!info.micAbnormal) {
        this.micWarned = false
      }
      if (info.voiced) {
        if (!this.segStartedAt) {
          this.segStartedAt = Math.max(now - 100, this.blockedUntil)
          // 序号在“开始采集”时确定：切片可能晚于换题，不能按切片时的题号归属。
          this.segSeq = this.seq
        }
        this.lastVoiceAt = now
        if (now - this.segStartedAt >= VG_VOICE_CONST.MAX_SEGMENT_MS) this._flush(now)
        return
      }
      if (this.segStartedAt && now - this.lastVoiceAt >= VG_VOICE_CONST.SEGMENT_END_MS) {
        this._flush(this.lastVoiceAt + 150)
      }
    }

    _flush(endAt) {
      const ctx = this.audioContext
      const rb = this.ringBuffer
      if (!ctx || !rb || !this.segStartedAt || !this.running) return
      const rate = ctx.sampleRate || VG_VOICE_CONST.SAMPLE_RATE
      const startAt = Math.max(this.blockedUntil, this.segStartedAt - VG_VOICE_CONST.SEGMENT_PAD_MS)
      const end = Math.min(Number(endAt) || 0, this.lastVoiceAt + 250)
      const segmentSeq = this.segSeq
      this.segStartedAt = 0
      this.segSeq = 0
      this.lastVoiceAt = 0
      if (end - startAt < VG_VOICE_CONST.MIN_SEGMENT_MS) return
      const startSample = Math.max(0, Math.round((startAt - this.audioStartTime) * rate / 1000))
      const endSample = Math.min(rb.total, Math.round((end - this.audioStartTime) * rate / 1000))
      const raw = rb.getRange(startSample, endSample)
      if (!raw || raw.length * 1000 / rate < VG_VOICE_CONST.MIN_SEGMENT_MS) return
      const samples = rgResample(raw, rate, VG_VOICE_CONST.SAMPLE_RATE)
      const wav = rgEncodeWav(samples, VG_VOICE_CONST.SAMPLE_RATE)
      const segment = {
        audio: rgbBytesToBase64(wav),
        format: 'wav',
        timeoutMs: 10000,
        seq: segmentSeq
      }
      if (this.inFlight) {
        this.pendingSegment = segment
        return
      }
      this._transcribe(segment)
    }

    _transcribe(segment) {
      if (!this.speech || typeof this.speech.transcribe !== 'function') {
        this._emitStatus('error', 'NO_STT')
        return
      }
      this.inFlight = true
      this._emitStatus('recognizing')
      Promise.resolve()
        .then(() => this.speech.transcribe({
          audio: segment.audio,
          format: 'wav',
          timeoutMs: segment.timeoutMs
        }))
        .then(res => {
          if (!this.running || segment.seq !== this.seq) return
          const text = String((res && res.text) || '').trim()
          this.onResult({ text: text, seq: segment.seq })
        })
        .catch(error => {
          if (!this.running || segment.seq !== this.seq) return
          this.onError(error)
        })
        .finally(() => {
          this.inFlight = false
          if (!this.running) return
          this._emitStatus('listening')
          const next = this.pendingSegment
          this.pendingSegment = null
          if (next && next.seq === this.seq) this._transcribe(next)
        })
    }

    _emitStatus(status, detail) {
      try { this.onStatus(status, detail) } catch (_) {}
    }

    async stop() {
      this.running = false
      const gen = this.commandGen++
      if (this.commands) {
        try { await this.commands.stop(gen) } catch (_) {}
      }
      this.micGen += 1
      this.micPromise = null
      this.micError = null
      if (this.tickTimer) {
        this.timers.clearInterval(this.tickTimer)
        this.tickTimer = null
      }
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
        if (this.audioContext && this.audioContext.state !== 'closed') await this.audioContext.close()
      } catch (_) {}
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
      this.segStartedAt = 0
      this.segSeq = 0
      this.lastVoiceAt = 0
      this.pendingSegment = null
      this.inFlight = false
      this._emitStatus('off')
    }
  }

  return {
    VG_VOICE_CONST: VG_VOICE_CONST,
    VoiceDetector: VoiceDetector,
    PcmRingBuffer: PcmRingBuffer,
    rgResample: rgResample,
    rgEncodeWav: rgEncodeWav,
    rgWorkletCode: rgWorkletCode,
    rgbBytesToBase64: rgbBytesToBase64,
    parseTestAudio: parseTestAudio,
    parseTestAudioFromLocation: parseTestAudioFromLocation,
    VoiceCommandListener: VoiceCommandListener
  }
})
