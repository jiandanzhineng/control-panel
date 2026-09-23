<template>
  <section class="remote-game">
    <div class="head">
      <div>
        <h2>{{ t('remoteGame.title') }}</h2>
        <p>{{ t('remoteGame.desc') }}</p>
      </div>
      <el-button :icon="Refresh" circle :loading="loading" @click="refresh" />
    </div>
    <el-alert v-if="error" type="error" :title="error" show-icon @close="error = ''" />
    <p class="hint">{{ t('remoteGame.noRaw') }}</p>

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
        v-if="status.role === 'owner'"
        source="local"
        embedded
        :navigate-on-end="false"
      />

      <template v-else>
        <el-alert v-if="!status.authorized" type="info" :closable="false" :title="t('gameRuntime.waitAuth')" show-icon />
        <div v-else class="setup">
          <el-select v-model="gameId" :placeholder="t('remoteGame.games')">
            <el-option v-for="game in status.games || []" :key="game.id" :label="game.title || game.id" :value="game.id" />
          </el-select>
          <div v-for="device in selectedGame?.devices || []" :key="device.id" class="map-row">
            <span>{{ device.label || device.id }}</span>
            <el-select v-model="deviceMap[device.id]" clearable :placeholder="t('remoteGame.map')">
              <el-option v-for="item in status.devices || []" :key="item.id" :label="item.name || item.id" :value="item.id" />
            </el-select>
          </div>
          <PlayParamsForm
            v-if="selectedGame"
            :params="selectedGame.params || []"
            :model="params"
            :disabled="!controls.params"
            :submit-text="t('gameRuntime.saveParams')"
            @submit="saveParams"
          />
          <el-button type="primary" :disabled="!controls.start" @click="startGame">{{ t('remoteGame.start') }}</el-button>
        </div>
        <GameRuntimeView
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
const mode = ref<'owner' | 'operator'>('owner')
const joinCode = ref('')
const status = ref<RemoteGameStatus>({ active: false })
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const gameId = ref('')
const deviceMap = reactive<Record<string, string>>({})
const params = reactive<Record<string, any>>({})
let timer: ReturnType<typeof setInterval> | null = null

const selectedGame = computed(() => (status.value.games || []).find((game) => game.id === gameId.value))
const controls = computed(() => controlsEnabled({
  authorized: !!status.value.authorized,
  running: !!status.value.snapshot?.running,
  paused: !!status.value.snapshot?.paused,
  connection: status.value.connected === false ? 'reconnecting' : 'live',
}))

watch(selectedGame, (game) => {
  for (const key of Object.keys(params)) delete params[key]
  for (const item of game?.params || []) {
    if (item.default !== undefined) params[item.key] = item.default
  }
})

async function refresh() {
  loading.value = true
  try {
    status.value = await getRemoteGameStatus()
    if (!gameId.value && status.value.games?.length) gameId.value = status.value.games[0].id
    error.value = ''
  } catch (e: any) {
    error.value = e?.message || t('remote.loadFailed')
  } finally {
    loading.value = false
  }
}

async function create() {
  busy.value = true
  try { status.value = await createRemoteGame() } catch (e: any) { error.value = e?.message || t('remote.createFailed') }
  finally { busy.value = false }
}

async function join() {
  busy.value = true
  try { status.value = await joinRemoteGame(joinCode.value.trim()) } catch (e: any) { error.value = e?.message || t('remote.joinFailed') }
  finally { busy.value = false }
}

async function toggleAuth() {
  status.value = status.value.authorized ? await revokeRemoteGame() : await authorizeRemoteGame()
}

async function leave() {
  status.value = await stopRemoteGame()
}

async function startGame() {
  const mapping: Record<string, string[]> = {}
  for (const [role, id] of Object.entries(deviceMap)) if (id) mapping[role] = [id]
  await sendRemoteGameCommand('game.start', { gameId: gameId.value, deviceMap: mapping, params: { ...params } })
  await refresh()
}

async function saveParams(value: Record<string, unknown>) {
  Object.assign(params, value)
  if (status.value.snapshot?.running) {
    await sendRemoteGameCommand('game.setParams', { params: value })
    await refresh()
  }
}

async function sendAction(name: string, payload?: unknown) {
  const type = name === 'stop' ? 'game.stop' : name === 'pause' ? 'game.pause' : name === 'resume' ? 'game.resume' : 'game.action'
  const body = type === 'game.action' ? { action: name, payload } : undefined
  await sendRemoteGameCommand(type, body)
  await refresh()
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => { void refresh() }, 2000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.remote-game { display: grid; gap: 12px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--el-border-color); }
.head { display: flex; justify-content: space-between; gap: 12px; }
.head h2 { margin: 0; }
.head p, .hint { margin: 4px 0 0; color: var(--el-text-color-secondary); }
.mode, .join, .session, .setup, .map-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.map-row { width: 100%; }
.map-row .el-select, .join .el-input { flex: 1; min-width: 180px; }
</style>
