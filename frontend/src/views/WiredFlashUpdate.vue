<template>
  <div class="wired-flash-page">
    <el-alert
      v-if="pageError"
      :title="pageError"
      type="error"
      :closable="false"
      show-icon
      class="page-alert"
    />

    <!-- 1. 连接与识别 -->
    <el-card shadow="never" class="step-card">
      <template #header>
        <div class="step-header">
          <span>1. 连接与识别</span>
          <div class="header-actions">
            <el-tag v-if="selectedPort" type="success" size="small">已选择 {{ selectedPort }}</el-tag>
            <el-button size="small" :icon="Refresh" :loading="portsLoading" :disabled="flashing" @click="loadPorts">
              刷新串口
            </el-button>
          </div>
        </div>
      </template>

      <div class="connect-row">
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

        <template v-if="selectedPort">
          <span v-if="identifying" class="inline-status">
            <el-icon class="is-loading"><Loading /></el-icon> 正在识别设备型号（约 5 秒）...
          </span>
          <template v-else-if="identifyDone">
            <el-select
              v-model="deviceType"
              placeholder="设备型号"
              :disabled="flashing"
              class="type-select"
              @change="handleDeviceTypeChange"
            >
              <el-option v-for="type in DEVICE_TYPES" :key="type" :label="type" :value="type" />
            </el-select>
            <span class="kv">版本 <strong>{{ currentVersion || '未知' }}</strong></span>
            <span class="kv">ID <strong>{{ deviceId || '未知' }}</strong></span>
            <span v-if="identified" class="info-hint">已自动识别，如有误可改选</span>
          </template>
        </template>
      </div>

      <el-alert
        v-if="identifyDone && !identified"
        title="未能自动识别型号，请手动选择"
        type="warning"
        :closable="false"
        show-icon
        class="step-alert"
      />

      <el-alert
        v-if="!portsLoading && ports.length === 0"
        title="未检测到串口设备，请确认设备已通过 USB 连接电脑后点击「刷新串口」"
        type="warning"
        :closable="false"
        show-icon
        class="step-alert"
      />

      <el-alert v-if="driverMissing" type="error" :closable="false" show-icon class="step-alert">
        <template #title>
          检测到 CH34x 设备但驱动未安装，请先
          <el-link type="danger" href="https://www.wch.cn/downloads/ch341ser_exe.html" target="_blank" :underline="false">
            下载并安装驱动
          </el-link>
          ，安装完成后点击「刷新串口」
        </template>
      </el-alert>
    </el-card>

    <!-- 2. 固件与烧录 -->
    <el-card v-if="deviceType" shadow="never" class="step-card">
      <template #header>
        <div class="step-header">
          <span>2. 固件与烧录</span>
          <el-button size="small" :icon="Refresh" :loading="firmwareLoading" :disabled="flashing" @click="loadFirmwareInfo">
            重新检查
          </el-button>
        </div>
      </template>

      <div v-if="firmwareLoading" class="fw-loading" v-loading="true" element-loading-text="正在获取固件信息..." />

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

        <div class="fw-row">
          <span class="kv">当前 <strong>{{ currentVersion || '未知' }}</strong></span>
          <span class="kv">最新
            <strong :class="firmwareInfo.updateAvailable ? 'text-warning' : 'text-success'">
              {{ firmwareInfo.latestVersion || '-' }}
            </strong>
          </span>
          <span class="kv">文件 <strong>{{ firmwareInfo.firmware?.filename || '-' }}</strong></span>
          <span class="kv">大小 <strong>{{ formatSize(firmwareInfo.firmware?.sizeBytes) }}</strong></span>
          <el-button
            type="primary"
            class="flash-btn"
            :icon="Upload"
            :disabled="!canFlash"
            :loading="flashing"
            @click="confirmAndFlash"
          >
            {{ firmwareInfo.updateAvailable ? '更新固件' : '重新刷入' }}
          </el-button>
        </div>

        <div v-if="flashing || flashStatus" class="flash-block">
          <div class="flash-line">
            <el-tag :type="flashTagType" size="small">{{ flashStatusLabel }}</el-tag>
            <el-progress
              class="flash-bar"
              :percentage="flashPercent"
              :status="flashProgressStatus"
              :indeterminate="flashing && flashStatus !== 'flashing'"
              :stroke-width="14"
            />
          </div>
          <span v-if="flashMsg" class="flash-msg">{{ flashMsg }}</span>

          <el-alert
            v-if="flashing"
            title="烧录过程中请勿拔下 USB 线或关闭页面"
            type="warning"
            :closable="false"
            show-icon
            class="step-alert"
          />
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
            <el-button type="primary" size="small" :icon="Refresh" @click="confirmAndFlash">重试烧录</el-button>
          </template>
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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Loading, Refresh, Upload } from '@element-plus/icons-vue';
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
const driverMissing = ref(false);

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

async function checkDriverStatus() {
  try {
    const data = await apiGet('/api/wired-flash/driver-status');
    driverMissing.value = Boolean(data?.driverMissing ?? data?.driver_missing);
  } catch {
    driverMissing.value = false;
  }
}

async function loadPorts() {
  portsLoading.value = true;
  pageError.value = '';
  driverMissing.value = false;
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

    // 一个串口都没有时检查是不是驱动没装
    if (ports.value.length === 0) checkDriverStatus();

    // 只有一个可用串口时自动选中
    const available = ports.value.filter((port) => !port.busy);
    if (!selectedPort.value && available.length === 1) {
      selectedPort.value = available[0].path;
      handlePortChange(selectedPort.value);
    }
  } catch (error: any) {
    pageError.value = error?.message || '串口列表获取失败';
    ports.value = [];
    checkDriverStatus();
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
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  box-sizing: border-box;
}

.page-alert,
.step-alert {
  margin-bottom: 12px;
}

.step-card {
  margin-bottom: 12px;
}

.step-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.connect-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.port-select {
  width: 380px;
  max-width: 100%;
}

.type-select {
  width: 160px;
}

.inline-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 13px;
}

.kv {
  color: var(--text-secondary);
  font-size: 13px;
  white-space: nowrap;
}

.kv strong {
  color: var(--text-primary);
  font-size: 14px;
  word-break: break-all;
}

.info-hint {
  color: var(--text-muted);
  font-size: 12px;
}

.fw-loading {
  height: 60px;
}

.fw-row {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
}

.text-warning {
  color: #e6a23c;
}

.text-success {
  color: #67c23a;
}

.flash-btn {
  margin-left: auto;
}

.flash-block {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.flash-line {
  display: flex;
  align-items: center;
  gap: 12px;
}

.flash-bar {
  flex: 1;
}

.flash-msg {
  color: var(--text-secondary);
  font-size: 13px;
}

@media (max-width: 768px) {
  .port-select,
  .type-select {
    width: 100%;
  }

  .flash-btn {
    margin-left: 0;
    width: 100%;
  }
}
</style>
