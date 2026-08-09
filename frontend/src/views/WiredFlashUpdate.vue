<template>
  <div class="wired-flash-page">
    <el-card class="summary-card" shadow="never">
      <div class="summary-header">
        <div class="summary-title">
          <h2>插线固件更新</h2>
          <span>通过 USB 串口为设备烧录最新固件</span>
        </div>

        <div class="summary-actions">
          <el-button :icon="Back" @click="$router.push('/devices')">返回设备管理</el-button>
          <el-button :icon="Refresh" :loading="portsLoading" :disabled="flashing" @click="loadPorts">
            {{ portsLoading ? '刷新中...' : '刷新串口' }}
          </el-button>
        </div>
      </div>
    </el-card>

    <el-alert
      v-if="pageError"
      :title="pageError"
      type="error"
      :closable="false"
      show-icon
      class="page-alert"
    />

    <!-- 1. 串口选择 -->
    <el-card shadow="never" class="step-card">
      <template #header>
        <div class="step-header">
          <span>1. 选择串口</span>
          <el-tag v-if="selectedPort" type="success" size="small">已选择 {{ selectedPort }}</el-tag>
        </div>
      </template>

      <div class="port-row">
        <el-select
          v-model="selectedPort"
          placeholder="请选择设备串口"
          :loading="portsLoading"
          :disabled="flashing"
          class="port-select"
          clearable
          @change="handlePortChange"
        >
          <el-option
            v-for="port in ports"
            :key="port.path"
            :label="formatPortLabel(port)"
            :value="port.path"
            :disabled="port.busy"
          />
        </el-select>
      </div>

      <el-alert
        v-if="!portsLoading && ports.length === 0"
        title="未检测到串口设备，请确认设备已通过 USB 连接电脑后点击「刷新串口」"
        type="warning"
        :closable="false"
        show-icon
        class="step-alert"
      />
    </el-card>

    <!-- 2. 识别设备 -->
    <el-card v-if="selectedPort" shadow="never" class="step-card">
      <template #header>
        <div class="step-header">
          <span>2. 识别设备</span>
          <el-button
            size="small"
            :icon="Search"
            :loading="identifying"
            :disabled="flashing"
            @click="identifyDevice"
          >
            {{ identifying ? '识别中（约需 5 秒）...' : '重新识别' }}
          </el-button>
        </div>
      </template>

      <div v-if="identifying" class="identify-loading" v-loading="true" element-loading-text="正在识别设备型号，请稍候..." />

      <template v-else-if="identifyDone">
        <el-alert
          v-if="!identified"
          title="未能自动识别型号，请手动选择"
          type="warning"
          :closable="false"
          show-icon
          class="step-alert"
        />

        <div class="device-info">
          <div class="info-item">
            <span class="info-label">设备型号</span>
            <el-select
              v-model="deviceType"
              placeholder="请选择设备型号"
              :disabled="flashing"
              class="type-select"
              @change="handleDeviceTypeChange"
            >
              <el-option
                v-for="type in DEVICE_TYPES"
                :key="type"
                :label="type"
                :value="type"
              />
            </el-select>
            <span v-if="identified" class="info-hint">已自动识别，如识别有误可手动改选</span>
          </div>
          <div class="info-item">
            <span class="info-label">当前版本</span>
            <strong>{{ currentVersion || '未知' }}</strong>
          </div>
          <div class="info-item">
            <span class="info-label">设备 ID</span>
            <strong>{{ deviceId || '未知' }}</strong>
          </div>
        </div>
      </template>
    </el-card>

    <!-- 3. 固件版本信息 -->
    <el-card v-if="deviceType" shadow="never" class="step-card">
      <template #header>
        <div class="step-header">
          <span>3. 固件版本</span>
          <el-button
            size="small"
            :icon="Refresh"
            :loading="firmwareLoading"
            :disabled="flashing"
            @click="loadFirmwareInfo"
          >
            重新检查
          </el-button>
        </div>
      </template>

      <div v-if="firmwareLoading" class="identify-loading" v-loading="true" element-loading-text="正在获取固件信息..." />

      <template v-else-if="firmwareInfo">
        <el-alert
          v-if="!firmwareInfo.supported"
          :title="`暂不支持型号 ${deviceType} 的插线固件更新`"
          type="error"
          :closable="false"
          show-icon
          class="step-alert"
        />
        <el-alert
          v-else-if="!firmwareInfo.updateAvailable"
          title="当前设备固件已是最新版本，如需重装可重新刷入"
          type="info"
          :closable="false"
          show-icon
          class="step-alert"
        />

        <div class="stat-grid">
          <div class="stat-item">
            <span class="stat-label">当前版本</span>
            <strong>{{ currentVersion || '未知' }}</strong>
          </div>
          <div class="stat-item" :class="firmwareInfo.updateAvailable ? 'stat-warning' : 'stat-success'">
            <span class="stat-label">最新版本</span>
            <strong>{{ firmwareInfo.latestVersion || '-' }}</strong>
          </div>
          <div class="stat-item">
            <span class="stat-label">固件文件</span>
            <strong class="filename">{{ firmwareInfo.firmware?.filename || '-' }}</strong>
          </div>
          <div class="stat-item">
            <span class="stat-label">固件大小</span>
            <strong>{{ formatSize(firmwareInfo.firmware?.sizeBytes) }}</strong>
          </div>
        </div>

        <div class="flash-action">
          <el-button
            type="primary"
            :icon="Upload"
            :disabled="!canFlash"
            :loading="flashing"
            @click="confirmAndFlash"
          >
            {{ firmwareInfo.updateAvailable ? '更新固件' : '重新刷入' }}
          </el-button>
        </div>
      </template>

      <el-alert
        v-else-if="firmwareError"
        :title="firmwareError"
        type="error"
        :closable="false"
        show-icon
        class="step-alert"
      />
    </el-card>

    <!-- 4. 烧录进度与结果 -->
    <el-card v-if="flashing || flashStatus" shadow="never" class="step-card">
      <template #header>
        <div class="step-header">
          <span>4. 烧录</span>
          <el-tag :type="flashTagType" size="small">{{ flashStatusLabel }}</el-tag>
        </div>
      </template>

      <el-alert
        v-if="flashing"
        title="烧录过程中请勿拔下 USB 线或关闭页面"
        type="warning"
        :closable="false"
        show-icon
        class="step-alert"
      />

      <div class="flash-progress">
        <el-progress
          :percentage="flashPercent"
          :status="flashProgressStatus"
          :indeterminate="flashing && flashStatus !== 'flashing'"
          :stroke-width="16"
        />
        <span v-if="flashMsg" class="flash-msg">{{ flashMsg }}</span>
      </div>

      <el-alert
        v-if="flashStatus === 'success'"
        title="固件烧录成功！设备已重启，请重新配网"
        type="success"
        :closable="false"
        show-icon
        class="step-alert"
      />

      <template v-if="flashStatus === 'failed'">
        <el-alert
          :title="flashError || '烧录失败'"
          type="error"
          :closable="false"
          show-icon
          class="step-alert"
        />
        <div class="flash-action">
          <el-button type="primary" :icon="Refresh" @click="confirmAndFlash">重试烧录</el-button>
        </div>
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Back, Refresh, Search, Upload } from '@element-plus/icons-vue';
import { track } from '../analytics';

