<template>
  <div class="runtime" :class="{ embedded, remote: mode === 'remote' }">
    <div class="container">
      <el-alert v-if="connection === 'reconnecting'" type="warning" :closable="false" :title="t('gameRuntime.reconnecting')" show-icon />
      <el-alert v-if="mode === 'remote' && !authorized" type="info" :closable="false" :title="t('gameRuntime.waitAuth')" show-icon />

      <header class="game-header">
        <div>
          <h1>{{ snapshot?.title || t('gameRuntime.title') }}</h1>
          <div v-if="mode !== 'config'" class="started-at">{{ startedAt }}</div>
        </div>
        <div class="badge" :class="statusClass">{{ mode === 'config' ? t('gameRuntime.configPreview') : statusText }}</div>
      </header>

      <section v-if="mode !== 'config'" class="card">
        <div class="grid-2">
          <div class="metric">
            <span class="label">{{ t('gameRuntime.pressure') }} ({{ t('gameRuntime.average') }}: {{ formatNumber(snapshot?.averagePressure) }})</span>
            <span class="value">{{ formatNumber(snapshot?.currentPressure) }}</span>
            <div class="progress"><div class="bar p" :style="{ width: pressurePercent + '%' }" /></div>
          </div>
          <div class="metric">
            <span class="label">{{ t('gameRuntime.intensity') }} ({{ t('gameRuntime.target') }}: {{ formatNumber(snapshot?.targetIntensity) }})</span>
            <span class="value">{{ formatNumber(snapshot?.currentIntensity) }}</span>
            <div class="progress"><div class="bar i" :style="{ width: intensityPercent + '%' }" /></div>
          </div>
        </div>
      </section>

      <section v-if="mode === 'config'" class="card config-note">
        <strong>{{ t('gameRuntime.configTitle') }}</strong>
        <p>{{ t('gameRuntime.configDesc') }}</p>
      </section>

      <section v-if="mode !== 'config'" class="card">
        <div class="actions">
          <button class="primary" :disabled="!controls.pause && !controls.resume" @click="send(snapshot?.paused ? 'resume' : 'pause')">
            {{ snapshot?.paused ? t('gameRuntime.resume') : t('gameRuntime.pause') }}
          </button>
          <button :disabled="!controls.action" @click="send('addIntensity', { delta: 10 })">+10 {{ t('gameRuntime.intensity') }}</button>
          <button class="danger" :disabled="!controls.action" @click="send('shockOnce')">⚡ {{ t('gameRuntime.shock') }}</button>
        </div>
        <button class="stop-button" :disabled="!controls.stop" @click="stop">{{ t('gameRuntime.stop') }}</button>
      </section>

      <section class="card">
        <div class="stat-row">
          <span>{{ t('gameRuntime.mid') }}: <b>{{ formatNumber(snapshot?.midPressure) }}</b></span>
          <span v-if="isPressureV2">{{ t('remoteGame.criticalPressure') }}: <b>{{ formatNumber(snapshot?.criticalPressure) }}</b></span>
          <span v-else>{{ t('gameRuntime.edgePeak') }}: <b>{{ formatNumber(snapshot?.edgePeak) }}</b></span>
          <span v-if="!isPressureV2">{{ t('gameRuntime.lastEdgePeak') }}: <b>{{ formatNumber(snapshot?.lastEdgePeak) }}</b></span>
        </div>
        <canvas ref="chartRef" class="chart" :aria-label="t('gameRuntime.pressure')" />
        <div class="adjust">
          <div>
            <span>{{ isPressureV2 ? t('gameRuntime.mid') : t('gameRuntime.mid') + t('gameRuntime.adjust') }}</span>
            <button class="btn-sm" :disabled="!controls.action" @click="send(isPressureV2 ? 'adjustThreshold' : 'adjustMid', isPressureV2 ? { which: 'mid', delta: -0.1 } : { delta: -0.1 })">−</button>
            <button class="btn-sm" :disabled="!controls.action" @click="send(isPressureV2 ? 'adjustThreshold' : 'adjustMid', isPressureV2 ? { which: 'mid', delta: 0.1 } : { delta: 0.1 })">+</button>
            <template v-if="isPressureV2">
              <span>{{ t('remoteGame.criticalPressure') }}</span>
              <button class="btn-sm" :disabled="!controls.action" @click="send('adjustThreshold', { which: 'crit', delta: -0.1 })">−</button>
              <button class="btn-sm" :disabled="!controls.action" @click="send('adjustThreshold', { which: 'crit', delta: 0.1 })">+</button>
            </template>
          </div>
          <span class="muted">{{ isPressureV2 ? t('gameRuntime.thresholdHint') : t('gameRuntime.surgeHint') }}</span>
        </div>
      </section>

      <section v-if="mode !== 'config'" class="card">
        <div class="stat-row">
          <span>{{ t('gameRuntime.edges') }}: <b>{{ snapshot?.edgingCount ?? 0 }}</b></span>
          <span>{{ t('gameRuntime.shocks') }}: <b>{{ snapshot?.shockCount ?? 0 }}</b></span>
          <span>{{ t('gameRuntime.stim') }}: <b>{{ formatNumber(snapshot?.totalStimulationTime) }}</b>s</span>
        </div>
        <ul class="logs">
          <li v-for="(entry, index) in snapshot?.logs || []" :key="`${entry.atMs || 0}-${index}`">
            <span class="log-dot" :class="`log-${entry.level || 'info'}`" />
            <span>{{ entry.message }}</span>
          </li>
          <li v-if="!(snapshot?.logs || []).length" class="muted">{{ t('gameRuntime.noLogs') }}</li>
        </ul>
      </section>

      <details v-if="paramsSchema.length && mode !== 'config'" class="card runtime-config" :open="mode === 'remote'">
        <summary>{{ t('gameRuntime.params') }}<span>{{ t('gameRuntime.paramsHint') }}</span></summary>
        <PlayParamsForm :params="paramsSchema" :model="draft" :disabled="!controls.params" :submit-text="t('gameRuntime.saveParams')" @submit="submitParams" />
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import PlayParamsForm from '../PlayParamsForm.vue'
import type { GameRuntimeSnapshot } from '../../api/gameRuntime'
import type { GameSurfaceControls } from '../GameRuntimeSurface.vue'

