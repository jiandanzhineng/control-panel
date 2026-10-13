// 「语音开始」的麦克风采集与识别：列麦克风、按口令监听、实时音量。
//
// 采集链路：getUserMedia(指定 deviceId) → AudioContext(16000) → AudioWorklet
// （源码用 Blob URL 内联，避免 file:// 下加载独立模块）→ 单声道 Float32 帧经
// WebSocket 以二进制发到后端 /voice-trigger。后端只认固定口令。
import {
  DEFAULT_MIC_ID,
  audioWorkletSource,
  buildMicOptions,
  buildVoiceTriggerUrl,
  frameLevel,
  micConstraintsFor,
  smoothLevel,
  type MicOption,
} from '../play/voiceStart'

export { DEFAULT_MIC_ID }
export type { MicOption }

export interface VoicePhrase {
  id: string
  label: string
  default: boolean
}

export interface ListenVoiceOptions {
  phraseId: string
  micDeviceId: string
  onDetected: (phrase: { id: string; label: string }) => void
  onLevel?: (level: number) => void
  onError?: (error: Error & { code?: string }) => void
  onTimeout?: () => void
  timeoutMs?: number
}

function makeError(message: string, code?: string) {
  const error = new Error(message) as Error & { code?: string }
  if (code) error.code = code
  return error
}

/** 麦克风列表：先申请一次权限，enumerateDevices 才会给出带名称的设备。 */
export async function listMicrophones(defaultLabel: string): Promise<MicOption[]> {
  if (!navigator?.mediaDevices?.getUserMedia) return buildMicOptions([], defaultLabel)
  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (error: any) {
    throw makeError(error?.message || '无法访问麦克风', error?.name)
  } finally {
    stream?.getTracks().forEach((track) => track.stop())
  }
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  return buildMicOptions(devices as any, defaultLabel)
}

/** 拉取后端固定的口令目录（唯一事实来源）。 */
export async function fetchVoicePhrases(): Promise<VoicePhrase[]> {
  const res = await fetch('/api/voice/phrases')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw makeError(data?.error?.message || '获取口令列表失败')
  return Array.isArray(data?.phrases) ? data.phrases : []
}

/**
 * 按口令监听：返回关闭函数（幂等，彻底释放 track / AudioContext / WebSocket）。
 * 识别到口令、超时、出错都会自动关闭。
 */
export function listenVoicePhrase(options: ListenVoiceOptions): () => void {
  const {
    phraseId,
    micDeviceId = DEFAULT_MIC_ID,
    onDetected,
    onLevel,
    onError,
    onTimeout,
    timeoutMs,
  } = options

  let closed = false
  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let node: AudioWorkletNode | null = null
  let ws: WebSocket | null = null
  let timer = 0
  let level = 0

  function cleanup() {
    if (closed) return
    closed = true
    if (timer) window.clearTimeout(timer)
    timer = 0
    try { node?.port.close() } catch (_) {}
    try { node?.disconnect() } catch (_) {}
    try { source?.disconnect() } catch (_) {}
    try { stream?.getTracks().forEach((track) => track.stop()) } catch (_) {}
    try { if (context && context.state !== 'closed') void context.close() } catch (_) {}
    node = null
    source = null
    context = null
    stream = null
    try {
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) ws.close()
    } catch (_) {}
    ws = null
  }

  function fail(error: Error & { code?: string }) {
    if (closed) return
    onError?.(error)
    cleanup()
  }

  if (timeoutMs && timeoutMs > 0) {
    timer = window.setTimeout(() => {
      if (closed) return
      onTimeout?.()
      cleanup()
    }, timeoutMs)
  }

  void (async () => {
    if (!navigator?.mediaDevices?.getUserMedia) {
      fail(makeError('当前环境不支持麦克风', 'NotSupportedError'))
      return
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraintsFor(micDeviceId) })
    } catch (error: any) {
      fail(makeError(error?.message || '无法访问麦克风', error?.name))
      return
    }
    if (closed) { cleanup(); return }

    try {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext
      context = new Ctor({ sampleRate: 16000 })
      const blobUrl = URL.createObjectURL(new Blob([audioWorkletSource()], { type: 'application/javascript' }))
      try {
        await context.audioWorklet.addModule(blobUrl)
      } finally {
        URL.revokeObjectURL(blobUrl)
      }
      if (closed) { cleanup(); return }
      source = context.createMediaStreamSource(stream)
      node = new AudioWorkletNode(context, 'voice-start-capture')
    } catch (error: any) {
      fail(makeError(error?.message || '音频采集初始化失败', 'AudioWorkletError'))
      return
    }

    try {
      ws = new WebSocket(buildVoiceTriggerUrl(window.location.origin, phraseId))
    } catch (error: any) {
      fail(makeError(error?.message || '无法连接语音识别服务', 'WebSocketError'))
      return
    }
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (event) => {
      if (closed) return
      let data: any = null
      try { data = JSON.parse(String(event.data || '{}')) } catch (_) { return }
      if (data?.type === 'detected') {
        onDetected({ id: String(data.phraseId || ''), label: String(data.phrase || '') })
        cleanup()
      } else if (data?.type === 'error') {
        fail(makeError(data?.message || '语音识别失败', data?.code))
      }
    }
    ws.onerror = () => {
      fail(makeError('无法连接语音识别服务', 'WebSocketError'))
    }
    ws.onclose = () => {
      if (closed) return
      // 服务端主动关闭（识别到/超时）时 onmessage 已处理；这里只兜底异常断开
      fail(makeError('语音识别连接已断开', 'WebSocketClosed'))
    }
    ws.onopen = () => {
      if (closed || !node) return
      node.port.onmessage = (event: MessageEvent) => {
        if (closed || !ws || ws.readyState !== 1) return
        const samples = event.data as Float32Array
        if (!(samples instanceof Float32Array) || samples.length === 0) return
        ws.send(samples)
        if (onLevel) {
          level = smoothLevel(level, frameLevel(samples))
          onLevel(level)
        }
      }
      try {
        source!.connect(node!)
        // 不接扬声器：Worklet 只在有下游时才会被调度，接一个零增益节点保持静默。
        const silent = context!.createGain()
        silent.gain.value = 0
        node!.connect(silent)
        silent.connect(context!.destination)
      } catch (error: any) {
        fail(makeError(error?.message || '音频采集初始化失败', 'AudioWorkletError'))
      }
    }
  })()

  return cleanup
}
