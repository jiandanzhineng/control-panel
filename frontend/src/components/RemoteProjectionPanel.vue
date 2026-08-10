<template>
  <div class="projection-panel">
    <div class="panel-toolbar">
      <div class="status-line">
        <span class="status-dot" :class="statusTone"></span>
        <span>{{ statusText }}</span>
      </div>
      <el-button :icon="Refresh" circle :loading="loading" title="刷新" @click="refresh" />
    </div>

    <el-alert
      v-if="!token"
      type="warning"
      :closable="false"
      title="请先登录账号"
      show-icon
    >
      <template #default>
        <el-button type="primary" size="small" @click="router.push('/account')">前往登录</el-button>
      </template>
    </el-alert>

    <el-alert v-if="error" type="error" :closable="true" :title="error" show-icon @close="error = ''" />

    <template v-if="token && !status.active">
      <el-radio-group v-model="mode" size="large" class="mode-switch">
        <el-radio-button value="owner">共享本地设备</el-radio-button>
        <el-radio-button value="operator">控制远程设备</el-radio-button>
      </el-radio-group>

      <div v-if="mode === 'owner'" class="card">
        <div class="card-title">共享我的本地设备</div>
        <div class="card-desc">创建一个投影房间，把本机在线设备授权给对方远程控制。</div>
        <el-form label-position="top" class="limit-form">
          <el-form-item label="控制时长（分钟）">
            <el-input-number v-model="ttlMinutes" :min="1" :max="1440" :step="5" class="full-width" controls-position="right" />
          </el-form-item>
          <el-form-item label="电压上限（V）">
            <el-input-number v-model="maxVoltage" :min="0" :max="100" class="full-width" controls-position="right" />
          </el-form-item>
          <el-form-item label="强度上限（0-255）">
            <el-input-number v-model="maxPower" :min="0" :max="255" class="full-width" controls-position="right" />
          </el-form-item>
        </el-form>
        <el-button type="primary" :icon="Link" :loading="busy" class="action-btn" @click="createRoom">创建投影房间</el-button>
      </div>

      <div v-else class="card">
        <div class="card-title">控制远程设备</div>
        <div class="card-desc">输入对方分享的房间码，即可远程控制对方共享的设备。</div>
        <div class="join-row">
          <el-input v-model="joinCode" placeholder="请输入房间码" maxlength="64" clearable @keyup.enter="joinRoom" />
          <el-button type="primary" :icon="LogIn" :loading="busy" @click="joinRoom">加入房间</el-button>
        </div>
      </div>
    </template>

    <template v-else-if="status.active">
      <div class="card session-card">
        <div class="session-top">
          <span class="role-label">{{ status.role === 'owner' ? '共享本地设备' : '控制远程设备' }}</span>
          <div v-if="status.joinCode" class="join-code">
            <span>{{ status.joinCode }}</span>
            <el-button :icon="CopyDocument" text circle title="复制房间码" @click="copyCode" />
          </div>
          <span v-else class="room-id">房间 {{ status.roomId }}</span>
        </div>
        <div class="session-meta">
          <div class="meta-item">
            <span class="meta-label">剩余时间</span>
            <span class="meta-value">{{ remainingText }}</span>
          </div>
          <div v-if="status.role === 'owner'" class="meta-item">
            <span class="meta-label">在线操作方</span>
            <span class="meta-value">{{ status.operatorCount || 0 }} 人</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">电压上限</span>
            <span class="meta-value">{{ status.limits?.voltage ?? '-' }} V</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">强度上限</span>
            <span class="meta-value">{{ status.limits?.power ?? '-' }}</span>
          </div>
        </div>
        <el-button type="danger" plain :icon="CircleClose" :loading="busy" class="action-btn" @click="stopRoom">结束投影</el-button>
      </div>

      <div class="card">
        <div class="section-head">
          <div class="card-title">{{ status.role === 'owner' ? '已共享的设备' : '可控制的远程设备' }}</div>
          <span class="section-count">{{ devices.length }} 台</span>
        </div>
        <el-empty v-if="devices.length === 0" description="暂无在线设备" :image-size="72" />
        <el-table v-else :data="devices" stripe>
          <el-table-column label="设备" min-width="180">
            <template #default="scope">
              <div class="device-name">{{ scope.row.nickname || scope.row.name || deviceId(scope.row) }}</div>
              <div class="device-id">{{ deviceId(scope.row) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="类型" min-width="120">
            <template #default="scope">{{ scope.row.deviceType || scope.row.type }}</template>
          </el-table-column>
          <el-table-column label="连接" width="110">
            <template #default="scope">
              <el-tag :type="connectionTagType(scope.row)" effect="plain">{{ connectionLabel(scope.row) }}</el-tag>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { CircleClose, CopyDocument, Refresh, Promotion as LogIn, Link } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { getToken } from '../api/auth';
import {
  createProjection,
  getProjectionStatus,
  joinProjection,
  stopProjection,
  type ProjectionDevice,
  type ProjectionStatus,
} from '../api/remoteProjection';

const router = useRouter();
const token = computed(() => getToken());
const mode = ref<'owner' | 'operator'>('owner');
const ttlMinutes = ref(60);
const maxVoltage = ref(20);
const maxPower = ref(128);
const joinCode = ref('');
const status = ref<ProjectionStatus>({ active: false });
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const now = ref(Date.now());
let pollTimer: ReturnType<typeof setInterval> | null = null;

const devices = computed(() => status.value.devices || []);
const statusTone = computed(() => status.value.expired ? 'expired' : (status.value.connected ? 'online' : 'offline'));
const statusText = computed(() => {
  if (!status.value.active) return '未连接';
  if (status.value.expired) return '控制时间已结束';
  return status.value.connected ? '房间已连接' : '正在重连';
});
const remainingText = computed(() => {
  const end = Date.parse(status.value.controlExpiresAt || '');
  if (!Number.isFinite(end)) return '-';
  const seconds = Math.max(0, Math.ceil((end - now.value) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
});

function deviceId(device: ProjectionDevice) {
  return device.deviceId || device.id || '';
}

function connectionLabel(device: ProjectionDevice) {
  if (status.value.role === 'operator') return '远程';
  return { mqtt: 'MQTT', serial: '串口', ble: 'BLE', remote: '远程' }[device.connectionType || ''] || '-';
}

function connectionTagType(device: ProjectionDevice) {
  if (status.value.role === 'operator') return 'warning';
  return { mqtt: 'info', serial: 'success', ble: 'primary', remote: 'warning' }[device.connectionType || ''] || 'info';
}

async function refresh(silent = false) {
  if (!silent) loading.value = true;
  try {
    status.value = await getProjectionStatus();
    if (status.value.lastError) error.value = status.value.lastError;
  } catch (e: any) {
    error.value = e?.message || '状态读取失败';
  } finally {
    loading.value = false;
  }
}

async function createRoom() {
  busy.value = true;
  error.value = '';
  try {
    status.value = await createProjection({
      controlTtlSec: ttlMinutes.value * 60,
      limits: { voltage: maxVoltage.value, power: maxPower.value },
    });
  } catch (e: any) {
    error.value = e?.message || '创建房间失败';
  } finally {
    busy.value = false;
  }
}

async function joinRoom() {
  if (!joinCode.value.trim()) return;
  busy.value = true;
  error.value = '';
  try {
    status.value = await joinProjection(joinCode.value.trim());
  } catch (e: any) {
    error.value = e?.message || '加入房间失败';
  } finally {
    busy.value = false;
  }
}

async function stopRoom() {
  busy.value = true;
  try {
    status.value = await stopProjection();
  } catch (e: any) {
    error.value = e?.message || '结束投影失败';
  } finally {
    busy.value = false;
  }
}

async function copyCode() {
  if (!status.value.joinCode) return;
  await navigator.clipboard.writeText(status.value.joinCode);
  ElMessage.success('房间码已复制');
}

onMounted(() => {
  void refresh();
  pollTimer = setInterval(() => {
    now.value = Date.now();
    if (status.value.active) void refresh(true);
  }, 1000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.projection-panel { display: flex; flex-direction: column; gap: 16px; }
.panel-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.status-line { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 13px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
.status-dot.online { background: var(--el-color-success); }
.status-dot.expired { background: var(--el-color-danger); }

.mode-switch { display: flex; }
.mode-switch :deep(.el-radio-button) { flex: 1; }
.mode-switch :deep(.el-radio-button__inner) { width: 100%; }

.card {
  background: var(--bg-card, var(--el-bg-color-overlay));
  border: 1px solid var(--border-subtle, var(--el-border-color));
  border-radius: 8px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.card-title { font-size: 15px; font-weight: 600; color: var(--text-primary); letter-spacing: 0; }
.card-desc { font-size: 13px; color: var(--text-muted); margin-top: -8px; }

.limit-form { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.limit-form :deep(.el-form-item) { margin-bottom: 0; }
.limit-form :deep(.el-form-item__label) { padding-bottom: 4px; color: var(--text-secondary); }
.full-width { width: 100%; }
.full-width :deep(.el-input__wrapper) { width: 100%; }

.action-btn { align-self: flex-start; }

.join-row { display: flex; gap: 12px; }
.join-row .el-input { flex: 1; }

.session-card { gap: 16px; }
.session-top { display: flex; align-items: center; gap: 12px; min-width: 0; flex-wrap: wrap; }
.role-label { font-size: 12px; color: var(--accent); border: 1px solid var(--accent); padding: 3px 8px; border-radius: 4px; white-space: nowrap; }
.join-code { display: flex; align-items: center; gap: 4px; font: 700 22px/1.2 ui-monospace, monospace; color: var(--text-primary); overflow-wrap: anywhere; }
.room-id { color: var(--text-primary); overflow-wrap: anywhere; }

.session-meta { display: flex; flex-wrap: wrap; gap: 12px 28px; padding: 12px 0; border-top: 1px solid var(--border-subtle, var(--el-border-color)); border-bottom: 1px solid var(--border-subtle, var(--el-border-color)); }
.meta-item { display: flex; flex-direction: column; gap: 2px; }
.meta-label { font-size: 12px; color: var(--text-muted); }
.meta-value { font-size: 15px; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }

.section-head { display: flex; align-items: center; justify-content: space-between; }
.section-count { color: var(--text-muted); font-size: 13px; }
.device-name { color: var(--text-primary); font-weight: 600; }
.device-id { color: var(--text-muted); font: 11px/1.5 ui-monospace, monospace; overflow-wrap: anywhere; }

@media (max-width: 760px) {
  .limit-form { grid-template-columns: 1fr; }
  .join-row { flex-direction: column; }
  .action-btn { align-self: stretch; }
}
</style>