const props = withDefaults(defineProps<{
  snapshot?: GameRuntimeSnapshot | null
  mode?: 'local' | 'remote' | 'config'
  authorized?: boolean
  connection?: 'live' | 'reconnecting' | 'idle'
  paramsSchema?: Array<Record<string, any>>
  model?: Record<string, any>
  controls?: GameSurfaceControls
  embedded?: boolean
}>(), {
  snapshot: null,
  mode: 'local',
  authorized: true,
  connection: 'live',
  paramsSchema: () => [],
  model: () => ({}),
  controls: () => ({ pause: false, resume: false, action: false, stop: false, params: false }),
  embedded: false,
})

const emit = defineEmits<{ action: [name: string, payload?: unknown]; params: [value: Record<string, unknown>]; stop: [] }>()
const { t } = useI18n()
const chartRef = ref<HTMLCanvasElement | null>(null)
const draft = reactive<Record<string, any>>({})
const history = ref<Array<{ ts: number; pressure: number; strength: number; edgeTrigger: boolean; edgeActive: boolean }>>([])
let lastGameId = ''
let lastStartedAt = 0
let lastEdgePeak = 0
let resizeObserver: ResizeObserver | null = null

const controls = computed(() => props.controls)
const isPressureV2 = computed(() => props.snapshot?.gameId === 'pressure-edging-v2')
const pressureMax = computed(() => Math.max(2, ...history.value.map((point) => point.pressure), Number(props.snapshot?.midPressure) || 0, Number(props.snapshot?.criticalPressure) || 0, Number(props.snapshot?.currentPressure) || 0))
const intensityMax = computed(() => Math.max(1, Number(props.snapshot?.params?.maxMotorIntensity) || 50, Number(props.snapshot?.currentIntensity) || 0))
const pressurePercent = computed(() => Math.max(0, Math.min(100, (Number(props.snapshot?.currentPressure) || 0) / pressureMax.value * 100)))
const intensityPercent = computed(() => Math.max(0, Math.min(100, (Number(props.snapshot?.currentIntensity) || 0) / intensityMax.value * 100)))
const startedAt = computed(() => props.snapshot?.startedAtMs ? t('gameRuntime.startedAt', { value: new Date(props.snapshot.startedAtMs).toLocaleString() }) : '-')
const statusText = computed(() => props.snapshot?.ended ? t('gameRuntime.ended') : props.snapshot?.paused ? t('gameRuntime.paused') : props.snapshot?.phaseText || t('gameRuntime.ready'))
const statusClass = computed(() => props.snapshot?.ended ? 'ended' : props.snapshot?.paused ? 'paused' : props.snapshot?.phase === 'EDGING' ? 'danger' : 'active')

