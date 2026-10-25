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

      <!-- 授权对象：授权绑定到具体 userId，房主必须看得见对方是谁 -->
      <div v-if="status.role === 'owner' && operatorRows.length" class="operators">
        <div class="operators-head">{{ t('remoteGame.members') }}</div>
        <div v-for="row in operatorRows" :key="row.userId" class="operator-row">
          <span class="operator-id">{{ row.displayName }}</span>
          <el-tag size="small" :type="row.online ? 'success' : 'info'">
            {{ row.online ? t('remoteGame.online') : t('remoteGame.offline') }}
          </el-tag>
          <el-tag v-if="row.authorized" size="small" type="warning">{{ t('remoteGame.authorized') }}</el-tag>
          <el-button size="small" type="danger" plain :loading="busy" @click="kick(row.userId)">
            {{ t('remoteGame.kick') }}
          </el-button>
        </div>
      </div>

      <RemoteDevicePanel
        v-if="status.authorized"
        :devices="status.devices || []"
        :authorized="!!status.authorized"
        :connected="status.connected !== false"
        :busy="busy"
        :running="!!status.snapshot?.running"
        :members="memberRows"
        :authorized-user-id="status.role === 'owner' ? (status.operatorUserId || null) : null"
        @authorize="authorizeMember"
        @revoke="revokeMember"
        @kick="kick"
        @command="sendDeviceCommand"
      />

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
          :connection="connection"
          :snapshot="status.snapshot || null"
          :params-schema="selectedGame?.params || []"
          :page-path="operatorPagePath"
          @params="saveParams"
        />
        <div v-if="status.snapshot?.running" class="start-row">
          <el-button type="danger" plain :disabled="status.role === 'operator' && !status.authorized" @click="stopRunningGame">
            {{ t('remoteGame.stopGame') }}
          </el-button>
        </div>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Refresh } from '@element-plus/icons-vue'
