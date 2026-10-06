<template>
  <div v-if="visible" class="remote-bar-wrap">
    <div class="remote-bar" :class="roleClass">
      <span class="remote-bar__stripe" />
      <span class="remote-bar__dot" :class="toneClass" />
      <span class="remote-bar__text">{{ text }}</span>
      <span v-if="latencyText" class="remote-bar__latency">{{ latencyText }}</span>
      <span class="remote-bar__spacer" />

      <el-popover
        v-if="ui.isHostControlled"
        placement="bottom-end"
        :width="420"
        trigger="click"
        popper-class="remote-log-popper"
      >
        <template #reference>
          <el-button size="small" plain>
            {{ t('remoteSession.bar.opLog') }}
            <el-icon class="remote-bar__caret"><ArrowDown /></el-icon>
          </el-button>
        </template>
        <div class="remote-log">
          <div v-if="!logRows.length" class="remote-log__empty">{{ t('remoteSession.log.empty') }}</div>
          <div v-for="(row, index) in logRows" :key="index" class="remote-log__row">
            <span class="remote-log__time">{{ formatTime(row.ts) }}</span>
            <span class="remote-log__summary">{{ row.summary }}</span>
            <el-tag v-if="row.outcome === 'clamped'" size="small" type="warning" :title="detailText(row)">
              {{ t('remoteSession.log.clamped') }}
            </el-tag>
            <el-tag v-else-if="row.outcome === 'rejected'" size="small" type="danger" :title="detailText(row)">
              {{ t('remoteSession.log.rejected') }}
            </el-tag>
          </div>
        </div>
      </el-popover>

      <el-button
        v-if="ui.isHostControlled || ui.isOperator"
        size="small"
        type="danger"
        :loading="busy"
        :disabled="!authorized"
        @click="onEmergencyStop"
      >
        {{ t('remoteSession.bar.emergencyStop') }}
      </el-button>
      <template v-if="ui.isHostControlled">
        <el-button size="small" plain :loading="busy" @click="onKick">
          {{ t('remoteSession.bar.kick') }}
        </el-button>
      </template>
      <template v-else-if="ui.isOperator">
        <el-button size="small" plain :loading="busy" @click="onStop">
          {{ t('remoteSession.bar.disconnect') }}
        </el-button>
      </template>
      <template v-else-if="ui.isOwner">
        <el-button size="small" type="primary" :loading="busy" @click="onAuthorize">
          {{ t('remoteSession.host.allow') }}
        </el-button>
        <el-button size="small" type="danger" plain :loading="busy" @click="onKick">
          {{ t('remoteSession.host.deny') }}
        </el-button>
      </template>
    </div>

    <div v-if="showMask" class="remote-mask" />
    <div v-if="showMask" class="remote-mask__text">{{ t('remoteSession.bar.mask') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessageBox, ElMessage } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import { useRemoteSession } from '../composables/useRemoteSession'
import { barVisible } from '../remote/remoteSessionState'
import { peerLabel, formatClock, detailText as detailTextOf } from '../remote/remoteSessionFormat'
import { endReasonKey, shouldAutoReturn } from '../remote/remoteEnded'
import { playEndedMessageKey, preemptedLocalPlay, playLabel } from '../remote/remotePlay'
import { router } from '../router'

const { t } = useI18n()
const session = useRemoteSession()

const ui = computed(() => session.ui.value)
const visible = computed(() => barVisible(ui.value))
const busy = computed(() => session.busy.value)
const authorized = computed(() => session.authorized.value)
const showMask = computed(() => ui.value.isOperator && ui.value.reconnecting)

const roleClass = computed(() => (ui.value.isOperator ? 'is-operator' : 'is-host'))
const toneClass = computed(() => `is-${ui.value.tone}`)

const peerName = computed(() => peerLabel(session.peer.value))
const text = computed(() => {
  const name = peerName.value
  if (ui.value.isOperator) {
    const base = t('remoteSession.bar.operator', { name })
    return ui.value.reconnecting ? `${base} · ${t('remoteSession.bar.reconnecting')}` : base
  }
  const base = t('remoteSession.bar.host', { name })
  const line = ui.value.reconnecting ? `${base} · ${t('remoteSession.bar.reconnecting')}` : base
  const occupancy = ui.value.isHostControlled ? session.occupancy.value : null
  return occupancy ? `${line} · ${t('remoteSession.bar.occupancy', { name, game: playLabel(occupancy) })}` : line
})
const latencyText = computed(() => {
  const value = session.latencyMs.value
  return Number.isFinite(Number(value)) ? t('remoteSession.bar.latency', { n: value }) : ''
})
// 操作记录最新在上
const logRows = computed(() => [...session.log.value].reverse())
const formatTime = formatClock
const detailText = detailTextOf

async function onEmergencyStop() {
  try { await session.emergencyStop() } catch (error: any) { ElMessage.error(error?.message || t('remoteSession.commandFailed')) }
}

async function onKick() {
  const userId = session.peer.value?.userId || ''
  if (!userId) return
  try {
    await ElMessageBox.confirm(t('remoteSession.host.kickConfirm', { name: peerName.value || userId }), t('remoteSession.host.kickTitle'), {
      type: 'warning',
      confirmButtonText: t('common.ok'),
      cancelButtonText: t('common.cancel'),
    })
  } catch (_) { return }
  try { await session.kick(userId) } catch (error: any) { ElMessage.error(error?.message || t('remoteSession.commandFailed')) }
}

async function onStop() {
  try { await session.stopSession('operator-stop') } catch (error: any) { ElMessage.error(error?.message || t('remoteSession.commandFailed')) }
}

async function onAuthorize() {
  const userId = session.peer.value?.userId || ''
  if (!userId) return
  try { await session.authorize(userId) } catch (error: any) { ElMessage.error(error?.message || t('remoteSession.commandFailed')) }
}

// 会话结束：按原因弹一次说明；主控端随后回远程连接页
watch(() => session.endedAt.value, async (at) => {
  if (!at) return
  const role = session.endedRole.value
  const reason = session.endedReason.value
  session.clearEnded()
  const key = endReasonKey(reason)
  if (key === 'none') return
  await ElMessageBox.alert(t(`remoteSession.end.${key}`), t('remoteSession.end.title'), {
    type: 'warning',
    confirmButtonText: t('common.ok'),
  }).catch(() => {})
  if (shouldAutoReturn(role, router.currentRoute.value.path)) router.push('/remote')
})

// 主控端本机玩法被被控端结束（本地玩法顶替 / 被控端停止或急停）：停掉本机游戏并提示，
// 在游戏页则退回玩法页。提示文案按原因区分（playEndedReason）。
watch(() => session.localPlay.value, async (next, previous) => {
  try {
    const play = preemptedLocalPlay(previous, next)
    if (!play) return
    const message = t(playEndedMessageKey(session.playEndedReason.value), { game: playLabel(play) })
    await ElMessageBox.alert(message, t('remoteSession.end.title'), { type: 'warning' }).catch(() => {})
    await stopLocalPlay(play.gameId)
    const path = router.currentRoute.value.path
    if (path === '/plays/game/current' || path === '/plays/game/runtime') router.push('/plays')
  } catch (_) { /* 提示失败不影响远程条 */ }
})

// 停掉主控端本机正在运行的玩法（bridge 或 HostRuntime），并释放占用
async function stopLocalPlay(gameId?: string) {
  await fetch('/api/games/stop-current', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gameId }),
  }).catch(() => {})
}

