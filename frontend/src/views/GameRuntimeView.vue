<template>
  <div class="runtime" :class="{ embedded, remote: source === 'remote' }">
    <div class="game-shell">
      <el-alert v-if="connection === 'reconnecting'" class="runtime-alert" type="warning" :closable="false" :title="t('gameRuntime.reconnecting')" show-icon />
      <el-alert v-if="source === 'remote' && !authorized" class="runtime-alert" type="info" :closable="false" :title="t('gameRuntime.waitAuth')" show-icon />

      <div v-if="waiting" class="wait-card">
        <span class="eyebrow">{{ t('gameRuntime.title') }}</span>
        <h2>{{ t('gameRuntime.waitingButton') }}</h2>
        <p>{{ t('gameRuntime.startNow') }}</p>
        <el-button type="primary" @click="beginDeferred">{{ t('gameRuntime.startNow') }}</el-button>
      </div>

      <template v-else-if="view">
        <header class="game-header">
          <div class="title-block">
            <span class="eyebrow">{{ source === 'remote' ? t('remoteGame.title') : t('gameRuntime.title') }}</span>
            <h1>{{ view.title || t('gameRuntime.title') }}</h1>
            <p v-if="view.startedAtMs" class="started-at">{{ formatStartedAt(view.startedAtMs) }}</p>
          </div>
          <div class="status-stack">
            <span class="status-badge" :class="statusClass">{{ statusText }}</span>
            <span v-if="source === 'remote'" class="remote-mark">{{ t('remoteGame.authorized') }}</span>
          </div>
        </header>

        <section class="game-card metric-card">
          <div class="metric-grid">
            <div class="metric">
              <div class="metric-label">{{ t('gameRuntime.pressure') }} <span>({{ t('gameRuntime.average') }}: {{ formatNumber(view.averagePressure) }})</span></div>
              <strong class="metric-value">{{ formatNumber(view.currentPressure) }}</strong>
              <div class="progress"><span class="pressure-progress" :style="{ width: pressurePercent + '%' }" /></div>
            </div>
            <div class="metric">
              <div class="metric-label">{{ t('gameRuntime.intensity') }} <span>({{ t('gameRuntime.target') }}: {{ formatNumber(view.targetIntensity) }})</span></div>
              <strong class="metric-value">{{ formatNumber(view.currentIntensity) }}</strong>
              <div class="progress"><span class="intensity-progress" :style="{ width: intensityPercent + '%' }" /></div>
            </div>
          </div>
        </section>

        <section class="game-card action-card">
          <div class="action-grid">
            <button class="game-button primary" :disabled="!controls.pause && !controls.resume" @click="send(view.paused ? 'resume' : 'pause')">
              {{ view.paused ? t('gameRuntime.resume') : t('gameRuntime.pause') }}
            </button>
            <button class="game-button" :disabled="!controls.action" @click="send('addIntensity', { delta: 10 })">+10 {{ t('gameRuntime.intensity') }}</button>
            <button class="game-button danger" :disabled="!controls.action" @click="send('shockOnce')">⚡ {{ t('gameRuntime.shock') }}</button>
            <button class="game-button secondary" :disabled="!controls.action" @click="send('forceEdge')">{{ t('gameRuntime.forceEdge') }}</button>
          </div>
          <button class="stop-button" :disabled="!controls.stop" @click="stop">{{ t('gameRuntime.stop') }}</button>
        </section>

        <section class="game-card chart-card">
          <div class="stat-row threshold-stats">
            <span>{{ t('gameRuntime.mid') }}: <b>{{ formatNumber(view.midPressure) }}</b></span>
            <span v-if="isPressureV2">{{ t('remoteGame.criticalPressure') }}: <b>{{ formatNumber(criticalPressure) }}</b></span>
            <span v-else>{{ t('gameRuntime.edgePeak') }}: <b>{{ formatNumber(view.edgePeak) }}</b></span>
            <span v-if="!isPressureV2">{{ t('gameRuntime.lastEdgePeak') }}: <b>{{ formatNumber(view.lastEdgePeak) }}</b></span>
          </div>
          <canvas ref="chartRef" class="chart" aria-label="pressure chart" />
          <div class="adjust-row" v-if="isPressureV2">
            <div class="adjust-group">
              <span>{{ t('gameRuntime.mid') }}</span>
              <button class="small-button" :disabled="!controls.action" @click="send('adjustThreshold', { which: 'mid', delta: -0.1 })">−</button>
              <button class="small-button" :disabled="!controls.action" @click="send('adjustThreshold', { which: 'mid', delta: 0.1 })">+</button>
            </div>
            <div class="adjust-group">
              <span>{{ t('remoteGame.criticalPressure') }}</span>
              <button class="small-button" :disabled="!controls.action" @click="send('adjustThreshold', { which: 'crit', delta: -0.1 })">−</button>
              <button class="small-button" :disabled="!controls.action" @click="send('adjustThreshold', { which: 'crit', delta: 0.1 })">+</button>
            </div>
            <span class="chart-hint">{{ t('gameRuntime.thresholdHint') }}</span>
          </div>
          <div v-else class="chart-hint">{{ t('gameRuntime.surgeHint') }}</div>
        </section>

        <section class="game-card stats-card">
          <div class="stat-row">
            <span>{{ t('gameRuntime.edges') }}: <b>{{ view.edgingCount ?? 0 }}</b></span>
            <span>{{ t('gameRuntime.shocks') }}: <b>{{ view.shockCount ?? 0 }}</b></span>
            <span>{{ t('gameRuntime.stim') }}: <b>{{ formatNumber(view.totalStimulationTime) }}s</b></span>
          </div>
          <ul class="logs">
            <li v-for="(entry, index) in view.logs || []" :key="`${entry.atMs || 0}-${index}`">
              <span class="log-dot" :class="`log-${entry.level || 'info'}`" />
              <span>{{ entry.message }}</span>
            </li>
            <li v-if="!(view.logs || []).length" class="empty-log">{{ t('gameRuntime.noLogs') }}</li>
          </ul>
        </section>

        <details v-if="schema.length" class="game-card runtime-config" :open="source === 'remote'">
          <summary>{{ t('gameRuntime.params') }}<span>{{ t('gameRuntime.paramsHint') }}</span></summary>
          <PlayParamsForm :params="schema" :model="draft" :disabled="!controls.params" :submit-text="t('gameRuntime.saveParams')" @submit="submitParams" />
        </details>
      </template>

      <el-empty v-else class="empty-state" :description="t('gameRuntime.empty')" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import PlayParamsForm from '../components/PlayParamsForm.vue'
