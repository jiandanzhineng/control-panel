<template>
  <section class="remote-game" :class="{ standalone }">
    <div v-if="!standalone" class="head">
      <div>
        <span class="eyebrow">CONTROL PANEL / REMOTE WORKSPACE</span>
        <h2>{{ t('remoteGame.title') }}</h2>
        <p>{{ t('remoteGame.desc') }}</p>
      </div>
      <el-button :icon="Refresh" circle :loading="loading" @click="refresh" />
    </div>
    <el-alert v-if="error" type="error" :title="error" show-icon @close="error = ''" />

    <div v-if="status.active" class="remote-steps" aria-label="remote game steps">
      <span class="step" :class="{ current: !status.authorized && !status.snapshot?.running }">1 · {{ t('remoteGame.roomStep') }}</span>
      <span class="step" :class="{ current: status.authorized && !status.snapshot?.running }">2 · {{ t('remoteGame.authStep') }}</span>
      <span class="step" :class="{ current: !!status.snapshot?.running }">3 · {{ t('remoteGame.gameStep') }}</span>
    </div>

    <template v-if="!status.active">
      <el-radio-group v-model="mode" class="mode">
        <el-radio-button value="owner">{{ t('remoteGame.create') }}</el-radio-button>
        <el-radio-button value="operator">{{ t('remoteGame.join') }}</el-radio-button>
      </el-radio-group>
      <el-button v-if="mode === 'owner'" type="primary" :loading="busy" @click="create">{{ t('remoteGame.create') }}</el-button>
      <div v-else class="join">
        <el-input v-model="joinCode" :placeholder="t('remoteGame.code')" @keyup.enter="join" />
        <el-button type="primary" :loading="busy" @click="join">{{ t('remoteGame.join') }}</el-button>
      </div>
    </template>

    <template v-else>
      <div class="session">
        <strong v-if="status.joinCode">{{ status.joinCode }}</strong>
        <span>{{ status.authorized ? t('remoteGame.authorized') : t('remoteGame.waiting') }}</span>
        <span v-if="status.role === 'owner'">{{ status.operatorOnline ? t('remoteGame.operator') : t('remoteGame.offline') }}</span>
        <el-button v-if="status.role === 'owner'" @click="toggleAuth">
          {{ status.authorized ? t('remoteGame.revoke') : t('remoteGame.authorize') }}
        </el-button>
        <el-button type="danger" plain @click="leave">{{ t('remoteGame.leave') }}</el-button>
      </div>

      <GameRuntimeView
        v-if="status.role === 'owner' && status.snapshot?.running"
        source="local"
        embedded
        :navigate-on-end="false"
      />

      <template v-else>
        <el-alert v-if="!status.authorized" type="info" :closable="false" :title="t('gameRuntime.waitAuth')" show-icon />
        <div v-if="status.authorized && !status.snapshot?.running" class="setup">
          <div class="setup-section">
            <h3>{{ t('remoteGame.games') }}</h3>
            <el-select v-model="gameId" :placeholder="t('remoteGame.games')" class="game-select">
              <el-option v-for="game in hostGames" :key="game.id" :label="game.title || game.id" :value="game.id" />
            </el-select>
          </div>
          <template v-if="selectedGame">
            <GameRuntimeSurface
              mode="config"
              embedded
              :snapshot="configPreview"
              :controls="disabledSurfaceControls"
            />
            <div class="setup-section">
              <h3>{{ t('playConfig.mapping') }}</h3>
              <div v-for="role in selectedGame.devices || []" :key="role.id" class="map-row">
                <div class="role-name">
                  <strong>{{ role.label || role.id }}</strong>
                  <el-tag size="small" :type="role.required ? 'danger' : 'info'">{{ role.required ? t('common.required') : t('common.optional') }}</el-tag>
                </div>
                <el-checkbox-group v-model="deviceMap[role.id]" class="device-options">
                  <el-checkbox v-for="device in availableDevices(role)" :key="device.id" :value="device.id">{{ device.name || device.id }}</el-checkbox>
                  <span v-if="!availableDevices(role).length" class="muted">{{ t('remoteGame.noDevice') }}</span>
                </el-checkbox-group>
              </div>
            </div>
            <div class="setup-section">
              <h3>{{ t('playConfig.params') }}</h3>
              <PlayParamsForm :params="visibleParams" :model="params" :show-submit="false" :show-reset="true" @reset="resetParams" />
            </div>
            <el-alert v-if="blocking.length" type="warning" :closable="false" :title="blocking.join('；')" show-icon />
            <div class="start-row">
              <el-button type="primary" :loading="busy" :disabled="!controls.start || blocking.length > 0" @click="startGame">{{ t('remoteGame.start') }}</el-button>
            </div>
          </template>
        </div>
        <GameRuntimeView
          v-if="status.snapshot?.running"
          source="remote"
          embedded
          :navigate-on-end="false"
          :authorized="!!status.authorized"
          :connection="status.connected === false ? 'reconnecting' : 'live'"
          :snapshot="status.snapshot || null"
          :params-schema="selectedGame?.params || []"
          @action="sendAction"
          @params="saveParams"
          @stop="sendAction('stop')"
        />
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Refresh } from '@element-plus/icons-vue'
import PlayParamsForm from './PlayParamsForm.vue'
import GameRuntimeSurface from './GameRuntimeSurface.vue'
import GameRuntimeView from '../views/GameRuntimeView.vue'
import {
  authorizeRemoteGame,
  createRemoteGame,
  getRemoteGameStatus,
  joinRemoteGame,
  revokeRemoteGame,
  sendRemoteGameCommand,
  stopRemoteGame,
  type RemoteGameStatus,
} from '../api/remoteGame'
import { controlsEnabled } from '../play/gameRuntimeSession'

