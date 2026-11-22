export interface VoiceStatus {
  route: 'own_key' | 'panel'
  route_chosen: boolean
  mode: 'direct' | 'relay' | 'none'
  ready: boolean
  has_key: boolean
  key_masked: string
  has_tako_key: boolean
  tako_key_masked: string
  tako_proxy: string
  // 语音识别（游戏用）：自备 SiliconFlow key，或走官方中转（需登录）
  has_sf_key: boolean
  sf_key_masked: string
  stt_mode: 'own_key' | 'relay' | 'none'
  panel_email: string | null
  panel_ok: boolean
  hint: string
  tokenplan_url: string
  invite_code: string
  invite_url: string
}

async function parse(res: Response): Promise<VoiceStatus> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data?.error?.message || res.statusText)
  }
  return data as VoiceStatus
}

export function getVoiceStatus() {
  return fetch('/api/voice/status').then(parse)
}

export function saveVoiceSettings(body: {
  route?: 'own_key' | 'panel'; api_key?: string; tako_api_key?: string; tako_proxy?: string
  siliconflow_api_key?: string
}) {
  return fetch('/api/voice/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(parse)
}