import PlayParamsForm from './PlayParamsForm.vue'
import RemoteDevicePanel from './RemoteDevicePanel.vue'
import GameRuntimeView from '../views/GameRuntimeView.vue'
import { stopGameRuntime } from '../api/gameRuntime'
import { resolveGamePagePath } from '../play/gamePagePath'
import { createGameStateStream, type GameStateStreamHandle } from '../play/gameStateStreamClient'
import {
  authorizeRemoteGame,
  createRemoteGame,
  getRemoteGameRoom,
  getRemoteGameStatus,
  joinRemoteGame,
  kickRemoteGameMember,
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
let stream: GameStateStreamHandle | null = null
let configuredGameId = ''
const connection = ref<'live' | 'reconnecting'>('live')

const hostGames = computed(() => (status.value.games || []).filter((game) => game.runtimeMode === 'host'))
const selectedGame = computed(() => hostGames.value.find((game) => game.id === gameId.value))
const operatorPagePath = ref('')
let resolvingPageFor = ''
let pagePathFor = ''

// 房主侧操作方列表：userId + 房间成员里的显示名 + 授权状态
const memberNames = computed<Record<string, string>>(() => {
  const rows: Record<string, string> = {}
  for (const member of status.value.members || []) {
    const name = (member as any).displayName || (member as any).name || (member as any).nickname
    if (member?.userId && name) rows[member.userId] = String(name)
  }
  return rows
})
const operatorRows = computed(() => (status.value.operators || []).map((row) => ({
  ...row,
  displayName: memberNames.value[row.userId] || row.userId,
})))
// RemoteDevicePanel 的成员/授权区（房主用；操作方看不到别人的 userId）
const memberRows = computed(() => (status.value.role === 'owner' ? operatorRows.value : []))
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

function applyStatus(next: any) {
  status.value = next || { active: false }
  if (status.value.snapshot?.running && status.value.snapshot.gameId) gameId.value = status.value.snapshot.gameId
  if (!hostGames.value.some((game) => game.id === gameId.value)) gameId.value = hostGames.value[0]?.id || ''
  if (gameId.value && configuredGameId !== gameId.value) configureGame(gameId.value)
}

// 状态来自 SSE（先全量后增量）；失败由流客户端自己回落轮询，这里只负责兜错
async function refresh() {
  loading.value = true
  try {
    applyStatus(await getRemoteGameStatus())
    error.value = ''
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
  busy.value = true
  try { status.value = status.value.authorized ? await revokeRemoteGame() : await authorizeRemoteGame(); error.value = '' }
  catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
  finally { busy.value = false }
}

async function kick(userId: string) {
  if (busy.value) return
  busy.value = true
  try {
    status.value = await kickRemoteGameMember(userId)
    error.value = ''
    await refresh()
  } catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
  finally { busy.value = false }
}

// 按成员授权：房间容量是 2，同一时刻只有一个非房主成员，服务端 authorize()
// 绑定到该成员；这里再核对一次绑定对象，避免万一授权给别人。
async function authorizeMember(userId: string) {
  if (busy.value) return
  busy.value = true
  try {
    const next = await authorizeRemoteGame()
    status.value = next
    if (next.operatorUserId && next.operatorUserId !== userId) {
      error.value = t('remoteGame.authorizeFailed')
    } else {
      error.value = ''
    }
    await refresh()
  } catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
  finally { busy.value = false }
}

async function revokeMember() {
  if (busy.value) return
  busy.value = true
  try { status.value = await revokeRemoteGame(); error.value = '' }
  catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
  finally { busy.value = false }
}

async function leave() {
  busy.value = true
  try { status.value = await stopRemoteGame(); error.value = '' }
  catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
  finally { busy.value = false }
}

async function startGame() {
  if (blocking.value.length || busy.value) return
  busy.value = true
  try {
    await sendRemoteGameCommand('game.start', { gameId: gameId.value, gameName: selectedGame.value?.title || undefined, deviceMap: { ...deviceMap }, params: { ...params } })
    localStorage.setItem(configKey(gameId.value), JSON.stringify({ deviceMap, params }))
    error.value = ''
    await refresh()
  } catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
  finally { busy.value = false }
}

async function saveParams(value: Record<string, unknown>) {
  try {
    if (status.value.snapshot?.running) {
      await sendRemoteGameCommand('game.setParams', { params: value, gameSessionId: status.value.gameSessionId || undefined })
    }
    Object.assign(params, value)
    error.value = ''
    await refresh()
  } catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
}

async function stopRunningGame() {
  if (busy.value) return
  busy.value = true
  try {
    if (status.value.role === 'owner') await stopGameRuntime('user_stop')
    else await sendRemoteGameCommand('game.stop', { gameSessionId: status.value.gameSessionId || undefined, gameId: status.value.snapshot?.gameId || gameId.value || undefined, gameName: selectedGame.value?.title || undefined })
    error.value = ''
    await refresh()
  } catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
  finally { busy.value = false }
}

// 远程主控侧：游戏页面也在本机 iframe 加载（与设备端同一套原始 UI），需要本机有游戏包。
// 注册表游戏首次要下载安装，可能几秒；同一 gameId 只允许一个解析在飞（否则并发安装会互相覆盖），
// 失败时自动重试再报错（F5：首次启动不出 iframe）。
async function ensureOperatorPage(id: string) {
  if (!id) return
  if (resolvingPageFor === id) return
  if (operatorPagePath.value && pagePathFor === id) return
  resolvingPageFor = id
  let attempt = 0
  while (attempt < 3) {
    attempt += 1
    try {
      const path = await resolveGamePagePath(id)
      if (path) {
        operatorPagePath.value = path
        pagePathFor = id
        error.value = ''
        resolvingPageFor = ''
        return
      }
    } catch (_) { /* 继续重试 */ }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
  }
  operatorPagePath.value = ''
  pagePathFor = ''
  resolvingPageFor = ''
  error.value = t('gameRuntime.pageUnavailable')
}

watch(() => [status.value.role, status.value.snapshot?.gameId, status.value.snapshot?.running], () => {
  const id = status.value.snapshot?.gameId || ''
  if (status.value.role !== 'operator' || !status.value.snapshot?.running || !id) {
    operatorPagePath.value = ''
    resolvingPageFor = ''
    pagePathFor = ''
    return
  }
  void ensureOperatorPage(id)
})

async function sendDeviceCommand(type: string, payload: Record<string, unknown>) {
  if (busy.value) return
  busy.value = true
  try { await sendRemoteGameCommand(type, payload); error.value = ''; await refresh() }
  catch (e: any) { error.value = e?.message || t('remoteGame.commandFailed') }
  finally { busy.value = false }
}

// 房主打开时拉一次房间成员，用于显示操作方身份
async function refreshMembers() {
  if (status.value.role !== 'owner') return
  try {
    const room = await getRemoteGameRoom()
    if (Array.isArray(room?.members)) status.value.members = room.members
  } catch (_) { /* 成员信息是增强项，失败不报错 */ }
}

onMounted(() => {
  void refresh().then(() => refreshMembers())
  // 状态走推送（SSE snapshot+patch）；EventSource 不可用时自动回落轮询
  stream = createGameStateStream({
    url: '/api/remote-game/stream',
    poll: () => getRemoteGameStatus(),
    onState: (next) => applyStatus(next),
    onConnection: (state) => { connection.value = state },
  })
  stream.start()
})
onUnmounted(() => {
  stream?.stop()
  stream = null
  if (timer) clearInterval(timer)
})
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
.operators { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid #dbe4ef; border-radius: 12px; background: rgba(255,255,255,.78); }
.operators-head { color: #64748b; font-size: 12px; letter-spacing: .04em; }
.operator-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.operator-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #0f172a; }
.setup-section { border-top: 1px solid var(--el-border-color-lighter); padding-top: 12px; }
.setup-section h3 { margin: 0 0 10px; font-size: 15px; }
.game-select { width: min(100%, 360px); }
.map-row { display: grid; grid-template-columns: minmax(150px, 210px) 1fr; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.role-name { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.device-options { display: flex; gap: 8px 16px; align-items: center; flex-wrap: wrap; }
.start-row { display: flex; justify-content: flex-end; }
@media (max-width: 650px) { .map-row { grid-template-columns: 1fr; gap: 6px; } }
</style>
