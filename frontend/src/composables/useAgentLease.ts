import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface AgentLeaseLimits {
  default: number
  capabilities: Record<string, number>
}

export interface AgentLeaseState {
  clientId: string
  limits: AgentLeaseLimits
  fieldCaps?: Record<string, number>
  expiresAt?: string | null
}

const lease = ref<AgentLeaseState | null>(null)
let source: EventSource | null = null
let pollTimer: number | null = null
let mounted = 0

function toState(row: any): AgentLeaseState | null {
  if (!row || typeof row !== 'object') return null
  const limits = row.limits && typeof row.limits === 'object' ? row.limits : {}
  return {
    clientId: String(row.clientId || ''),
    limits: {
      default: Number(limits.default) || 0,
      capabilities: limits.capabilities && typeof limits.capabilities === 'object'
        ? limits.capabilities
        : {},
    },
    fieldCaps: row.fieldCaps && typeof row.fieldCaps === 'object' ? row.fieldCaps : undefined,
    expiresAt: row.expiresAt || null,
  }
}

async function refresh() {
  try {
    const response = await fetch('/api/agent-control/status')
    if (!response.ok) return
    const body = await response.json()
    const row = Array.isArray(body?.leases) ? body.leases[0] : null
    lease.value = row ? toState(row) : null
  } catch {
    /* 后端未起时静默：标记只是提示 */
  }
}

function handleEvent(event: MessageEvent) {
  let data: any
  try {
    data = JSON.parse(event.data)
  } catch {
    return
  }
  if (data?.type !== 'agent.lease') return
  if (data.action === 'released' || data.action === 'expired') {
    lease.value = null
    return
  }
  lease.value = toState(data)
}

function start() {
  if (!source) {
    source = new EventSource('/api/events/stream?types=agent')
    source.onmessage = handleEvent
  }
  void refresh()
  if (pollTimer == null) {
    // SSE 断线兜底：租约最长 600s，30s 轮询足够让标记自动消失。
    pollTimer = window.setInterval(() => { void refresh() }, 30000)
  }
}

function stop() {
  if (source) {
    source.close()
    source = null
  }
  if (pollTimer != null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
  lease.value = null
}

export function useAgentLease() {
  onMounted(() => {
    mounted += 1
    start()
  })
  onBeforeUnmount(() => {
    mounted -= 1
    if (mounted <= 0) stop()
  })
  return {
    lease: computed(() => lease.value),
    active: computed(() => !!lease.value),
  }
}
