<template>
  <div class="remote-session-page">
    <header class="page-head">
      <span class="eyebrow">CONTROL PANEL / REMOTE SESSION</span>
      <h1>{{ t('remoteSession.title') }}</h1>
      <p>{{ t('remoteSession.desc') }}</p>
    </header>

    <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" />

    <div class="cards">
      <!-- 卡片 A：被控端 -->
      <section class="card" :class="{ 'is-disabled': operatorSideActive }">
        <div class="card-head">
          <h2>{{ t('remoteSession.host.title') }}</h2>
          <el-tag v-if="ui.isHostControlled" size="small" type="warning">{{ t('remoteSession.host.controlled') }}</el-tag>
        </div>

        <p v-if="!ui.isOwner" class="card-desc">{{ t('remoteSession.host.idleDesc') }}</p>

        <!-- idle -->
        <template v-if="!ui.isOwner">
          <el-button type="primary" :loading="busy" :disabled="!authed" @click="onCreate">
            {{ t('remoteSession.host.open') }}
          </el-button>
          <div v-if="!authed" class="hint">
            {{ t('remoteSession.loginRequired') }}
            <el-button link type="primary" @click="router.push('/account')">{{ t('remoteSession.goLogin') }}</el-button>
          </div>
          <div v-if="operatorSideActive" class="hint">{{ t('remoteSession.host.busyOperator') }}</div>
        </template>

        <!-- waiting -->
        <template v-else-if="ui.phase === 'waiting'">
          <div class="join-code">{{ joinCode || '—' }}</div>
          <div class="hint">{{ t('remoteSession.host.waiting') }}</div>
          <div class="actions">
            <el-button :icon="CopyDocument" :disabled="!joinCode" @click="copyCode">{{ t('remoteSession.host.copy') }}</el-button>
            <el-button type="danger" plain :loading="busy" @click="onStop">{{ t('remoteSession.host.stop') }}</el-button>
          </div>
        </template>

        <!-- pending-authorization -->
        <template v-else-if="ui.phase === 'pending-authorization'">
          <div class="peer-row">
            <span class="peer-name">{{ peerName }}</span>
            <span class="peer-id mono">{{ peerUserId }}</span>
          </div>
          <div class="actions">
            <el-button type="primary" :loading="busy" @click="onAuthorize">{{ t('remoteSession.host.allow') }}</el-button>
            <el-button type="danger" plain :loading="busy" @click="onKick">{{ t('remoteSession.host.deny') }}</el-button>
          </div>
        </template>

        <!-- active -->
        <template v-else-if="ui.isHostControlled">
          <div class="peer-row">
            <span class="peer-name">{{ peerName }}</span>
            <el-tag size="small" :type="ui.reconnecting ? 'warning' : 'success'">
              {{ ui.reconnecting ? t('remoteSession.bar.reconnecting') : t('remoteSession.connected') }}
            </el-tag>
          </div>
          <div class="actions">
            <el-button type="danger" :loading="busy" @click="onEmergencyStop">{{ t('remoteSession.bar.emergencyStop') }}</el-button>
            <el-button plain :loading="busy" @click="onKick">{{ t('remoteSession.bar.kick') }}</el-button>
            <el-button plain :loading="busy" @click="onStop">{{ t('remoteSession.host.stop') }}</el-button>
          </div>
          <div class="log-list">
            <div v-if="!logRows.length" class="log-empty">{{ t('remoteSession.log.empty') }}</div>
            <div v-for="(row, index) in logRows" :key="`${row.ts}-${logRows.length - index}`" class="log-row">
              <span class="log-time">{{ formatTime(row.ts) }}</span>
              <span class="log-summary">{{ row.summary }}</span>
              <el-tag v-if="row.outcome === 'clamped'" size="small" type="warning" disable-transitions :title="detailText(row)">
                {{ t('remoteSession.log.clamped') }}
              </el-tag>
              <el-tag v-else-if="row.outcome === 'rejected'" size="small" type="danger" disable-transitions :title="detailText(row)">
                {{ t('remoteSession.log.rejected') }}
              </el-tag>
            </div>
          </div>
        </template>
      </section>

      <!-- 卡片 B：主控端 -->
      <section class="card" :class="{ 'is-disabled': hostSideActive }">
        <div class="card-head">
          <h2>{{ t('remoteSession.operator.title') }}</h2>
          <el-tag v-if="ui.isOperator" size="small" type="primary">{{ t('remoteSession.operator.joined') }}</el-tag>
        </div>

        <p v-if="!ui.isOperator" class="card-desc">{{ t('remoteSession.operator.idleDesc') }}</p>

        <!-- idle -->
        <template v-if="!ui.isOperator">
          <div class="join-row">
            <el-input
              v-model="joinCodeInput"
              :placeholder="t('remoteSession.operator.code')"
              maxlength="64"
              clearable
              :disabled="!authed || hostSideActive"
              @input="normalizeCode"
              @keyup.enter="onJoin"
            />
            <el-button type="primary" :loading="busy" :disabled="!authed || !joinCodeInput" @click="onJoin">
              {{ t('remoteSession.operator.join') }}
            </el-button>
          </div>
          <div v-if="!authed" class="hint">
            {{ t('remoteSession.loginRequired') }}
            <el-button link type="primary" @click="router.push('/account')">{{ t('remoteSession.goLogin') }}</el-button>
          </div>
          <div v-if="hostSideActive" class="hint">{{ t('remoteSession.operator.busyHost') }}</div>
        </template>

        <!-- pending-authorization / waiting -->
        <template v-else-if="!ui.isOperatorRemote">
          <div class="hint">{{ t('remoteSession.operator.pending') }}</div>
          <div class="actions">
            <el-button plain :loading="busy" @click="onStop">{{ t('common.cancel') }}</el-button>
          </div>
        </template>

        <!-- active -->
        <template v-else>
          <div class="peer-row">
            <span class="peer-name">{{ t('remoteSession.operator.controlling', { name: peerName }) }}</span>
            <el-tag size="small" :type="ui.reconnecting ? 'warning' : 'success'">
              {{ ui.reconnecting ? t('remoteSession.bar.reconnecting') : t('remoteSession.connected') }}
            </el-tag>
          </div>
          <div class="actions">
            <el-button type="primary" @click="router.push('/devices')">{{ t('remoteSession.operator.goDevices') }}</el-button>
            <el-button plain :loading="busy" @click="onStop">{{ t('remoteSession.bar.disconnect') }}</el-button>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CopyDocument } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { useRemoteSession } from '../composables/useRemoteSession'