import { clearActivePlay, setActivePlay } from '../composables/useActivePlay'
import { listenDeviceButtonPress } from '../composables/useButtonStart'
import {
  getGameRuntimeStatus,
  listHostGames,
  sendGameRuntimeAction,
  setGameRuntimeParams,
  startGameRuntime,
  stopGameRuntime,
  type GameRuntimeSnapshot,
} from '../api/gameRuntime'
import { controlsEnabled, restoreFromStatus, shouldStopAfterStatusFailure, syncParamsDraft } from '../play/gameRuntimeSession'

const props = withDefaults(defineProps<{
  source?: 'local' | 'remote'
  snapshot?: GameRuntimeSnapshot | null
  authorized?: boolean
  connection?: 'live' | 'reconnecting' | 'idle'
  paramsSchema?: Array<Record<string, any>>
  embedded?: boolean
  navigateOnEnd?: boolean
}>(), {
  source: 'local',
  snapshot: null,
  authorized: true,
  connection: 'live',
  paramsSchema: () => [],
  embedded: false,
  navigateOnEnd: true,
})

const emit = defineEmits<{
  action: [name: string, payload?: unknown]
  params: [value: Record<string, unknown>]
  stop: []
}>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const localSnapshot = ref<GameRuntimeSnapshot | null>(null)
const localConnection = ref<'live' | 'reconnecting' | 'idle'>('idle')
const schema = ref<Array<Record<string, any>>>([])
const draft = reactive<Record<string, any>>({})
const waiting = ref(false)
const chartRef = ref<HTMLCanvasElement | null>(null)
const history = ref<Array<{ pressure: number; intensity: number }>>([])
let pollTimer: ReturnType<typeof setInterval> | null = null
let stopWait: (() => void) | null = null
let failures = 0
let lastParams: Record<string, unknown> = {}
let lastGameId = ''
let resizeObserver: ResizeObserver | null = null

