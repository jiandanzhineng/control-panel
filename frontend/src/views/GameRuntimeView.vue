<template>
  <PlayCarrierShell v-if="!embedded" mode="iframe" :stoppable="!!iframeSrc || waiting" :stopping="stopping" @stop="stop">
    <div class="runtime-view">
      <div v-if="connection === 'reconnecting'" class="connection-alert">
        <el-alert type="warning" :closable="false" :title="t('gameRuntime.reconnecting')" show-icon />
      </div>
      <div v-if="waiting" class="wait-card">
        <span class="eyebrow">{{ gameTitle }}</span>
        <h2 v-if="voiceWaiting">{{ t('gameRun.sayToStart', { phrase: voicePhraseLabel }) }}</h2>
        <h2 v-else>{{ t('gameRuntime.waitingButton') }}</h2>
        <p v-if="voiceWaiting && voiceError" class="wait-error">{{ voiceError }}</p>
        <div v-if="voiceWaiting" class="voice-level-track">
          <div class="voice-level-bar" :style="{ width: `${Math.round(voiceLevel * 100)}%` }"></div>
        </div>
        <el-button type="primary" @click="beginDeferred">{{ t('gameRuntime.startNow') }}</el-button>
        <el-button @click="cancelWait">{{ t('common.cancel') }}</el-button>
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
import { listenVoicePhrase } from '../composables/useVoiceStart'
import { DEFAULT_MIC_ID } from '../play/voiceStart'
import { currentLocale } from '../i18n'
import { localeTag } from '../i18n/locale'
import { getGameRuntimeStatus, listHostGames, setGameRuntimeParams, startGameRuntime, stopGameRuntime, type GameRuntimeSnapshot } from '../api/gameRuntime'
import { buildGameRuntimePageSrc, resolveGamePagePath } from '../play/gamePagePath'
import { createGameStateStream, type GameStateStreamHandle } from '../play/gameStateStreamClient'
import { controlsEnabled, restoreFromStatus, shouldStopAfterStatusFailure, syncParamsDraft } from '../play/gameRuntimeSession'
import { friendlyMessage } from '../api/errorMessage'

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
const voiceWaiting = ref(false)
const voiceLevel = ref(0)
const voiceError = ref('')
const voicePhraseLabel = ref('')
// 等待页顶部标题：用宿主游戏清单里的标题（query 只有 id）。原来的固定文案
// 会把任何托管游戏都写成「气压突变寸止」。
const hostTitle = ref('')
const gameTitle = computed(() => {
  const fromSnapshot = String((localSnapshot.value as any)?.title || '').trim()
  if (fromSnapshot) return fromSnapshot
  return hostTitle.value || t('gameRuntime.waitingTitle')
})
const pagePath = ref('')
const pageResolving = ref(false)
const pageError = ref('')
let stream: GameStateStreamHandle | null = null
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

// 兜底拉取：SSE 不可用时由状态流客户端调用；也用于「延迟启动」后的立即刷新
async function poll() {
  try { applyStatus(await getGameRuntimeStatus()) } catch (_) { failures += 1; localConnection.value = 'reconnecting'; if (shouldStopAfterStatusFailure(failures)) await stop() }
}

async function beginDeferred() {
  waiting.value = false; stopWait?.(); stopWait = null
  voiceWaiting.value = false
  const id = String(route.query.id || 'surge-edging')
  const deviceMap = JSON.parse(String(route.query.deviceMap || '{}'))
  const params = JSON.parse(String(route.query.params || '{}'))
  try {
    await startGameRuntime({ gameId: id, deviceMap, params })
  } catch (error: any) {
    // 被控端本地玩法在跑（HOST_PLAY_ACTIVE）等：给出可读提示，不进入等待按钮态
    waiting.value = false
    pageError.value = friendlyMessage(error, (key) => t(key), t('gameRuntime.emptyHint'))
    return
  }
  await poll()
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

// 取消等待：与「停止」不同，这里只是不启动游戏，同样要关掉语音监听。
function cancelWait() {
  waiting.value = false
  voiceWaiting.value = false
  stopWait?.(); stopWait = null
  finish('cancel_wait')
}

function startVoiceWaiting() {
  voiceWaiting.value = true
  voiceError.value = ''
  voicePhraseLabel.value = String(route.query.voicePhraseLabel || '') || t('playConfig.voiceStart')
  stopWait = listenVoicePhrase({
    phraseId: String(route.query.voicePhraseId || ''),
    micDeviceId: String(route.query.voiceMicId || '') || DEFAULT_MIC_ID,
    onDetected: () => { void beginDeferred() },
    onLevel: (level) => { voiceLevel.value = level },
    onError: () => { voiceError.value = t('gameRun.voiceError') },
  })
}

onMounted(async () => {
  if (props.source !== 'local') return
  if (String(route.query.startMode || '') === 'voice' && String(route.query.voicePhraseId || '')) {
    const games = await listHostGames().catch(() => [])
    const id = String(route.query.id || games[0]?.id || '')
    const found: any = games.find((game: any) => game.id === id)
    schema.value = found?.params || []
    hostTitle.value = String(found?.title || '')
    waiting.value = true
    startVoiceWaiting()
    return
  }
  if (String(route.query.startMode || '') === 'button') {
    const games = await listHostGames().catch(() => [])
    const id = String(route.query.id || games[0]?.id || '')
    const found: any = games.find((game: any) => game.id === id)
    schema.value = found?.params || []
    hostTitle.value = String(found?.title || '')
    waiting.value = true
    const trigger = String(route.query.startTriggerDeviceId || '')
    if (trigger) stopWait = listenDeviceButtonPress(trigger, () => { void beginDeferred() })
    return
  }
  await poll(); const games = await listHostGames().catch(() => [])
  const id = String(localSnapshot.value?.gameId || route.query.id || games[0]?.id || '')
  schema.value = games.find((game: any) => game.id === id)?.params || []
  // 状态走推送（SSE snapshot+patch）；EventSource 不可用时客户端自动回落轮询
  stream = createGameStateStream({
    url: '/api/game-runtime/stream',
    poll: () => getGameRuntimeStatus(),
    onState: (next) => applyStatus(next),
    onConnection: (state) => { localConnection.value = state },
  })
  stream.start()
})

onBeforeUnmount(() => { stream?.stop(); stream = null; stopWait?.(); stopWait = null })
</script>

<style scoped>
.runtime-view { display: flex; flex-direction: column; height: 100%; background: #f8fafc; }
.runtime-view.embedded { height: auto; background: transparent; }
.connection-alert { max-width: 600px; margin: 0 auto; padding: 16px 16px 0; width: 100%; box-sizing: border-box; }
.wait-card { max-width: 600px; margin: auto; padding: 48px 20px; text-align: center; }
.wait-card h2 { margin: 8px 0 16px; }
.wait-error { margin: 0 0 12px; color: #f56c6c; font-size: 13px; }
.voice-level-track { width: 100%; height: 8px; margin: 0 0 20px; border-radius: 4px; background: #e2e8f0; overflow: hidden; }
.voice-level-bar { height: 100%; border-radius: 4px; background: #409eff; transition: width .08s linear; }
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