watch(() => props.model, (value) => {
  for (const key of Object.keys(draft)) if (!(key in (value || {}))) delete draft[key]
  Object.assign(draft, value || {})
}, { immediate: true, deep: true })

watch(() => props.snapshot, (value) => {
  if (!value) return
  const started = Number(value.startedAtMs || 0)
  if (value.gameId !== lastGameId || started !== lastStartedAt) {
    history.value = []
    lastGameId = value.gameId || ''
    lastStartedAt = started
    lastEdgePeak = 0
  }
  if (value.params) Object.assign(draft, value.params)
  const currentEdge = Number(value.edgePeak) || 0
  history.value.push({ ts: Date.now(), pressure: Number(value.currentPressure) || 0, strength: Number(value.currentIntensity) || 0, edgeTrigger: currentEdge > 0 && currentEdge !== lastEdgePeak, edgeActive: value.phase === 'EDGING' })
  lastEdgePeak = currentEdge
  if (history.value.length > 120) history.value.shift()
  void nextTick(drawChart)
}, { immediate: true, deep: true })

function formatNumber(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  return Math.abs(n) >= 100 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1)
}
function send(name: string, payload?: unknown) { emit('action', name, payload) }
function submitParams(value: Record<string, unknown>) { emit('params', value) }
function stop() { emit('stop') }

function drawChart() {
  const canvas = chartRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1
  const width = Math.max(320, Math.round(rect.width * dpr)); const height = Math.max(180, Math.round(rect.height * dpr))
  canvas.width = width; canvas.height = height
  const ctx = canvas.getContext('2d'); if (!ctx) return
  const w = width / dpr; const h = height / dpr; const pad = { top: 14, right: 38, bottom: 22, left: 34 }; const gw = Math.max(1, w - pad.left - pad.right); const gh = Math.max(1, h - pad.top - pad.bottom)
  const points = history.value; const pMin = points.length ? Math.min(...points.map((point) => point.pressure)) : 0; const pMax = Math.max(pressureMax.value, pMin + 2); const t0 = points[0]?.ts || Date.now(); const t1 = points[points.length - 1]?.ts || t0 + 1
  const x = (ts: number) => pad.left + ((ts - t0) / Math.max(1, t1 - t0)) * gw; const yPressure = (v: number) => pad.top + gh * (1 - Math.max(0, Math.min(1, (v - pMin) / Math.max(1, pMax - pMin)))); const yStrength = (v: number) => pad.top + gh * (1 - Math.max(0, Math.min(1, v / intensityMax.value)))
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.left, pad.top + gh); ctx.lineTo(pad.left + gw, pad.top + gh); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + gh); ctx.stroke()
  const mid = Number(props.snapshot?.midPressure)
  if (Number.isFinite(mid) && mid >= pMin && mid <= pMax) { ctx.strokeStyle = '#f97316'; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(pad.left, yPressure(mid)); ctx.lineTo(pad.left + gw, yPressure(mid)); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = '#f97316'; ctx.font = '10px sans-serif'; ctx.fillText(`中间 ${formatNumber(mid)}`, pad.left + 4, Math.max(10, yPressure(mid) - 4)) }
  if (points.length > 1) {
    ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2; ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(x(point.ts), yPressure(point.pressure)) : ctx.moveTo(x(point.ts), yPressure(point.pressure))); ctx.stroke()
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(x(point.ts), yStrength(point.strength)) : ctx.moveTo(x(point.ts), yStrength(point.strength))); ctx.stroke(); ctx.setLineDash([])
    for (const point of points) { if (!point.edgeTrigger && !point.edgeActive) continue; ctx.fillStyle = point.edgeTrigger ? '#22c55e' : '#ef4444'; ctx.beginPath(); ctx.arc(x(point.ts), yPressure(point.pressure), point.edgeTrigger ? 4 : 2.5, 0, Math.PI * 2); ctx.fill() }
  }
  ctx.fillStyle = '#64748b'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.fillText(formatNumber(pMax), pad.left - 4, pad.top + 8); ctx.fillText(formatNumber(pMin), pad.left - 4, pad.top + gh); ctx.textAlign = 'left'; ctx.fillText(formatNumber(intensityMax.value), pad.left + gw + 6, pad.top + 8); ctx.fillText('0', pad.left + gw + 6, pad.top + gh)
}

