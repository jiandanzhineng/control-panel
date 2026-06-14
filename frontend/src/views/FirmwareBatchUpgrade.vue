<template>
  <div class="firmware-batch-page">
    <el-card class="summary-card" shadow="never">
      <div class="summary-header">
        <div class="summary-title">
          <h2>批量固件升级</h2>
          <span>在线设备升级检查</span>
        </div>

        <div class="summary-actions">
          <el-button :icon="Back" @click="$router.push('/devices')">返回设备管理</el-button>
          <el-button :icon="Refresh" :loading="loading" @click="loadBatchFirmware">
            {{ loading ? '检查中...' : '刷新检查' }}
          </el-button>
          <el-button
            type="primary"
            :icon="Upload"
            :loading="batchUpdating"
            :disabled="upgradeTargets.length === 0 || loading || blinkLoading"
            @click="startBatchUpgrade"
          >
            批量升级 {{ upgradeTargets.length ? `(${upgradeTargets.length})` : '' }}
          </el-button>
          <el-button
            type="success"
            :icon="Sunny"
            :loading="blinkLoading"
            :disabled="latestRows.length === 0 || loading || batchUpdating"
            @click="blinkLatestDevices"
          >
            闪烁最新设备 {{ latestRows.length ? `(${latestRows.length})` : '' }}
          </el-button>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat-item">
          <span class="stat-label">在线设备</span>
          <strong>{{ rows.length }}</strong>
        </div>
        <div class="stat-item stat-warning">
          <span class="stat-label">需升级</span>
          <strong>{{ upgradeTargets.length }}</strong>
        </div>
        <div class="stat-item stat-success">
          <span class="stat-label">已最新</span>
          <strong>{{ latestCount }}</strong>
        </div>
        <div class="stat-item stat-muted">
          <span class="stat-label">不支持</span>
          <strong>{{ unsupportedCount }}</strong>
        </div>
      </div>
    </el-card>

    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      :closable="false"
      show-icon
      class="page-alert"
    />

    <el-card shadow="never">
      <template #header>
        <div class="table-header">
          <span>在线设备固件状态</span>
          <el-tag :type="streamConnected ? 'success' : 'info'" size="small">
            {{ streamConnected ? '状态实时同步' : '状态未连接' }}
          </el-tag>
        </div>
      </template>

      <el-table
        :data="rows"
        v-loading="loading"
        class="desktop-table"
        empty-text="暂无在线设备"
        style="width: 100%"
      >
        <el-table-column label="设备" min-width="180">
          <template #default="{ row }">
            <div class="device-cell">
              <strong>{{ formatDeviceName(row.device) }}</strong>
              <span>{{ row.device.id }}</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="类型" width="130">
          <template #default="{ row }">
            {{ deviceTypeMap[row.device.type] || row.device.type }}
          </template>
        </el-table-column>

        <el-table-column label="当前版本" width="130">
          <template #default="{ row }">
            {{ row.firmware.currentVersion || '未知' }}
          </template>
        </el-table-column>

        <el-table-column label="最新版本" width="130">
          <template #default="{ row }">
            {{ row.firmware.latestVersion || '-' }}
          </template>
        </el-table-column>

        <el-table-column label="版本状态" width="130">
          <template #default="{ row }">
            <el-tag :type="getVersionTagType(row)" size="small">
              {{ getVersionLabel(row) }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="升级状态" min-width="220">
          <template #default="{ row }">
            <div class="status-cell">
              <div class="status-row">
                <el-tag :type="getOtaStatusTagType(row.status.status)" size="small">
                  {{ getOtaStatusLabel(row.status.status) }}
                </el-tag>
                <span>{{ getStatusMessage(row) }}</span>
              </div>
              <el-progress
                v-if="showProgress(row.status.status)"
                :percentage="getProgress(row.status)"
                :status="getProgressStatus(row.status.status)"
              />
            </div>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="120" align="center">
          <template #default="{ row }">
            <el-button
              type="primary"
              size="small"
              :disabled="!canUpgradeRow(row) || batchUpdating"
              @click="upgradeOne(row)"
            >
              升级
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="mobile-list">
        <div v-for="row in rows" :key="row.device.id" class="device-card">
          <div class="card-top">
            <div class="device-cell">
              <strong>{{ formatDeviceName(row.device) }}</strong>
              <span>{{ deviceTypeMap[row.device.type] || row.device.type }} · {{ row.device.id }}</span>
            </div>
            <el-tag :type="getVersionTagType(row)" size="small">
              {{ getVersionLabel(row) }}
            </el-tag>
          </div>

          <div class="card-grid">
            <span>当前版本</span>
            <strong>{{ row.firmware.currentVersion || '未知' }}</strong>
            <span>最新版本</span>
            <strong>{{ row.firmware.latestVersion || '-' }}</strong>
          </div>

          <div class="status-cell">
            <div class="status-row">
              <el-tag :type="getOtaStatusTagType(row.status.status)" size="small">
                {{ getOtaStatusLabel(row.status.status) }}
              </el-tag>
              <span>{{ getStatusMessage(row) }}</span>
            </div>
            <el-progress
              v-if="showProgress(row.status.status)"
              :percentage="getProgress(row.status)"
              :status="getProgressStatus(row.status.status)"
            />
          </div>

          <el-button
            type="primary"
            size="small"
            :disabled="!canUpgradeRow(row) || batchUpdating"
            @click="upgradeOne(row)"
          >
            升级
          </el-button>
        </div>
        <el-empty v-if="!loading && rows.length === 0" description="暂无在线设备" />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Back, Refresh, Sunny, Upload } from '@element-plus/icons-vue';
