<template>
  <details class="remote-devices">
    <summary>{{ t('devices.list') }} · {{ devices.length }}</summary>
    <p class="hint">{{ text('控制设备所在端的设备', 'Manage devices on the host') }}</p>

    <!-- 授权绑定到具体账号：新成员默认无权限。仅在宿主面板传入 members 时渲染。 -->
    <div v-if="members.length" class="member-block">
      <p class="hint">
        {{ authorizedUserId
          ? text(`已授权 ${authorizedUserId} 控制设备`, `Authorized: ${authorizedUserId}`)
          : text('等待房主授权后才能控制设备', 'Waiting for the host to authorize this account') }}
      </p>
      <div v-for="member in members" :key="member.userId" class="member-row">
        <strong>{{ member.userId }}</strong>
        <el-tag :type="member.online ? 'success' : 'info'" size="small" effect="plain">
          {{ member.online ? text('在线', 'Online') : text('离线', 'Offline') }}
        </el-tag>
        <el-tag v-if="member.authorized" type="warning" size="small">{{ text('已授权', 'Authorized') }}</el-tag>
        <el-button v-if="!member.authorized" type="primary" size="small" :disabled="disabled" @click="emit('authorize', member.userId)">
          {{ text('授权控制', 'Authorize') }}
        </el-button>
        <el-button v-else size="small" :disabled="disabled" @click="emit('revoke')">
          {{ text('撤销授权', 'Revoke') }}
        </el-button>
        <el-button type="danger" plain size="small" :disabled="disabled" @click="emit('kick', member.userId)">
          {{ text('移出房间', 'Remove') }}
        </el-button>
      </div>
    </div>

    <div v-for="device in devices" :key="device.id" class="device-row">
      <div class="device-heading">
        <strong>{{ device.name || device.id }}</strong>
        <el-tag :type="device.connected ? 'success' : 'info'" size="small">{{ device.connected ? text('在线', 'Online') : text('离线', 'Offline') }}</el-tag>
        <span class="hint">{{ device.type }}</span>
      </div>
      <div class="actions">
        <el-input v-model="names[device.id]" :placeholder="text('设备昵称', 'Device name')" :disabled="disabled" :aria-label="text('设备昵称', 'Device name')" maxlength="80" />
        <el-button :disabled="disabled || !names[device.id]?.trim()" @click="send('devices.rename', { deviceId: device.id, name: names[device.id].trim() })">{{ text('保存昵称', 'Save name') }}</el-button>
        <el-button v-if="device.connected" :disabled="disabled" type="danger" plain @click="send('devices.stop', { deviceId: device.id })">{{ text('停止设备', 'Stop device') }}</el-button>
        <el-button v-if="device.connected" :disabled="disabled" @click="send('devices.disconnect', { deviceId: device.id })">{{ text('断开', 'Disconnect') }}</el-button>
      </div>
      <div v-if="device.connected && device.capabilities?.includes('strength')" class="strength-row">
        <span>{{ text('强度', 'Intensity') }}</span>
        <el-slider v-model="strengths[device.id]" :min="0" :max="255" :disabled="disabled || running" @change="value => send('devices.invoke', { deviceId: device.id, capability: 'strength', action: 'set', input: { value } })" />
        <output>{{ strengths[device.id] || 0 }}</output>
      </div>
    </div>
    <p v-if="!devices.length" class="hint">{{ text('主机暂无设备', 'No devices on the host') }}</p>
    <p v-if="running" class="hint">{{ text('游戏运行时由游戏控制强度；停止设备会先结束本局。', 'The game controls intensity while running. Stopping a device ends the game first.') }}</p>
  </details>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
const props = defineProps<{
  devices: Array<{ id: string; name?: string; type?: string; connected?: boolean; capabilities?: string[] }>
  authorized: boolean
  connected: boolean
  busy: boolean
  running: boolean
  members?: Array<{ userId: string; online?: boolean; authorized?: boolean }>
  authorizedUserId?: string | null
}>()
const emit = defineEmits<{
  command: [type: string, payload: Record<string, unknown>]
  authorize: [userId: string]
  revoke: []
  kick: [userId: string]
}>()
const { t, locale } = useI18n()
const text = (zh: string, en: string) => locale.value.startsWith('zh') ? zh : en
const names = reactive<Record<string, string>>({})
const strengths = reactive<Record<string, number>>({})
const members = computed(() => props.members || [])
const authorizedUserId = computed(() => props.authorizedUserId || null)
const disabled = computed(() => !props.authorized || !props.connected || props.busy)
function send(type: string, payload: Record<string, unknown>) { if (!disabled.value) emit('command', type, payload) }
</script>

<style scoped>
.remote-devices { padding: 14px 16px; border: 1px solid var(--el-border-color); border-radius: 12px; background: var(--el-bg-color); }
summary { cursor: pointer; font-weight: 600; }
.hint { color: var(--el-text-color-secondary); font-size: 13px; }
.device-row { padding: 12px 0; border-top: 1px solid var(--el-border-color-lighter); }
.member-block { padding: 10px 0; border-top: 1px solid var(--el-border-color-lighter); }
.member-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 0; }
.device-heading, .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
.actions .el-input { width: 200px; }
.strength-row { display: flex; align-items: center; gap: 16px; }
.strength-row .el-slider { flex: 1; }
</style>