interface SerialPort {
  path: string;
  name: string;
  busy: boolean;
}

interface FirmwareInfo {
  supported: boolean;
  latestVersion: string | null;
  updateAvailable: boolean;
  firmware: null | {
    filename: string;
    sizeBytes: number;
    sha256?: string;
    url?: string;
  };
}

// 型号列表与 hardware 仓库 CI 构建矩阵保持一致，后端固件按此型号区分
const DEVICE_TYPES = ['TD01', 'DIANJI', 'QTZ', 'ZIDONGSUO', 'PJ01', 'QIYA', 'DZC01', 'CUNZHI01'];

const FLASH_STATUS_LABELS: Record<string, string> = {
  downloading: '下载固件中',
  verifying: '校验固件中',
  entering_bootloader: '进入下载模式中',
  flashing: '烧录中',
  resetting: '重启设备中',
  success: '烧录成功',
  failed: '烧录失败',
};

const ports = ref<SerialPort[]>([]);
const portsLoading = ref(false);
const selectedPort = ref('');
const pageError = ref('');

const identifying = ref(false);
const identifyDone = ref(false);
const identified = ref(false);
const deviceType = ref('');
const currentVersion = ref<string | null>(null);
const deviceId = ref<string | null>(null);

const firmwareLoading = ref(false);
const firmwareError = ref('');
const firmwareInfo = ref<FirmwareInfo | null>(null);