import { track } from '../analytics';

interface Device {
  id: string;
  name: string;
  nickname?: string;
  type: string;
  connected: boolean;
  lastReport: string | null;
  data: Record<string, any>;
}

interface FirmwareInfo {
  supported: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  manifestGeneratedAt: string | null;
  commit: string | null;
  firmware: null | {
    device: string;
    kind: string;
    filename: string;
    objectKey: string;
    url: string;
    sizeBytes: number;
    sha256: string;
  };
}

interface OtaStatus {
  deviceId: string;
  status: string;
  progress: number | null;
  msg: string;
  updatedAt: string | null;
  firmwareVersion: string | null;
  filename: string | null;
  url: string | null;
}

interface BatchRow {
  device: Device;
  firmware: FirmwareInfo;
  status: OtaStatus;
}

interface BatchUpdateResult {
  deviceId: string;
  ok: boolean;
  skipped: boolean;
  failed: boolean;
  status?: OtaStatus;
  error?: {
    code: string;
    message: string;
    status: number;
  };
}

const rows = ref<BatchRow[]>([]);
const deviceTypeMap = ref<Record<string, string>>({});
const loading = ref(false);
const batchUpdating = ref(false);
const blinkLoading = ref(false);
const loadError = ref('');
const statusEventSource = ref<EventSource | null>(null);
const streamConnected = ref(false);
const otaStatusNow = ref(Date.now());
const otaStatusTimer = ref<number | null>(null);
const OTA_PROGRESS_TIMEOUT_MS = 20000;

const upgradeTargets = computed(() => rows.value.filter(canUpgradeRow));
const latestRows = computed(() => rows.value.filter(isLatestRow));
const latestCount = computed(() => latestRows.value.length);
const unsupportedCount = computed(() => rows.value.filter((row) => !row.firmware.supported).length);

onMounted(async () => {
  await Promise.all([loadDeviceTypes(), loadBatchFirmware()]);
  startOtaStatusTimer();
});

onUnmounted(() => {
  closeStatusStream();
  stopOtaStatusTimer();
});

async function loadDeviceTypes() {
  const res = await fetch('/api/device-types');
  if (!res.ok) throw new Error('设备类型获取失败');
  deviceTypeMap.value = await res.json();
}

async function loadBatchFirmware() {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await fetch('/api/devices/firmware/batch?scope=online');
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || data.message || '批量固件检查失败');
    rows.value = Array.isArray(data.devices) ? data.devices : [];
    setupStatusStream();
  } catch (error: any) {
    loadError.value = error?.message || '批量固件检查失败';
    rows.value = [];
    closeStatusStream();
  } finally {
    loading.value = false;
  }
}

function setupStatusStream() {
  closeStatusStream();
  const ids = rows.value.map((row) => row.device.id);
  if (ids.length === 0) return;

  const eventSource = new EventSource(`/api/devices/firmware/batch/status-stream?ids=${encodeURIComponent(ids.join(','))}`);
  const handleStatus = (event: MessageEvent) => {
    try {
      const status = JSON.parse(event.data);
      updateRowStatus(status);
    } catch (error) {
      console.error('解析批量 OTA 状态失败:', error);
    }
  };

  eventSource.addEventListener('status', handleStatus);
  eventSource.onmessage = handleStatus;
  eventSource.onopen = () => {
    streamConnected.value = true;
  };
  eventSource.onerror = () => {
    streamConnected.value = false;
  };

  statusEventSource.value = eventSource;
}

