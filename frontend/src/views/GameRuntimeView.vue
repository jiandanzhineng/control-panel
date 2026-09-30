<template>
  <PlayCarrierShell v-if="!embedded" mode="iframe" :stoppable="!!iframeSrc || waiting" :stopping="stopping" @stop="stop">
    <div class="runtime-view">
      <div v-if="connection === 'reconnecting'" class="connection-alert">
        <el-alert type="warning" :closable="false" :title="t('gameRuntime.reconnecting')" show-icon />
      </div>
      <div v-if="waiting" class="wait-card">
        <span class="eyebrow">{{ t('gameRuntime.title') }}</span>
        <h2>{{ t('gameRuntime.waitingButton') }}</h2>
        <el-button type="primary" @click="beginDeferred">{{ t('gameRuntime.startNow') }}</el-button>
      </div>
      <template v-else>
        <div class="frame-wrap">
          <iframe v-if="iframeSrc" :src="iframeSrc" class="game-frame" allow="fullscreen; autoplay"></iframe>
          <div v-else-if="pageResolving" class="page-hint">{{ t('gameRuntime.loadingPage') }}</div>
          <el-empty v-else class="empty-state" :description="pageError || t('gameRuntime.empty')">
            <p class="empty-hint">{{ t('gameRuntime.emptyHint') }}</p>
            <el-button type="primary" @click="retryLoad">{{ t('gameRuntime.refresh') }}</el-button>
          </el-empty>
        </div>
        <details v-if="schema.length" class="params-panel">
          <summary>{{ t('gameRuntime.params') }}<span>{{ t('gameRuntime.paramsHint') }}</span></summary>
          <PlayParamsForm :params="schema" :model="draft" :disabled="!controls.params" :submit-text="t('gameRuntime.saveParams')" @submit="submitParams" />
        </details>
      </template>
    </div>
  </PlayCarrierShell>

  <div v-else class="runtime-view embedded">
    <div v-if="connection === 'reconnecting'" class="connection-alert">
      <el-alert type="warning" :closable="false" :title="t('gameRuntime.reconnecting')" show-icon />
    </div>
    <div class="frame-wrap">
      <iframe v-if="iframeSrc" :src="iframeSrc" class="game-frame" allow="fullscreen; autoplay"></iframe>
      <div v-else-if="pageResolving" class="page-hint">{{ t('gameRuntime.loadingPage') }}</div>
      <el-empty v-else class="empty-state" :description="pageError || t('gameRuntime.empty')">
        <p class="empty-hint">{{ t('gameRuntime.emptyHint') }}</p>
        <el-button type="primary" @click="retryLoad">{{ t('gameRuntime.refresh') }}</el-button>
      </el-empty>
    </div>
    <details v-if="schema.length" class="params-panel">
      <summary>{{ t('gameRuntime.params') }}<span>{{ t('gameRuntime.paramsHint') }}</span></summary>
      <PlayParamsForm :params="schema" :model="draft" :disabled="!controls.params" :submit-text="t('gameRuntime.saveParams')" @submit="submitParams" />
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import PlayCarrierShell from '../components/PlayCarrierShell.vue'
import PlayParamsForm from '../components/PlayParamsForm.vue'
import { clearActivePlay, setActivePlay } from '../composables/useActivePlay'
import { listenDeviceButtonPress } from '../composables/useButtonStart'
import { currentLocale } from '../i18n'
import { localeTag } from '../i18n/locale'
import { getGameRuntimeStatus, listHostGames, setGameRuntimeParams, startGameRuntime, stopGameRuntime, type GameRuntimeSnapshot } from '../api/gameRuntime'
import { buildGameRuntimePageSrc, resolveGamePagePath } from '../play/gamePagePath'
import { controlsEnabled, restoreFromStatus, shouldStopAfterStatusFailure, syncParamsDraft } from '../play/gameRuntimeSession'

const props = withDefaults(defineProps<{
  source?: 'local' | 'remote'
  snapshot?: GameRuntimeSnapshot | null
  authorized?: boolean
  connection?: 'live' | 'reconnecting' | 'idle'
  paramsSchema?: Array<Record<string, any>>
  pagePath?: string
  embedded?: boolean
  navigateOnEnd?: boolean
}>(), {
  source: 'local', snapshot: null, authorized: true, connection: 'live', paramsSchema: () => [], pagePath: '', embedded: false, navigateOnEnd: true,
})

const emit = defineEmits<{ params: [value: Record<string, unknown>] }>()
const { t } = useI18n(); const route = useRoute(); const router = useRouter()
const localSnapshot = ref<GameRuntimeSnapshot | null>(null)
const localConnection = ref<'live' | 'reconnecting' | 'idle'>('idle')
const schema = ref<Array<Record<string, any>>>([])
const draft = reactive<Record<string, any>>({})
const waiting = ref(false)
const stopping = ref(false)
const pagePath = ref('')
const pageResolving = ref(false)
const pageError = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null
let stopWait: (() => void) | null = null
let failures = 0
let lastParams: Record<string, unknown> = {}
let lastGameId = ''

