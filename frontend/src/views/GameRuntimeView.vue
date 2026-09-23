<template>
  <div class="runtime-view" :class="{ embedded }">
    <div class="runtime-shell">
      <div v-if="connection === 'reconnecting'" class="connection-alert">
        <el-alert type="warning" :closable="false" :title="t('gameRuntime.reconnecting')" show-icon />
      </div>

      <div v-if="waiting" class="wait-card">
        <span class="eyebrow">{{ t('gameRuntime.title') }}</span>
        <h2>{{ t('gameRuntime.waitingButton') }}</h2>
        <p>{{ t('gameRuntime.startNow') }}</p>
        <el-button type="primary" @click="beginDeferred">{{ t('gameRuntime.startNow') }}</el-button>
      </div>

      <GameRuntimeSurface
        v-else-if="view"
        :snapshot="view"
        :mode="source"
        :authorized="authorized"
        :connection="connection"
        :params-schema="schema"
        :model="draft"
        :controls="controls"
        :embedded="embedded"
        @action="send"
        @params="submitParams"
        @stop="stop"
      />

      <el-empty v-else class="empty-state" :description="t('gameRuntime.empty')" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import GameRuntimeSurface from '../components/GameRuntimeSurface.vue'
import { clearActivePlay, setActivePlay } from '../composables/useActivePlay'
import { listenDeviceButtonPress } from '../composables/useButtonStart'
import { getGameRuntimeStatus, listHostGames, sendGameRuntimeAction, setGameRuntimeParams, startGameRuntime, stopGameRuntime, type GameRuntimeSnapshot } from '../api/gameRuntime'
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
  source: 'local', snapshot: null, authorized: true, connection: 'live', paramsSchema: () => [], embedded: false, navigateOnEnd: true,
})

const emit = defineEmits<{ action: [name: string, payload?: unknown]; params: [value: Record<string, unknown>]; stop: [] }>()
const { t } = useI18n(); const route = useRoute(); const router = useRouter()
const localSnapshot = ref<GameRuntimeSnapshot | null>(null)
const localConnection = ref<'live' | 'reconnecting' | 'idle'>('idle')
const schema = ref<Array<Record<string, any>>>([])
const draft = reactive<Record<string, any>>({})
const waiting = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null
let stopWait: (() => void) | null = null
let failures = 0
let lastParams: Record<string, unknown> = {}
let lastGameId = ''

const embedded = computed(() => props.embedded)
const view = computed(() => props.source === 'remote' ? props.snapshot : localSnapshot.value)
const connection = computed(() => props.source === 'remote' ? props.connection : localConnection.value)
const controls = computed(() => controlsEnabled({ authorized: props.authorized, running: !!view.value?.running, paused: !!view.value?.paused, connection: connection.value }))

watch(() => props.paramsSchema, (value) => { if (props.source === 'remote') schema.value = value || [] }, { immediate: true })
watch(view, (value) => {
  if (!value) return
  if (value.gameId !== lastGameId || value.startedAtMs !== Number(lastParams.__startedAtMs)) { lastParams = {}; lastGameId = value.gameId || '' }
  if (value.params) { lastParams = syncParamsDraft(draft, lastParams, value.params); lastParams.__startedAtMs = value.startedAtMs || 0 }
  if (value.ended && props.navigateOnEnd && props.source === 'local') finish('ended')
}, { immediate: true, deep: true })

function applyStatus(status: any) {
  localSnapshot.value = restoreFromStatus(status) as GameRuntimeSnapshot | null
  localConnection.value = 'live'; failures = 0
  if (status?.running) setActivePlay({ carrierType: 'game', id: status.gameId || status.snapshot?.gameId || 'surge-edging', title: status.snapshot?.title || status.gameId || t('gameRuntime.title'), resume: { name: 'game_runtime', query: { id: status.gameId || '' } } })
}

async function poll() {
  try { applyStatus(await getGameRuntimeStatus()) } catch (_) { failures += 1; localConnection.value = 'reconnecting'; if (shouldStopAfterStatusFailure(failures)) await stop() }
}

async function beginDeferred() {
  waiting.value = false; stopWait?.(); stopWait = null
  const id = String(route.query.id || 'surge-edging')
  const deviceMap = JSON.parse(String(route.query.deviceMap || '{}'))
  const params = JSON.parse(String(route.query.params || '{}'))
  await startGameRuntime({ gameId: id, deviceMap, params }); await poll()
  if (!pollTimer) pollTimer = setInterval(() => { void poll() }, 1000)
}

async function send(name: string, payload?: unknown) {
  if (props.source === 'remote') { emit('action', name, payload); return }
  await sendGameRuntimeAction(name, payload); await poll()
}

async function submitParams(value: Record<string, unknown>) {
  if (props.source === 'remote') { emit('params', value); return }
  applyStatus(await setGameRuntimeParams(value))
}

async function stop() {
  if (props.source === 'remote') { emit('stop'); return }
  await stopGameRuntime('user_stop'); finish('user_stop')
}

function finish(reason: string) {
  if (!props.navigateOnEnd) return
  clearActivePlay(); if (reason && route.name === 'game_runtime') router.push('/plays')
}

onMounted(async () => {
  if (props.source !== 'local') return
  if (String(route.query.startMode || '') === 'button') {
    const games = await listHostGames().catch(() => [])
    const id = String(route.query.id || games[0]?.id || '')
    schema.value = games.find((game: any) => game.id === id)?.params || []
    waiting.value = true
    const trigger = String(route.query.startTriggerDeviceId || '')
    if (trigger) stopWait = listenDeviceButtonPress(trigger, () => { void beginDeferred() })
    return
  }
  await poll(); const games = await listHostGames().catch(() => [])
  const id = String(localSnapshot.value?.gameId || route.query.id || games[0]?.id || '')
  schema.value = games.find((game: any) => game.id === id)?.params || []
  pollTimer = setInterval(() => { void poll() }, 1000)
})

onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer); stopWait?.() })
</script>

<style scoped>
.runtime-view { min-height: 100%; background: #f8fafc; }.runtime-view.embedded { background: transparent; }.runtime-shell { min-height: 100%; }.connection-alert { max-width: 600px; margin: 0 auto; padding: 16px 16px 0; }.wait-card { max-width: 600px; margin: 0 auto; padding: 48px 20px; text-align: center; }.wait-card h2 { margin: 8px 0; }.wait-card p { color: #64748b; }.eyebrow { color: #64748b; font-size: .78rem; letter-spacing: .04em; text-transform: uppercase; }.empty-state { padding: 48px 16px; }
</style>