onMounted(() => { resizeObserver = new ResizeObserver(() => drawChart()); if (chartRef.value) resizeObserver.observe(chartRef.value) })
onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<style scoped>
.runtime { min-height: 100%; padding: 16px; background: #f8fafc; color: #1e293b; box-sizing: border-box; }.runtime.embedded { padding: 0; background: transparent; }.container { max-width: 600px; margin: 0 auto; display: grid; gap: 16px; }.game-header { display: flex; justify-content: space-between; align-items: center; gap: 16px; }h1 { margin: 0; font-size: 1.25rem; font-weight: 700; }.started-at,.muted { color: #64748b; font-size: .8rem; }.badge { padding: 4px 10px; border-radius: 99px; font-size: .85rem; background: #eff6ff; color: #3b82f6; font-weight: 600; white-space: nowrap; }.badge.active { background: #ecfdf5; color: #16a34a; }.badge.danger { background: #fef2f2; color: #dc2626; }.badge.paused { background: #fff7ed; color: #d97706; }.badge.ended { background: #f1f5f9; color: #64748b; }.card { background: #fff; border-radius: 16px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.05); border: 1px solid #e2e8f0; }.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }.metric { display: flex; flex-direction: column; }.label { font-size: .85rem; color: #64748b; margin-bottom: 4px; }.value { font-size: 2rem; font-weight: 700; line-height: 1.1; }.progress { height: 8px; background: #f1f5f9; border-radius: 4px; overflow: hidden; margin-top: 8px; }.bar { height: 100%; transition: width .3s; }.bar.p { background: linear-gradient(90deg,#3b82f6,#06b6d4); }.bar.i { background: linear-gradient(90deg,#8b5cf6,#ec4899); }.actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }button { border: 1px solid #e2e8f0; background: #fff; padding: 12px; border-radius: 10px; font-weight: 600; color: #1e293b; cursor: pointer; font-size: .9rem; transition: all .2s; }button:active:not(:disabled) { background: #f1f5f9; transform: scale(.98); }button:disabled { opacity: .45; cursor: not-allowed; }button.primary { background: #3b82f6; color: #fff; border-color: #3b82f6; }button.danger { color: #ef4444; border-color: #fee2e2; }.stop-button { width: 100%; margin-top: 10px; color: #dc2626; border-color: #fee2e2; }.config-note p { margin: 8px 0 0; color: #64748b; line-height: 1.6; }.chart { width: 100%; height: 200px; display: block; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; margin: 10px 0; }.stat-row { display: flex; gap: 15px; font-size: .85rem; color: #64748b; margin-bottom: 8px; flex-wrap: wrap; }.stat-row b { color: #1e293b; }.adjust { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; background: #f1f5f9; padding: 8px; border-radius: 8px; font-size: .85rem; }.adjust > div { display: flex; align-items: center; gap: 8px; }.btn-sm { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; }.logs { list-style: none; margin: 0; padding: 8px 0 0; height: 120px; overflow-y: auto; font-size: .8rem; color: #64748b; border-top: 1px solid #e2e8f0; }.logs li { display: flex; align-items: baseline; gap: 7px; padding: 3px 0; border-bottom: 1px dashed #f1f5f9; }.log-dot { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: #3b82f6; }.log-warn { background: #f59e0b; }.log-error { background: #ef4444; }.runtime-config { padding: 0; overflow: hidden; }.runtime-config summary { display: flex; justify-content: space-between; gap: 12px; padding: 16px 20px; cursor: pointer; font-weight: 600; }.runtime-config summary span { color: #64748b; font-size: .76rem; font-weight: 400; }.runtime-config :deep(.params-form) { padding: 0 20px 20px; }
@media (max-width: 560px) { .runtime { padding: 12px 10px 28px; }.card { padding: 16px; }.grid-2 { gap: 12px; }.value { font-size: 1.7rem; }.actions { grid-template-columns: 1fr 1fr; }.actions button:last-child { grid-column: span 2; } }
</style>
