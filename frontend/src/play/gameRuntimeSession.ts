export function runtimeViewMode(mode: string | null | undefined): 'snapshot' | 'iframe' {
  return mode === 'host' ? 'snapshot' : 'iframe'
}

export function isHostRuntime(data: { runtime?: { mode?: string } } | null | undefined): boolean {
  return runtimeViewMode(data?.runtime?.mode) === 'snapshot'
}

export function shouldStopAfterStatusFailure(_failures = 1): boolean {
  return false
}

export function restoreFromStatus(status: { snapshot?: Record<string, unknown> | null } | null | undefined) {
  return status?.snapshot || null
}

export function controlsEnabled(input: {
  authorized: boolean
  running: boolean
  paused?: boolean
  connection: string
}) {
  const live = input.authorized && input.connection === 'live'
  return {
    start: input.authorized && !input.running && input.connection !== 'reconnecting',
    pause: live && input.running && !input.paused,
    resume: live && input.running && !!input.paused,
    stop: live && input.running,
    params: live,
    action: live && input.running && !input.paused,
  }
}