function closeStatusStream() {
  if (statusEventSource.value) {
    statusEventSource.value.close();
    statusEventSource.value = null;
  }
  streamConnected.value = false;
}

function startOtaStatusTimer() {
  stopOtaStatusTimer();
  otaStatusTimer.value = window.setInterval(() => {
    otaStatusNow.value = Date.now();
  }, 1000);
}

function stopOtaStatusTimer() {
  if (otaStatusTimer.value) {
    clearInterval(otaStatusTimer.value);
    otaStatusTimer.value = null;
  }
}

function updateRowStatus(status: OtaStatus) {
  rows.value = rows.value.map((row) => (
    row.device.id === status.deviceId
      ? { ...row, status }
      : row
  ));
}

async function startBatchUpgrade() {
  const targets = upgradeTargets.value;
  if (targets.length === 0) return;

  try {
    const latestVersions = [...new Set(targets.map((row) => row.firmware.latestVersion).filter(Boolean))].join('、');
    await ElMessageBox.confirm(
      `确认升级 ${targets.length} 台在线设备到最新固件${latestVersions ? `（${latestVersions}）` : ''}？升级完成后设备可能会自动重启。`,
      '确认批量升级',
      {
        confirmButtonText: '开始升级',
        cancelButtonText: '取消',
        type: 'warning',
      }
    );

    await updateDevices(targets.map((row) => row.device.id));
    track('firmware_upgrade', { batch_count: targets.length });
  } catch (error: any) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(error?.message || '批量升级失败');
    }
  }
}

async function upgradeOne(row: BatchRow) {
  try {
    await updateDevices([row.device.id]);
  } catch (error: any) {
    ElMessage.error(error?.message || '升级指令下发失败');
  }
}

async function updateDevices(deviceIds: string[]) {
  batchUpdating.value = true;
  try {
    const res = await fetch('/api/devices/firmware/batch/update-latest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || data.message || 'OTA 指令下发失败');

    applyBatchResults(data.results || []);
    ElMessage.success(`已下发 ${data.requestedCount || 0} 台设备升级指令`);
    if (data.failedCount) ElMessage.warning(`${data.failedCount} 台设备下发失败`);
  } finally {
    batchUpdating.value = false;
  }
}

async function blinkLatestDevices() {
  const targets = latestRows.value;
  if (targets.length === 0) return;

  try {
    blinkLoading.value = true;
    const res = await fetch('/api/devices/firmware/batch/blink-latest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || data.message || '指示灯闪烁指令下发失败');

    ElMessage.success(`已向 ${data.requestedCount || 0} 台最新设备下发闪烁指令`);
    if (data.failedCount) ElMessage.warning(`${data.failedCount} 台设备下发失败`);
    if (!data.requestedCount && data.skippedCount) ElMessage.info('没有可闪烁的最新版本设备');
  } catch (error: any) {
    ElMessage.error(error?.message || '指示灯闪烁指令下发失败');
  } finally {
    blinkLoading.value = false;
  }
}

function applyBatchResults(results: BatchUpdateResult[]) {
  const resultMap = new Map(results.map((result) => [result.deviceId, result]));
  rows.value = rows.value.map((row) => {
    const result = resultMap.get(row.device.id);
    if (!result) return row;
    if (result.status) return { ...row, status: result.status };
    if (result.error) {
      return {
        ...row,
        status: {
          ...row.status,
          status: result.failed ? 'failed' : row.status.status,
          msg: result.error.message,
          updatedAt: new Date().toISOString(),
        },
      };
    }
    return row;
  });
}

function isLatestRow(row: BatchRow) {
  return row.device.connected
    && row.firmware.supported
    && !!row.firmware.currentVersion
    && !row.firmware.updateAvailable;
}

function canUpgradeRow(row: BatchRow) {
  return row.device.connected
    && row.firmware.supported
    && row.firmware.updateAvailable
    && !isActiveOtaStatus(row.status);
}

function isOtaBusy(status?: string) {
  return ['requested', 'start', 'downloading'].includes(status || '');
}

function isTimedOutOtaStatus(status: OtaStatus | null | undefined) {
  if (!status || !isOtaBusy(status.status)) return false;
  if (!status.updatedAt) return true;
  const updatedAt = new Date(status.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) return true;
  return otaStatusNow.value - updatedAt > OTA_PROGRESS_TIMEOUT_MS;
}

function isActiveOtaStatus(status: OtaStatus | null | undefined) {
  return !!status && isOtaBusy(status.status) && !isTimedOutOtaStatus(status);
}

function getVersionLabel(row: BatchRow) {
  if (!row.firmware.supported) return '不支持';
  if (!row.firmware.currentVersion && row.firmware.latestVersion) return '需确认';
  return row.firmware.updateAvailable ? '需升级' : '已最新';
}

function getVersionTagType(row: BatchRow): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  if (!row.firmware.supported) return 'info';
  if (!row.firmware.currentVersion && row.firmware.latestVersion) return 'warning';
  return row.firmware.updateAvailable ? 'warning' : 'success';
}

function getRowSummary(row: BatchRow) {
  if (!row.firmware.supported) return '该设备类型暂无 OTA 应用固件';
  if (row.firmware.updateAvailable) return `可升级到 ${row.firmware.latestVersion || '最新版本'}`;
  return '当前设备固件已是最新版本';
}

function getStatusMessage(row: BatchRow) {
  if (isTimedOutOtaStatus(row.status)) return '20秒内未收到升级进度，可重新开始升级';
  return row.status.msg || getRowSummary(row);
}

function getOtaStatusLabel(status?: string) {
  const labels: Record<string, string> = {
    idle: '空闲',
    requested: '已下发',
    start: '开始',
    downloading: '下载中',
    success: '成功',
    failed: '失败',
    unknown: '未知',
  };
  return labels[status || 'idle'] || status || '空闲';
}

function getOtaStatusTagType(status?: string): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'danger';
  if (isOtaBusy(status)) return 'warning';
  return 'info';
}