const flashing = ref(false);
const flashStatus = ref('');
const flashProgress = ref<number | null>(null);
const flashMsg = ref('');
const flashError = ref('');
const pollTimer = ref<number | null>(null);

const canFlash = computed(() => (
  !!selectedPort.value
  && !!deviceType.value
  && !!firmwareInfo.value
  && firmwareInfo.value.supported !== false
  && !flashing.value
));

const flashStatusLabel = computed(() => FLASH_STATUS_LABELS[flashStatus.value] || flashStatus.value || '准备中');

const flashTagType = computed<'success' | 'warning' | 'danger' | 'info' | 'primary'>(() => {
  if (flashStatus.value === 'success') return 'success';
  if (flashStatus.value === 'failed') return 'danger';
  if (flashing.value) return 'warning';
  return 'info';
});

const flashPercent = computed(() => {
  if (flashStatus.value === 'success') return 100;
  if (flashStatus.value === 'failed') return typeof flashProgress.value === 'number' ? flashProgress.value : 0;
  if (flashStatus.value === 'flashing' && typeof flashProgress.value === 'number') return flashProgress.value;
  return 0;
});

const flashProgressStatus = computed<'success' | 'exception' | undefined>(() => {
  if (flashStatus.value === 'success') return 'success';
  if (flashStatus.value === 'failed') return 'exception';
  return undefined;
});

onMounted(() => {
  loadPorts();
});

onUnmounted(() => {
  stopPolling();
});

function extractError(data: any, fallback: string) {
  return data?.error?.message
    || (typeof data?.error === 'string' ? data.error : '')
    || data?.message
    || fallback;
}

async function apiGet(url: string) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throw new Error(extractError(data, `请求失败（${res.status}）`));
  return data;
}

async function apiPost(url: string, body: Record<string, any>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throw new Error(extractError(data, `请求失败（${res.status}）`));
  return data;
}

async function loadPorts() {
  portsLoading.value = true;
  pageError.value = '';
  try {
    const data = await apiGet('/api/wired-flash/ports');
    const list = Array.isArray(data) ? data : (data.ports || data.list || []);
    ports.value = (Array.isArray(list) ? list : [])
      .map((item: any) => {
        const path = item?.path ?? item?.port ?? item?.comName ?? item?.device;
        if (!path) return null;
        return {
          path: String(path),
          // 串口展示名各系统字段不一致，防御式读取
          name: String(item?.friendlyName ?? item?.manufacturer ?? item?.displayName ?? item?.description ?? ''),
          busy: Boolean(item?.busy ?? item?.occupied ?? item?.inUse ?? item?.locked),
        } as SerialPort;
      })
      .filter((port): port is SerialPort => !!port);

    // 只有一个可用串口时自动选中
    const available = ports.value.filter((port) => !port.busy);
    if (!selectedPort.value && available.length === 1) {
      selectedPort.value = available[0].path;
      handlePortChange(selectedPort.value);
    }
  } catch (error: any) {
    pageError.value = error?.message || '串口列表获取失败';
    ports.value = [];
  } finally {
    portsLoading.value = false;
  }
}

