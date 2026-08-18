export interface VoiceStatus {
  route: 'own_key' | 'panel'
  route_chosen: boolean
  mode: 'direct' | 'relay' | 'none'
  ready: boolean
  has_key: boolean
  key_masked: string
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

export function saveVoiceSettings(body: { route?: 'own_key' | 'panel'; api_key?: string }) {
  return fetch('/api/voice/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(parse)
}