const view = computed(() => props.source === 'remote' ? props.snapshot : localSnapshot.value)
const connection = computed(() => props.source === 'remote' ? props.connection : localConnection.value)
const controls = computed(() => controlsEnabled({
  authorized: props.authorized,
  running: !!view.value?.running,
  paused: !!view.value?.paused,
  connection: connection.value,
}))
const isPressureV2 = computed(() => view.value?.gameId === 'pressure-edging-v2')
const criticalPressure = computed(() => Number(view.value?.criticalPressure ?? view.value?.params?.criticalPressure ?? 20))
const intensityMax = computed(() => Math.max(1, Number(view.value?.params?.maxMotorIntensity ?? 100)))
const pressurePercent = computed(() => Math.max(0, Math.min(100, (Number(view.value?.currentPressure) || 0) / Math.max(1, criticalPressure.value) * 100)))
const intensityPercent = computed(() => Math.max(0, Math.min(100, (Number(view.value?.currentIntensity) || 0) / intensityMax.value * 100)))
const statusText = computed(() => {
  if (view.value?.ended) return t('gameRuntime.ended')
  if (view.value?.paused) return t('gameRuntime.paused')
  return view.value?.phaseText || view.value?.phase || t('gameRuntime.ready')
})
const statusClass = computed(() => {
  if (view.value?.ended) return 'ended'
  if (view.value?.paused) return 'paused'
  if (view.value?.phase === 'EDGING') return 'danger'
  if (view.value?.phase === 'MIDDLE') return 'active'
  return 'ready'
})

watch(() => props.paramsSchema, (value) => {
  if (props.source === 'remote') schema.value = value || []
}, { immediate: true })

watch(view, (value) => {
  const params = value?.params
  if (!value) return
  if (value.gameId !== lastGameId || value.startedAtMs !== Number(lastParams.__startedAtMs)) {
    history.value = []
    lastParams = {}
    lastGameId = value.gameId || ''
  }
  if (params) {
    lastParams = syncParamsDraft(draft, lastParams, params)
    lastParams.__startedAtMs = value.startedAtMs || 0
  }
  history.value.push({ pressure: Number(value.currentPressure) || 0, intensity: Number(value.currentIntensity) || 0 })
  if (history.value.length > 80) history.value.shift()
  void nextTick(drawChart)
  if (value.ended && props.navigateOnEnd && props.source === 'local') finish('ended')
}, { immediate: true, deep: true })

function formatNumber(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  return Math.abs(n) >= 100 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1)
}

function formatStartedAt(value: number) {
  try { return t('gameRuntime.startedAt', { value: new Date(value).toLocaleString() }) } catch (_) { return '' }
}