function handlePortChange(path: string) {
  selectedPort.value = path || '';
  resetIdentify();
  resetFirmware();
  resetFlash();
  if (selectedPort.value) identifyDevice();
}

function resetIdentify() {
  identifying.value = false;
  identifyDone.value = false;
  identified.value = false;
  deviceType.value = '';
  currentVersion.value = null;
  deviceId.value = null;
}

function resetFirmware() {
  firmwareLoading.value = false;
  firmwareError.value = '';
  firmwareInfo.value = null;
}

function resetFlash() {
  stopPolling();
  flashing.value = false;
  flashStatus.value = '';
  flashProgress.value = null;
  flashMsg.value = '';
  flashError.value = '';
}

async function identifyDevice() {
  if (!selectedPort.value || identifying.value) return;
  identifying.value = true;
  pageError.value = '';
  try {
    const data = await apiPost('/api/wired-flash/identify', { path: selectedPort.value });
    identified.value = Boolean(data?.identified);
    const type = data?.deviceType ?? data?.device_type ?? data?.type ?? null;
    currentVersion.value = data?.currentVersion ?? data?.current_version ?? data?.version ?? null;
    deviceId.value = data?.deviceId ?? data?.device_id ?? data?.mac ?? null;
    identifyDone.value = true;

    if (identified.value && type) {
      deviceType.value = String(type);
      loadFirmwareInfo();
    } else if (!identified.value) {
      deviceType.value = '';
    }
  } catch (error: any) {
    identifyDone.value = true;
    identified.value = false;
    ElMessage.error(error?.message || '设备识别失败');
  } finally {
    identifying.value = false;
  }
}

function handleDeviceTypeChange() {
  resetFirmware();
  resetFlash();
  if (deviceType.value) loadFirmwareInfo();
}

async function loadFirmwareInfo() {
  if (!deviceType.value || firmwareLoading.value) return;
  firmwareLoading.value = true;
  firmwareError.value = '';
  try {
    const params = new URLSearchParams({ deviceType: deviceType.value });
    if (currentVersion.value) params.set('currentVersion', currentVersion.value);
    const data = await apiGet(`/api/wired-flash/firmware?${params.toString()}`);
    const fw = data?.firmware;
    firmwareInfo.value = {
      supported: data?.supported !== false,
      latestVersion: data?.latestVersion ?? data?.latest_version ?? null,
      updateAvailable: Boolean(data?.updateAvailable ?? data?.update_available),
      firmware: fw ? {
        filename: String(fw.filename ?? fw.name ?? ''),
        sizeBytes: Number(fw.sizeBytes ?? fw.size_bytes ?? fw.size ?? 0),
        sha256: fw.sha256,
        url: fw.url,
      } : null,
    };
  } catch (error: any) {
    firmwareError.value = error?.message || '固件信息获取失败';
    firmwareInfo.value = null;
  } finally {
    firmwareLoading.value = false;
  }
}

async function confirmAndFlash() {
  if (!canFlash.value && flashStatus.value !== 'failed') return;

  try {
    await ElMessageBox.confirm(
      '烧录会清除设备上的 WiFi 配网和绑定信息，完成后需要重新配网。确认开始烧录？',
      '确认烧录固件',
      {
        confirmButtonText: '开始烧录',
        cancelButtonText: '取消',
        type: 'warning',
      }
    );
  } catch {
    return; // 用户取消
  }

  resetFlash();
  flashing.value = true;
  try {
    const data = await apiPost('/api/wired-flash/flash', {
      path: selectedPort.value,
      deviceType: deviceType.value,
    });
    const flashId = data?.flashId ?? data?.flash_id ?? data?.id;
    if (!flashId) throw new Error('后端未返回烧录任务 ID');
    track('wired_flash_start', { device_type: deviceType.value });
    pollFlashStatus(String(flashId), 0);
  } catch (error: any) {
    flashing.value = false;
    flashStatus.value = 'failed';
    flashError.value = error?.message || '烧录启动失败';
  }
}