// 主控端授权成功：自动进一次设备页（远程设备就在那里）
let navigatedForSession = false
watch(() => [ui.value.isOperatorRemote, ui.value.live], ([remote, live]) => {
  if (!live) { navigatedForSession = false; return }
  if (!remote || navigatedForSession) return
  navigatedForSession = true
  if (shouldAutoReturn('operator', router.currentRoute.value.path)) router.push('/devices')
}, { immediate: true })

onMounted(() => { session.start() })
onUnmounted(() => { session.stop() })
</script>

<style scoped>
.remote-bar-wrap { position: sticky; top: 0; z-index: 20; flex-shrink: 0; }

.remote-bar {
  height: 36px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  border-bottom: 1px solid var(--border-subtle);
}

.remote-bar.is-operator { background: var(--accent-glow); }
.remote-bar.is-host { background: var(--remote-host-bg); }

.remote-bar__stripe { width: 3px; height: 18px; border-radius: 2px; flex-shrink: 0; }
.is-operator .remote-bar__stripe { background: var(--accent); }
.is-host .remote-bar__stripe { background: #f5a524; }

.remote-bar__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.remote-bar__dot.is-ok { background: #22c55e; }
.remote-bar__dot.is-off { background: #ef4444; }
.remote-bar__dot.is-warn { background: #f5a524; animation: remote-pulse 1.2s ease-in-out infinite; }

@keyframes remote-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.remote-bar__text { color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.remote-bar__latency { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text-muted); }
.remote-bar__spacer { flex: 1; }
.remote-bar__caret { margin-left: 2px; }

/* 操作记录面板：最新在上，最高 360px 滚动 */
.remote-log { max-height: 360px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.remote-log__empty { color: var(--text-faint); font-size: 13px; padding: 8px 0; }
.remote-log__row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.remote-log__time { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text-faint); flex-shrink: 0; }
.remote-log__summary { flex: 1; color: var(--text-secondary); word-break: break-all; }

/* 重连遮罩：主控端整页禁操作 */
.remote-mask { position: fixed; inset: 0; z-index: 19; background: var(--mask-color); opacity: 0.35; }
.remote-mask__text {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 21;
  padding: 8px 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 13px;
}

@media (max-width: 768px) {
  .remote-bar { padding: 0 10px; gap: 6px; }
  .remote-bar__text { font-size: 12px; }
  .remote-bar__latency { display: none; }
}
</style>
