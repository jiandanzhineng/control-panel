<template>
  <div class="runtime" :class="{ embedded }">
    <el-alert v-if="connection === 'reconnecting'" type="warning" :closable="false" :title="t('gameRuntime.reconnecting')" show-icon />
    <el-alert v-if="!authorized" type="info" :closable="false" :title="t('gameRuntime.waitAuth')" show-icon />

    <div v-if="waiting" class="wait-card">
      <h2>{{ t('gameRuntime.waitingButton') }}</h2>
      <el-button type="primary" @click="beginDeferred">{{ t('gameRuntime.startNow') }}</el-button>
    </div>

    <template v-else-if="view">
      <header class="head">
        <div>
          <h1>{{ view.title || t('gameRuntime.title') }}</h1>
          <p>{{ view.phaseText || view.phase }}</p>
        </div>
        <el-tag :type="view.ended ? 'info' : (view.paused ? 'warning' : 'success')">{{ view.phaseText }}</el-tag>
      </header>

      <section class="metrics">
        <div><span>{{ t('gameRuntime.pressure') }}</span><b>{{ view.currentPressure ?? 0 }}</b><small>Avg {{ view.averagePressure ?? 0 }}</small></div>
        <div><span>{{ t('gameRuntime.intensity') }}</span><b>{{ view.currentIntensity ?? 0 }}</b><small>{{ t('gameRuntime.target') }} {{ view.targetIntensity ?? 0 }}</small></div>
        <div><span>{{ t('gameRuntime.mid') }}</span><b>{{ view.midPressure ?? 0 }}</b></div>
        <div><span>{{ t('gameRuntime.edges') }}</span><b>{{ view.edgingCount ?? 0 }}</b></div>
        <div><span>{{ t('gameRuntime.shocks') }}</span><b>{{ view.shockCount ?? 0 }}</b></div>
        <div><span>{{ t('gameRuntime.stim') }}</span><b>{{ view.totalStimulationTime ?? 0 }}s</b></div>
      </section>

      <section class="actions">
        <el-button :disabled="!controls.pause" @click="send('pause')">{{ t('gameRuntime.pause') }}</el-button>
        <el-button :disabled="!controls.resume" @click="send('resume')">{{ t('gameRuntime.resume') }}</el-button>
        <el-button :disabled="!controls.action" @click="send('addIntensity', { delta: 10 })">{{ t('gameRuntime.addIntensity') }}</el-button>
        <el-button :disabled="!controls.action" @click="send('shockOnce')">{{ t('gameRuntime.shock') }}</el-button>
        <el-button :disabled="!controls.action" @click="send('forceEdge')">{{ t('gameRuntime.forceEdge') }}</el-button>
        <el-button type="danger" :disabled="!controls.stop" @click="stop">{{ t('gameRuntime.stop') }}</el-button>
      </section>

      <section v-if="schema.length" class="params">
        <h2>{{ t('gameRuntime.params') }}</h2>
        <PlayParamsForm :params="schema" :model="draft" :disabled="!controls.params" :submit-text="t('gameRuntime.saveParams')" @submit="submitParams" />
      </section>

      <section class="logs">
        <h2>{{ t('gameRuntime.logs') }}</h2>
        <ul>
          <li v-for="(entry, index) in view.logs || []" :key="index">{{ entry.message }}</li>
        </ul>
      </section>
    </template>
    <el-empty v-else :description="t('gameRuntime.empty')" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
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
import { controlsEnabled, restoreFromStatus, shouldStopAfterStatusFailure } from '../play/gameRuntimeSession'

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
let pollTimer: ReturnType<typeof setInterval> | null = null
let stopWait: (() => void) | null = null
let failures = 0

const view = computed(() => props.source === 'remote' ? props.snapshot : localSnapshot.value)
const connection = computed(() => props.source === 'remote' ? props.connection : localConnection.value)
const controls = computed(() => controlsEnabled({
  authorized: props.authorized,
  running: !!view.value?.running,
  paused: !!view.value?.paused,
  connection: connection.value,
}))

watch(() => props.paramsSchema, (value) => {
  if (props.source === 'remote') schema.value = value || []
}, { immediate: true })

watch(view, (value) => {
  const params = value?.params
  if (!params) return
  for (const [key, item] of Object.entries(params)) draft[key] = item
  if (value?.ended && props.navigateOnEnd && props.source === 'local') finish('ended')
}, { immediate: true })

function applyStatus(status: any) {
  localSnapshot.value = restoreFromStatus(status)
  localConnection.value = 'live'
  failures = 0
  if (status?.running) {
    setActivePlay({
      carrierType: 'game',
      id: status.gameId || status.snapshot?.gameId || 'surge-edging',
      title: status.snapshot?.title || status.gameId || t('gameRuntime.title'),
      resume: { name: 'game_runtime', query: { id: status.gameId || '' } },
    })
  }
}

async function poll() {
  try {
    applyStatus(await getGameRuntimeStatus())
  } catch (_) {
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
  if (props.source === 'remote') {
    emit('action', name, payload)
    return
  }
  await sendGameRuntimeAction(name, payload)
  await poll()
}

async function submitParams(value: Record<string, unknown>) {
  if (props.source === 'remote') {
    emit('params', value)
    return
  }
  const status = await setGameRuntimeParams(value)
  applyStatus(status)
}

async function stop() {
  if (props.source === 'remote') {
    emit('stop')
    return
  }
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
  const games = await listHostGames().catch(() => [])
  const id = String(route.query.id || games[0]?.id || '')
  schema.value = games.find((game: any) => game.id === id)?.params || games[0]?.params || []
  if (String(route.query.startMode || '') === 'button') {
    waiting.value = true
    const trigger = String(route.query.startTriggerDeviceId || '')
    if (trigger) stopWait = listenDeviceButtonPress(trigger, () => { void beginDeferred() })
    return
  }
  await poll()
  pollTimer = setInterval(() => { void poll() }, 1000)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  stopWait?.()
})
</script>

<style scoped>
.runtime { display: grid; gap: 16px; padding: 16px; }
.runtime:not(.embedded) { min-height: 100%; }
.head, .actions { display: flex; justify-content: space-between; gap: 12px; align-items: center; flex-wrap: wrap; }
.head h1, .params h2, .logs h2 { margin: 0; font-size: 18px; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.metrics div { border: 1px solid var(--el-border-color); border-radius: 12px; padding: 12px; display: grid; gap: 4px; }
.metrics span, .metrics small { color: var(--el-text-color-secondary); }
.metrics b { font-size: 28px; }
.logs ul { list-style: none; margin: 8px 0 0; padding: 0; max-height: 180px; overflow: auto; }
.logs li { padding: 4px 0; border-bottom: 1px dashed var(--el-border-color-lighter); }
.wait-card { padding: 32px 16px; text-align: center; }
@media (max-width: 720px) {
  .metrics b { font-size: 22px; }
  .actions :deep(.el-button) { flex: 1; }
}
</style>