function stopPolling() {
  if (pollTimer.value) {
    clearTimeout(pollTimer.value);
    pollTimer.value = null;
  }
}

async function pollFlashStatus(flashId: string, consecutiveErrors: number) {
  stopPolling();
  try {
    const data = await apiGet(`/api/wired-flash/flash/${encodeURIComponent(flashId)}/status`);
    flashStatus.value = String(data?.status || '');
    flashProgress.value = typeof data?.progress === 'number' ? data.progress : null;
    flashMsg.value = data?.msg ?? data?.message ?? '';
    if (data?.error) flashError.value = extractError(data, '');

    if (flashStatus.value === 'success' || flashStatus.value === 'failed') {
      flashing.value = false;
      if (flashStatus.value === 'failed' && !flashError.value) {
        flashError.value = flashMsg.value || '烧录失败';
      }
      return;
    }
    pollTimer.value = window.setTimeout(() => pollFlashStatus(flashId, 0), 1000);
  } catch (error: any) {
    // 轮询偶发失败时重试，连续失败 5 次判定烧录失败
    if (consecutiveErrors < 5) {
      pollTimer.value = window.setTimeout(() => pollFlashStatus(flashId, consecutiveErrors + 1), 1000);
      return;
    }
    flashing.value = false;
    flashStatus.value = 'failed';
    flashError.value = error?.message || '烧录状态查询失败';
  }
}

function formatPortLabel(port: SerialPort) {
  const base = port.name ? `${port.name}（${port.path}）` : port.path;
  return port.busy ? `${base} - 被占用` : base;
}

function formatSize(sizeBytes?: number) {
  if (!sizeBytes || !Number.isFinite(sizeBytes)) return '-';
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`;
  if (sizeBytes >= 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${sizeBytes} B`;
}
</script>

<style scoped>
.wired-flash-page {
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
.step-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.summary-title h2 {
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
  color: var(--text-primary);
}

.summary-title span {
  display: block;
  margin-top: 4px;
  color: var(--text-secondary);
  font-size: 13px;
}

.summary-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.page-alert,
.step-alert {
  margin-bottom: 16px;
}

.step-card {
  margin-bottom: 16px;
}

.port-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.port-select {
  width: 420px;
  max-width: 100%;
}

.identify-loading {
  height: 80px;
}

.device-info {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.info-item {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.info-label {
  width: 70px;
  color: var(--text-secondary);
  font-size: 13px;
  flex-shrink: 0;
}

.info-item strong {
  color: var(--text-primary);
  font-size: 14px;
  word-break: break-all;
}

.info-hint {
  color: var(--text-muted);
  font-size: 12px;
}

.type-select {
  width: 220px;
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
  background: var(--bg-surface);
}

.stat-label {
  display: block;
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 8px;
}

.stat-item strong {
  color: var(--text-primary);
  font-size: 24px;
  line-height: 1.2;
  word-break: break-all;
}

.stat-item strong.filename {
  font-size: 14px;
}

.stat-warning strong {
  color: #e6a23c;
}

.stat-success strong {
  color: #67c23a;
}

.flash-action {
  margin-top: 16px;
}

.flash-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}

.flash-msg {
  color: var(--text-secondary);
  font-size: 13px;
}

@media (max-width: 768px) {
  .wired-flash-page {
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

  .port-select,
  .type-select {
    width: 100%;
  }
}

@media (max-width: 480px) {
  .wired-flash-page {
    padding: 8px;
  }

  .stat-grid {
    grid-template-columns: 1fr;
  }
}
</style>
