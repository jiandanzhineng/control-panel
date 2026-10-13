// 「语音开始」的纯逻辑部分（可单测，不碰浏览器 API）。

/** 前端固定展示的默认麦克风选项（enumerateDevices 只返回真实设备）。 */
export const DEFAULT_MIC_ID = 'default'

export interface MicOption {
  id: string
  label: string
}

/** 麦克风列表：始终带上「系统默认」在最前，后面接真实设备（按 id 去重）。 */
export function buildMicOptions(devices: Array<{ deviceId?: string; kind?: string; label?: string }> | null | undefined, defaultLabel: string): MicOption[] {
  const list: MicOption[] = [{ id: DEFAULT_MIC_ID, label: defaultLabel }]
  const seen = new Set<string>([DEFAULT_MIC_ID])
  for (const device of devices || []) {
    if (!device || device.kind !== 'audioinput') continue
    const id = String(device.deviceId || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = String(device.label || '').trim()
    list.push({ id, label: label || `麦克风 ${list.length}` })
  }
  return list
}

/** 保存的麦克风还在不在（拔掉/换机器后回退到系统默认）。 */
export function resolveMicId(saved: string | null | undefined, options: MicOption[]): string {
  const id = String(saved || '')
  if (id && options.some((option) => option.id === id)) return id
  return DEFAULT_MIC_ID
}

/** 该麦克风是否要显式传给 getUserMedia（系统默认交给浏览器挑）。 */
export function micConstraintsFor(micId: string): MediaTrackConstraints {
  const id = String(micId || '')
  if (!id || id === DEFAULT_MIC_ID) return {}
  return { deviceId: { exact: id } }
}

/** 语音触发 WS 地址：跟随页面 origin（dev 走 vite 代理，打包走 Electron 的 5277 代理）。 */
export function buildVoiceTriggerUrl(origin: string, phraseId: string): string {
  const base = String(origin || '').replace(/^http/, 'ws')
  return `${base}/voice-trigger?phrase=${encodeURIComponent(String(phraseId || ''))}`
}

/** 一帧 PCM 的响度（0~1，供音量条用）。RMS 开方后按 0.25 归一，日常说话约 0.2~0.6。 */
export function frameLevel(samples: Float32Array): number {
  if (!samples || samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / samples.length)
  return Math.max(0, Math.min(1, rms / 0.25))
}

/** 音量条平滑：新帧权重更高，避免闪跳。 */
export function smoothLevel(previous: number, next: number, weight = 0.35): number {
  const prev = Number.isFinite(previous) ? previous : 0
  const value = Number.isFinite(next) ? next : 0
  return prev * (1 - weight) + value * weight
}

/** 后端/浏览器错误 → 中文提示用的 i18n key。 */
export function voiceErrorKey(code: string | null | undefined): string {
  switch (String(code || '')) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'playConfig.voiceMicDenied'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'playConfig.voiceMicMissing'
    case 'NotReadableError':
    case 'AbortError':
      return 'playConfig.voiceMicBusy'
    case 'MODEL_UNAVAILABLE':
      return 'playConfig.voiceModelMissing'
    case 'REMOTE_LOCKED':
      return 'remoteSession.lock.menu'
    case 'TIMEOUT':
      return 'playConfig.voiceTimeout'
    default:
      return 'playConfig.voiceFailed'
  }
}

/** 把 AudioWorklet 处理器源码内联成 Blob URL，避免 file:// 下加载独立模块失败。 */
export function audioWorkletSource(): string {
  return `
class VoiceStartCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}
registerProcessor('voice-start-capture', VoiceStartCapture);
`
}