const { t } = useI18n()
const props = withDefaults(defineProps<{ standalone?: boolean }>(), { standalone: false })
const standalone = computed(() => props.standalone)
const mode = ref<'owner' | 'operator'>('owner')
const joinCode = ref('')
const status = ref<RemoteGameStatus>({ active: false })
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const gameId = ref(localStorage.getItem('remoteGame:selectedGame') || '')
const deviceMap = reactive<Record<string, string[]>>({})
const params = reactive<Record<string, any>>({})
let timer: ReturnType<typeof setInterval> | null = null
let configuredGameId = ''

const hostGames = computed(() => (status.value.games || []).filter((game) => game.runtimeMode === 'host'))
const selectedGame = computed(() => hostGames.value.find((game) => game.id === gameId.value))
const disabledSurfaceControls = { pause: false, resume: false, action: false, stop: false, params: false }
const configPreview = computed(() => {
  const game = selectedGame.value
  if (!game) return null
  const values = { ...params }
  return {
    gameId: game.id,
    title: game.title || game.id,
    phase: 'IDLE',
    phaseText: t('gameRuntime.configPreview'),
    currentPressure: 0,
    averagePressure: 0,
    midPressure: Number(values.midPressure ?? 50),
    criticalPressure: Number(values.criticalPressure ?? 20),
    currentIntensity: 0,
    targetIntensity: 0,
    params: values,
    logs: [],
  }
})
const visibleParams = computed(() => (selectedGame.value?.params || []).filter((param) => (
  !param.device || (selectedGame.value?.devices || []).find((role) => role.id === param.device)?.required !== false
    || !!deviceMap[param.device]?.length
)))
const controls = computed(() => controlsEnabled({
  authorized: !!status.value.authorized,
  running: !!status.value.snapshot?.running,
  paused: !!status.value.snapshot?.paused,
  connection: status.value.connected === false ? 'reconnecting' : 'live',
}))

function availableDevices(role: any) {
  const required = Array.isArray(role.capabilities) ? role.capabilities : []
  return (status.value.devices || []).filter((device) => device.connected !== false
    && required.every((capability: string) => device.capabilities?.includes(capability)))
}

const blocking = computed(() => {
  if (!selectedGame.value) return [t('remoteGame.pickGame')]
  const items: string[] = []
  for (const role of selectedGame.value.devices || []) {
    const ids = deviceMap[role.id] || []
    if (role.required && !ids.length) items.push(t('playConfig.requiredUnmapped', { role: role.label || role.id }))
    for (const id of ids) {
      if (!availableDevices(role).some((device) => device.id === id)) {
        items.push(t('playConfig.deviceOffline', { role: role.label || role.id }))
      }
    }
  }
  for (const spec of selectedGame.value.params || []) {
    const value = params[spec.key]
    if (spec.required && (value === undefined || value === null || value === '')) items.push(t('playConfig.paramRequired', { name: spec.label || spec.key }))
    if (spec.type === 'number' && value !== undefined && (!Number.isFinite(Number(value))
      || (spec.min !== undefined && Number(value) < spec.min)
      || (spec.max !== undefined && Number(value) > spec.max))) items.push(t('playConfig.paramTypeNumber', { key: spec.label || spec.key }))
  }
  if (gameId.value === 'pressure-edging-v2' && Number(params.midPressure) >= Number(params.criticalPressure)) {
    items.push(t('remoteGame.thresholdOrder'))
  }
  return items
})

function configKey(id: string) { return `gameConfig:remote:${id}` }

function resetParams() {
  for (const key of Object.keys(params)) delete params[key]
  for (const spec of selectedGame.value?.params || []) params[spec.key] = spec.default
}