import { useAuth } from '../composables/useAuth'
import { peerLabel, formatClock, detailText as detailTextOf, normalizeJoinCode } from '../remote/remoteSessionFormat'

const { t } = useI18n()
const router = useRouter()
const session = useRemoteSession()
const { authState } = useAuth()

const ui = computed(() => session.ui.value)
const busy = computed(() => session.busy.value)
const error = computed(() => session.error.value)
const authed = computed(() => authState.status === 'authed')
const peerName = computed(() => peerLabel(session.peer.value))
const peerUserId = computed(() => session.peer.value?.userId || '')
const joinCode = computed(() => session.joinCode.value || '')
const logRows = computed(() => [...session.log.value].reverse())
const formatTime = formatClock
const detailText = detailTextOf
const joinCodeInput = ref('')

// 同一时刻只有一种身份：一侧非 idle 时另一侧整卡置灰
const hostSideActive = computed(() => ui.value.isHostControlled || (ui.value.isOwner && ui.value.phase === 'pending-authorization'))
const operatorSideActive = computed(() => ui.value.isOperator)

function normalizeCode(value: string) {
  joinCodeInput.value = normalizeJoinCode(value)
}

function fail(e: any) {
  ElMessage.error(e?.message || t('remoteSession.commandFailed'))
}

async function onCreate() {
  try { await session.create() } catch (e: any) { fail(e) }
}

async function onJoin() {
  const code = normalizeJoinCode(joinCodeInput.value)
  if (!code) return
  try { await session.join(code) } catch (e: any) { fail(e) }
}

async function onAuthorize() {
  try { await session.authorize(peerUserId.value || undefined) } catch (e: any) { fail(e) }
}

async function onKick() {
  const userId = peerUserId.value
  if (!userId) return
  try {
    await ElMessageBox.confirm(t('remoteSession.host.kickConfirm', { name: peerName.value || userId }), t('remoteSession.host.kickTitle'), {
      type: 'warning',
      confirmButtonText: t('common.ok'),
      cancelButtonText: t('common.cancel'),
    })
  } catch (_) { return }
  try { await session.kick(userId) } catch (e: any) { fail(e) }
}

async function onEmergencyStop() {
  try { await session.emergencyStop() } catch (e: any) { fail(e) }
}

async function onStop() {
  // 本端主动结束/取消/断开：用本端原因，结束提示不弹（'session-stop' 会被当成「对方已结束远程」）
  const reason = session.role.value === 'owner' ? 'host-stop' : 'operator-stop'
  try { await session.stopSession(reason) } catch (e: any) { fail(e) }
}

async function copyCode() {
  if (!joinCode.value) return
  try {
    await navigator.clipboard.writeText(joinCode.value)
    ElMessage.success(t('remoteSession.host.copied'))
  } catch (_) { ElMessage.warning(t('remoteSession.host.copyFailed')) }
}
</script>

<style scoped>
.remote-session-page { max-width: 960px; margin: 0 auto; display: grid; gap: 16px; }
.page-head .eyebrow { display: block; font-size: 11px; letter-spacing: 0.08em; color: var(--text-faint); }
.page-head h1 { margin: 4px 0; font-size: 22px; color: var(--text-primary); }
.page-head p { margin: 0; color: var(--text-muted); font-size: 13px; }
.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.card {
  display: grid;
  gap: 12px;
  padding: 18px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
}
.card.is-disabled { opacity: 0.5; pointer-events: none; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-head h2 { margin: 0; font-size: 16px; color: var(--text-primary); }
.card-desc { margin: 0; color: var(--text-muted); font-size: 13px; }
.hint { color: var(--text-muted); font-size: 13px; }
.actions, .join-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.join-row .el-input { flex: 1; min-width: 160px; }
.join-code { font-family: var(--font-mono); font-size: 36px; letter-spacing: 0.2em; color: var(--text-primary); }
.peer-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.peer-name { color: var(--text-primary); }
.peer-id { color: var(--text-faint); font-size: 12px; }
.log-list { max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.log-empty { color: var(--text-faint); font-size: 13px; }
.log-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.log-time { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text-faint); flex-shrink: 0; }
.log-summary { flex: 1; color: var(--text-secondary); word-break: break-all; }

@media (max-width: 820px) {
  .cards { grid-template-columns: 1fr; }
}
</style>