function drawChart() {
  const canvas = chartRef.value
  const current = view.value
  if (!canvas || !current) return
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(320, Math.round(rect.width * dpr))
  const height = Math.max(180, Math.round(rect.height * dpr))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const cssWidth = width / dpr
  const cssHeight = height / dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  const pad = 20
  const graphWidth = cssWidth - pad * 2
  const graphHeight = cssHeight - pad * 2
  const crit = Math.max(1, criticalPressure.value)
  const maxPressure = Math.max(crit + 4, Number(current.currentPressure) || 0, Number(current.midPressure) || 0)
  const maxIntensity = Math.max(10, intensityMax.value, Number(current.currentIntensity) || 0)
  const xOfPressure = (pressure: number) => pad + graphWidth * Math.max(0, Math.min(1, pressure / maxPressure))
  const yOfIntensity = (intensity: number) => pad + graphHeight * (1 - Math.max(0, Math.min(1, intensity / maxIntensity)))

  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(pad, pad + graphHeight)
  ctx.lineTo(pad + graphWidth, pad + graphHeight)
  ctx.moveTo(pad, pad)
  ctx.lineTo(pad, pad + graphHeight)
  ctx.stroke()

  const midX = xOfPressure(Number(current.midPressure) || crit * 0.9)
  const critX = xOfPressure(crit)
  ctx.fillStyle = 'rgba(59,130,246,.10)'
  ctx.beginPath()
  ctx.moveTo(midX, pad + graphHeight)
  ctx.lineTo(critX, pad + graphHeight)
  ctx.lineTo(midX, pad + graphHeight * 0.35)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = '#3b82f6'
  ctx.beginPath()
  ctx.moveTo(midX, pad + graphHeight)
  ctx.lineTo(midX, pad + graphHeight * 0.35)
  ctx.lineTo(critX, pad + graphHeight)
  ctx.stroke()

  const points = history.value
  if (points.length > 1) {
    ctx.strokeStyle = '#22c55e'
    ctx.lineWidth = 2
    ctx.beginPath()
    points.forEach((point, index) => {
      const x = pad + graphWidth * index / Math.max(1, points.length - 1)
      const y = yOfIntensity(point.intensity)
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
  ctx.fillStyle = '#64748b'
  ctx.font = '10px sans-serif'
  ctx.fillText('0', pad - 4, cssHeight - 5)
  ctx.fillText(formatNumber(maxPressure), cssWidth - 34, cssHeight - 5)
  ctx.fillText(formatNumber(maxIntensity), 2, pad + 8)
  ctx.fillText('0', 10, pad + graphHeight)
  ctx.fillStyle = '#22c55e'
  ctx.beginPath()
  ctx.arc(pad + graphWidth, yOfIntensity(Number(current.currentIntensity) || 0), 5, 0, Math.PI * 2)
  ctx.fill()
}

function applyStatus(status: any) {
  localSnapshot.value = restoreFromStatus(status)
  localConnection.value = 'live'
  failures = 0
  if (status?.running) {
    setActivePlay({ carrierType: 'game', id: status.gameId || status.snapshot?.gameId || 'surge-edging', title: status.snapshot?.title || status.gameId || t('gameRuntime.title'), resume: { name: 'game_runtime', query: { id: status.gameId || '' } } })
  }
}

async function poll() {
  try { applyStatus(await getGameRuntimeStatus()) } catch (_) {
    failures += 1
    localConnection.value = 'reconnecting'
    if (shouldStopAfterStatusFailure(failures)) await stop()
  }
}

async function beginDeferred() {
  waiting.value = false
  stopWait?.()
  stopWait = null
  const id = String(route.query.id || 'surge-edging')
  const deviceMap = JSON.parse(String(route.query.deviceMap || '{}'))
  const params = JSON.parse(String(route.query.params || '{}'))
  await startGameRuntime({ gameId: id, deviceMap, params })
  await poll()
  if (!pollTimer) pollTimer = setInterval(() => { void poll() }, 1000)
}

async function send(name: string, payload?: unknown) {
  if (props.source === 'remote') { emit('action', name, payload); return }
  await sendGameRuntimeAction(name, payload)
  await poll()
}

async function submitParams(value: Record<string, unknown>) {
  if (props.source === 'remote') { emit('params', value); return }
  applyStatus(await setGameRuntimeParams(value))
}

async function stop() {
  if (props.source === 'remote') { emit('stop'); return }
  await stopGameRuntime('user_stop')
  finish('user_stop')
}

function finish(reason: string) {
  if (!props.navigateOnEnd) return
  clearActivePlay()
  if (reason && route.name === 'game_runtime') router.push('/plays')
}

onMounted(async () => {
  if (props.source !== 'local') return
  resizeObserver = new ResizeObserver(() => drawChart())
  if (chartRef.value) resizeObserver.observe(chartRef.value)
  if (String(route.query.startMode || '') === 'button') {
    const games = await listHostGames().catch(() => [])
    const id = String(route.query.id || games[0]?.id || '')
    schema.value = games.find((game: any) => game.id === id)?.params || []
    waiting.value = true
    const trigger = String(route.query.startTriggerDeviceId || '')
    if (trigger) stopWait = listenDeviceButtonPress(trigger, () => { void beginDeferred() })
    return
  }
  await poll()
  const games = await listHostGames().catch(() => [])
  const id = String(localSnapshot.value?.gameId || route.query.id || games[0]?.id || '')
  schema.value = games.find((game: any) => game.id === id)?.params || []
  pollTimer = setInterval(() => { void poll() }, 1000)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  stopWait?.()
  resizeObserver?.disconnect()
})
</script>

<style scoped>
.runtime { min-height: 100%; padding: 20px 16px 40px; background: #f8fafc; color: #1e293b; box-sizing: border-box; }
.runtime.embedded { padding: 0; background: transparent; }
.game-shell { width: min(100%, 600px); margin: 0 auto; display: grid; gap: 16px; }
.runtime-alert { margin-bottom: 0; }
.game-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.eyebrow { display: block; color: #64748b; font-size: .78rem; letter-spacing: .04em; text-transform: uppercase; }
.title-block h1 { margin: 3px 0 0; font-size: 1.25rem; line-height: 1.3; color: #1e293b; }
.started-at { margin: 4px 0 0; color: #64748b; font-size: .78rem; }
.status-stack { display: grid; justify-items: end; gap: 5px; }
.status-badge { padding: 4px 10px; border-radius: 99px; font-size: .84rem; font-weight: 600; background: #eff6ff; color: #3b82f6; white-space: nowrap; }
.status-badge.active { background: #ecfdf5; color: #16a34a; }
.status-badge.danger { background: #fef2f2; color: #dc2626; }
.status-badge.paused { background: #fff7ed; color: #d97706; }
.status-badge.ended { background: #f1f5f9; color: #64748b; }
.remote-mark { color: #64748b; font-size: .72rem; }
.game-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 20px; box-shadow: 0 1px 3px rgba(15, 23, 42, .05); }
.metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.metric { display: flex; flex-direction: column; min-width: 0; }
.metric-label { margin-bottom: 4px; color: #64748b; font-size: .84rem; }
.metric-label span { font-size: .75rem; }
.metric-value { font-size: 2rem; line-height: 1.1; color: #1e293b; }
.progress { height: 8px; margin-top: 8px; overflow: hidden; border-radius: 4px; background: #f1f5f9; }
.progress span { display: block; height: 100%; transition: width .3s; }
.pressure-progress { background: linear-gradient(90deg, #3b82f6, #06b6d4); }
.intensity-progress { background: linear-gradient(90deg, #8b5cf6, #ec4899); }
.action-card { display: grid; gap: 10px; padding: 14px; }
.action-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.game-button, .stop-button, .small-button { border: 1px solid #e2e8f0; background: #fff; color: #1e293b; border-radius: 10px; cursor: pointer; font: inherit; font-weight: 600; transition: all .2s; }
.game-button { min-height: 44px; padding: 8px 10px; font-size: .85rem; }
.game-button:hover:not(:disabled), .small-button:hover:not(:disabled) { background: #f1f5f9; }
.game-button:active:not(:disabled), .stop-button:active:not(:disabled), .small-button:active:not(:disabled) { transform: scale(.98); }
.game-button.primary { border-color: #3b82f6; background: #3b82f6; color: #fff; }
.game-button.secondary { color: #2563eb; border-color: #bfdbfe; background: #eff6ff; }
.game-button.danger { color: #dc2626; border-color: #fecaca; background: #fff; }
.game-button:disabled, .stop-button:disabled, .small-button:disabled { opacity: .45; cursor: not-allowed; }
.stop-button { width: 100%; min-height: 40px; color: #dc2626; border-color: #fee2e2; background: #fff; }
.stat-row { display: flex; flex-wrap: wrap; gap: 15px; color: #64748b; font-size: .84rem; }
.stat-row b { color: #1e293b; }
.threshold-stats { margin-bottom: 8px; }
.chart { display: block; width: 100%; height: 200px; margin: 10px 0; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; }
.adjust-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 8px; border-radius: 8px; background: #f1f5f9; font-size: .84rem; }
.adjust-group { display: flex; align-items: center; gap: 7px; }
.small-button { width: 28px; height: 28px; padding: 0; border-radius: 6px; }
.chart-hint { margin-left: auto; color: #64748b; font-size: .76rem; }
.logs { list-style: none; height: 120px; margin: 10px 0 0; padding: 8px 0 0; overflow-y: auto; border-top: 1px solid #e2e8f0; color: #64748b; font-size: .8rem; }
.logs li { display: flex; align-items: baseline; gap: 7px; padding: 3px 0; border-bottom: 1px dashed #f1f5f9; }
.log-dot { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: #94a3b8; }
.log-warn { background: #f59e0b; }
.log-error { background: #ef4444; }
.log-info { background: #3b82f6; }
.empty-log { color: #94a3b8; }
.runtime-config { padding: 0; overflow: hidden; }
.runtime-config summary { display: flex; justify-content: space-between; gap: 12px; padding: 16px 20px; cursor: pointer; font-weight: 600; }
.runtime-config summary span { color: #64748b; font-size: .76rem; font-weight: 400; }
.runtime-config :deep(.params-form) { padding: 0 20px 20px; }
.wait-card { padding: 32px 20px; text-align: center; }
.wait-card h2 { margin: 8px 0; font-size: 1.25rem; }
.wait-card p { margin: 0 0 20px; color: #64748b; }
.empty-state { padding: 48px 16px; }
@media (max-width: 560px) {
  .runtime { padding: 12px 10px 28px; }
  .game-card { padding: 16px; }
  .metric-grid { gap: 12px; }
  .metric-value { font-size: 1.7rem; }
  .action-grid { grid-template-columns: 1fr 1fr; }
  .chart-hint { width: 100%; margin-left: 0; }
}
</style>