function configureGame(id: string) {
  for (const key of Object.keys(deviceMap)) delete deviceMap[key]
  resetParams()
  const game = hostGames.value.find((item) => item.id === id)
  if (!game) return
  configuredGameId = id
  localStorage.setItem('remoteGame:selectedGame', id)
  let saved: any = null
  try { saved = JSON.parse(localStorage.getItem(configKey(id)) || 'null') } catch (_) {}
  for (const role of game.devices || []) {
    const options = availableDevices(role)
    const prior = saved?.deviceMap?.[role.id]
    deviceMap[role.id] = Array.isArray(prior)
      ? prior.filter((deviceId: string) => options.some((device) => device.id === deviceId))
      : (options[0] ? [options[0].id] : [])
  }
  for (const spec of game.params || []) {
    if (saved?.params?.[spec.key] !== undefined) params[spec.key] = saved.params[spec.key]
  }
}

watch(gameId, (id) => { configureGame(id) })

async function refresh() {
  loading.value = true
  try {
    status.value = await getRemoteGameStatus()
    if (status.value.snapshot?.running && status.value.snapshot.gameId) gameId.value = status.value.snapshot.gameId
    if (!hostGames.value.some((game) => game.id === gameId.value)) gameId.value = hostGames.value[0]?.id || ''
    if (gameId.value && configuredGameId !== gameId.value) configureGame(gameId.value)
  } catch (e: any) {
    error.value = e?.message || t('remote.loadFailed')
  } finally {
    loading.value = false
  }
}

async function create() {
  busy.value = true
  try { status.value = await createRemoteGame(); error.value = '' } catch (e: any) { error.value = e?.message || t('remote.createFailed') }
  finally { busy.value = false }
}

async function join() {
  busy.value = true
  try { status.value = await joinRemoteGame(joinCode.value.trim()); await refresh(); error.value = '' } catch (e: any) { error.value = e?.message || t('remote.joinFailed') }
  finally { busy.value = false }
}

async function toggleAuth() {
  try { status.value = status.value.authorized ? await revokeRemoteGame() : await authorizeRemoteGame(); error.value = '' }
  catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
}

async function leave() {
  try { status.value = await stopRemoteGame(); error.value = '' }
  catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
}

async function startGame() {
  if (blocking.value.length || busy.value) return
  busy.value = true
  try {
    await sendRemoteGameCommand('game.start', { gameId: gameId.value, deviceMap: { ...deviceMap }, params: { ...params } })
    localStorage.setItem(configKey(gameId.value), JSON.stringify({ deviceMap, params }))
    error.value = ''
    await refresh()
  } catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
  finally { busy.value = false }
}

async function saveParams(value: Record<string, unknown>) {
  try {
    if (status.value.snapshot?.running) await sendRemoteGameCommand('game.setParams', { params: value })
    Object.assign(params, value)
    error.value = ''
    await refresh()
  } catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
}

async function sendAction(name: string, payload?: unknown) {
  const type = name === 'stop' ? 'game.stop' : name === 'pause' ? 'game.pause' : name === 'resume' ? 'game.resume' : 'game.action'
  const body = type === 'game.action' ? { action: name, payload } : undefined
  try { await sendRemoteGameCommand(type, body); error.value = ''; await refresh() }
  catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => { void refresh() }, 2000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.remote-game { display: grid; gap: 16px; margin-top: 20px; padding: 20px; border: 1px solid #dbe4ef; border-radius: 18px; background: linear-gradient(135deg, #f8fbff, #eef4fb); }
.remote-game.standalone { max-width: 960px; margin: 0 auto; padding: 24px; border: 1px solid #dbe4ef; box-shadow: 0 8px 30px rgba(30, 64, 175, .08); }
.head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.eyebrow { display: block; margin-bottom: 4px; color: #64748b; font-size: 11px; letter-spacing: .08em; }
.head h2 { margin: 0; font-size: 22px; color: #0f172a; }
.head p, .muted { margin: 4px 0 0; color: var(--el-text-color-secondary); }
.remote-steps { display: flex; flex-wrap: wrap; gap: 8px; }
.step { padding: 6px 10px; border: 1px solid #dbe4ef; border-radius: 99px; color: #64748b; background: rgba(255,255,255,.72); font-size: 12px; }
.step.current { border-color: #93c5fd; color: #1d4ed8; background: #eff6ff; font-weight: 600; }
.mode, .join, .session { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.session { padding: 10px 12px; border: 1px solid #dbe4ef; border-radius: 12px; background: rgba(255,255,255,.78); }
.join .el-input { flex: 1; min-width: 180px; }
.setup { display: grid; gap: 16px; }
.setup-section { border-top: 1px solid var(--el-border-color-lighter); padding-top: 12px; }
.setup-section h3 { margin: 0 0 10px; font-size: 15px; }
.game-select { width: min(100%, 360px); }
.map-row { display: grid; grid-template-columns: minmax(150px, 210px) 1fr; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.role-name { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.device-options { display: flex; gap: 8px 16px; align-items: center; flex-wrap: wrap; }
.start-row { display: flex; justify-content: flex-end; }
@media (max-width: 650px) { .map-row { grid-template-columns: 1fr; gap: 6px; } }
</style>