function showProgress(status?: string) {
  return ['requested', 'start', 'downloading', 'success', 'failed'].includes(status || '');
}

function getProgress(status: OtaStatus) {
  if (typeof status.progress === 'number') return status.progress;
  if (status.status === 'success') return 100;
  return 0;
}

function getProgressStatus(status?: string): 'success' | 'exception' | 'warning' | undefined {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'exception';
  if (status === 'requested' || status === 'start') return 'warning';
  return undefined;
}

function formatDeviceName(device: Device) {
  if (device.nickname) return `${device.nickname}-${String(device.id).slice(-4)}`;
  return device.name || device.id;
}
</script>

<style scoped>
.firmware-batch-page {
  padding: 20px;
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  box-sizing: border-box;
}

.summary-card {
  margin-bottom: 16px;
}

.summary-header,
.table-header,
.status-row,
.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.summary-header {
  margin-bottom: 18px;
  flex-wrap: wrap;
}

.summary-title h2 {
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
  color: #303133;
}

.summary-title span {
  display: block;
  margin-top: 4px;
  color: #606266;
  font-size: 13px;
}

.summary-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: 12px;
}

.stat-item {
  min-height: 76px;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 14px;
  background: #fff;
}

.stat-label {
  display: block;
  color: #606266;
  font-size: 13px;
  margin-bottom: 8px;
}

.stat-item strong {
  color: #303133;
  font-size: 28px;
  line-height: 1;
}

.stat-warning strong {
  color: #e6a23c;
}

.stat-success strong {
  color: #67c23a;
}

.stat-muted strong {
  color: #909399;
}

.page-alert {
  margin-bottom: 16px;
}

.device-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.device-cell strong {
  color: #303133;
  font-size: 14px;
  word-break: break-all;
}

.device-cell span {
  color: #909399;
  font-size: 12px;
  word-break: break-all;
}

.status-cell {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.status-row {
  justify-content: flex-start;
}

.status-row span:last-child {
  color: #606266;
  font-size: 13px;
  line-height: 1.4;
}

.mobile-list {
  display: none;
}

.device-card {
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 14px;
  background: #fff;
  margin-bottom: 12px;
}

.card-top {
  align-items: flex-start;
  margin-bottom: 12px;
}

.card-grid {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 8px 12px;
  margin-bottom: 12px;
  color: #606266;
  font-size: 13px;
}

.card-grid strong {
  color: #303133;
  word-break: break-all;
}

.device-card .el-button {
  width: 100%;
  margin-top: 12px;
}

@media (max-width: 768px) {
  .firmware-batch-page {
    padding: 12px;
  }

  .summary-header,
  .summary-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .summary-actions .el-button {
    width: 100%;
    margin-left: 0;
  }

  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .desktop-table {
    display: none;
  }

  .mobile-list {
    display: block;
  }
}

@media (max-width: 480px) {
  .firmware-batch-page {
    padding: 8px;
  }

  .stat-grid {
    grid-template-columns: 1fr;
  }
}
</style>