const embedded = computed(() => props.embedded)
const view = computed(() => props.source === 'remote' ? props.snapshot : localSnapshot.value)
const connection = computed(() => props.source === 'remote' ? props.connection : localConnection.value)
const controls = computed(() => controlsEnabled({ authorized: props.authorized, running: !!view.value?.running, paused: !!view.value?.paused, connection: connection.value }))
const iframeSrc = computed(() => {
  const runtime = props.source === 'remote' ? 'remote' : 'host'
  const locale = String(route.query.locale || currentLocale())
  const tag = String(route.query.localeTag || localeTag(currentLocale()))
  return buildGameRuntimePageSrc(pagePath.value, runtime, locale, tag)
})

watch(() => props.paramsSchema, (value) => { if (props.source === 'remote') schema.value = value || [] }, { immediate: true })
watch(() => props.pagePath, (value) => { if (props.source === 'remote') { pagePath.value = value || ''; pageResolving.value = !value; pageError.value = '' } }, { immediate: true })
watch(view, (value) => {
  if (!value) return
  if (value.gameId !== lastGameId || value.startedAtMs !== Number(lastParams.__startedAtMs)) { lastParams = {}; lastGameId = value.gameId || '' }
  if (value.params) { lastParams = syncParamsDraft(draft, lastParams, value.params); lastParams.__startedAtMs = value.startedAtMs || 0 }
  if (value.ended && props.navigateOnEnd && props.source === 'local') finish('ended')
}, { immediate: true, deep: true })

async function ensurePagePath(gameId: string) {
  if (props.source === 'remote') return
  const fromQuery = String(route.query.gamePath || '')
  if (fromQuery) { pagePath.value = fromQuery; return }
  const id = String(gameId || route.query.id || '')
  if (!id || pagePath.value) return
  pageResolving.value = true
  try {
    pagePath.value = await resolveGamePagePath(id)
    pageError.value = pagePath.value ? '' : t('gameRuntime.pageUnavailable')
  } catch (_) {
    pageError.value = t('gameRuntime.pageUnavailable')
  } finally {
    pageResolving.value = false
  }
}

function applyStatus(status: any) {
  localSnapshot.value = restoreFromStatus(status) as GameRuntimeSnapshot | null
  localConnection.value = 'live'; failures = 0
  const gameId = status?.gameId || status?.snapshot?.gameId || ''
  if (gameId) void ensurePagePath(gameId)
  if (status?.running) setActivePlay({ carrierType: 'game', id: gameId || 'surge-edging', title: status.snapshot?.title || gameId || t('gameRuntime.title'), resume: { name: 'game_runtime', query: { id: gameId } } })
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

async function submitParams(value: Record<string, unknown>) {
  if (props.source === 'remote') { emit('params', value); return }
  applyStatus(await setGameRuntimeParams(value))
}

// 空状态重试：本地重新拉状态+解析页面路径；远程强制重建 iframe
async function retryLoad() {
  pageError.value = ''
  if (props.source === 'remote') {
    const cur = pagePath.value
    pagePath.value = ''
    await nextTick()
    pagePath.value = cur
    return
  }
  pagePath.value = ''
  await poll()
}

async function stop() {
  if (props.source === 'remote') return
  stopping.value = true
  try { await stopGameRuntime('user_stop') } catch (_) {}
  stopping.value = false
  finish('user_stop')
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
.runtime-view { display: flex; flex-direction: column; height: 100%; background: #f8fafc; }
.runtime-view.embedded { height: auto; background: transparent; }
.connection-alert { max-width: 600px; margin: 0 auto; padding: 16px 16px 0; width: 100%; box-sizing: border-box; }
.wait-card { max-width: 600px; margin: auto; padding: 48px 20px; text-align: center; }
.wait-card h2 { margin: 8px 0 16px; }
.eyebrow { color: #64748b; font-size: .78rem; letter-spacing: .04em; text-transform: uppercase; }
.frame-wrap { flex: 1; position: relative; min-height: 0; }
.runtime-view.embedded .frame-wrap { min-height: 520px; }
.game-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
.page-hint { padding: 48px 16px; text-align: center; color: #64748b; }
.empty-state { padding: 48px 16px; }
.empty-hint { margin: 0 0 12px; color: #64748b; font-size: 13px; }
.params-panel { flex: 0 0 auto; background: #fff; border-top: 1px solid #e2e8f0; }
.params-panel summary { display: flex; justify-content: space-between; gap: 12px; padding: 12px 20px; cursor: pointer; font-weight: 600; }
.params-panel summary span { color: #64748b; font-size: .76rem; font-weight: 400; }
.params-panel :deep(.params-form) { padding: 0 20px 20px; }
</style>
