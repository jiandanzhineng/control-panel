<template>
  <div class="auto-test-page">
    <el-card shadow="never" class="provision-card">
      <template #header>
        <div class="header">
          <span>串口自动供给</span>
          <div class="provision-options">
            <el-switch
              v-model="autoFlash"
              active-text="连接失败时自动烧录"
              @change="saveProvisionSettings"
            />
            <el-select
              v-model="flashDeviceType"
              placeholder="烧录型号"
              size="small"
              class="type-select"
              :disabled="!autoFlash"
              @change="saveProvisionSettings"
            >
              <el-option v-for="type in DEVICE_TYPES" :key="type" :label="type" :value="type" />
            </el-select>
          </div>
        </div>
      </template>

      <el-alert
        v-if="autoFlash && !flashDeviceType"
        title="已开启自动烧录但未选择型号，握手失败的端口不会被烧录"
        type="warning"
        :closable="false"
        show-icon
        class="provision-alert"
      />

      <el-table :data="provisionPorts" style="width: 100%" empty-text="暂无串口">
        <el-table-column prop="path" label="串口" width="110" />
        <el-table-column prop="friendlyName" label="名称" min-width="180" show-overflow-tooltip />
        <el-table-column label="阶段" width="120">
          <template #default="{ row }">
            <el-tag :type="stageTagType(row.stage)" size="small">{{ stageLabel(row.stage) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="进展" min-width="240">
          <template #default="{ row }">
            <el-progress
              v-if="row.stage === 'flashing' && row.flashProgress !== null"
              :percentage="row.flashProgress"
              :stroke-width="10"
            />
            <span :class="{ 'text-danger': row.stage === 'failed' }">{{ row.message }}</span>
            <span v-if="row.error" class="error-code">（{{ row.error.code }}: {{ row.error.message }}）</span>
          </template>
        </el-table-column>
        <el-table-column label="设备ID" width="150">
          <template #default="{ row }">{{ row.deviceId || '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" align="center">
          <template #default="{ row }">
            <el-button
              v-if="row.stage === 'failed'"
              type="primary"
              size="small"
              :loading="retryLoading[row.path]"
              @click="retryPort(row)"
            >
              重试
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="header">
          <span>自动化测试平台</span>
          <el-tag type="success">测试运行中</el-tag>
        </div>
      </template>

      <el-table :data="onlineDevices" style="width: 100%" empty-text="暂无在线设备">
        <el-table-column prop="type" label="类型" width="150">
          <template #default="{ row }">
            {{ deviceTypeMap[row.type] || row.type }}
          </template>
        </el-table-column>

        <el-table-column prop="id" label="设备ID" width="180" />

        <el-table-column label="监控数据">
          <template #default="{ row }">
            <div class="monitor-data">
              <template v-if="hasMonitorData(row.type)">
                <div v-for="item in getMonitorData(row)" :key="item.key" class="monitor-item">
                  <span class="label">{{ item.name }}:</span>
                  <span class="value" :style="{ color: getMonitorColor(item, row.data?.[item.key]) }">
                    {{ formatValue(row.data?.[item.key], item.unit) }}
                  </span>
                </div>
              </template>
              <span v-else class="no-data">无监控数据</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="240" align="center">
          <template #default="{ row }">
            <div class="action-buttons">
              <el-button
                type="primary"
                size="small"
                @click="restartTest(row)"
              >
                重新开始
              </el-button>
              <el-button
                type="success"
                size="small"
                :loading="blinkLoading[row.id]"
                @click="blinkDevice(row)"
              >
                指示灯闪烁
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';

interface Device {
  id: string;
  type: string;
  connected: boolean;
  data: Record<string, any>;
}

interface ProvisionPort {
  path: string;
  friendlyName: string;
  vendorId: string | null;
  ch34x: boolean;
  stage: 'pending' | 'probing' | 'flashing' | 'connected' | 'failed';
  message: string;
  deviceId: string | null;
  flashProgress: number | null;
  error: { code: string; message: string } | null;
}

const DEVICE_TYPES = ['TD01', 'DIANJI', 'QTZ', 'ZIDONGSUO', 'PJ01', 'QIYA', 'DZC01', 'CUNZHI01'];

const STAGE_LABELS: Record<string, string> = {
  pending: '等待',
  probing: '连接中',
  flashing: '烧录中',
  connected: '已连接',
  failed: '失败',
};

const devices = ref<Device[]>([]);
const deviceTypeMap = ref<Record<string, string>>({});
const deviceTypeConfigs = ref<Record<string, any>>({});
const eventSource = ref<EventSource | null>(null);
const blinkLoading = ref<Record<string, boolean>>({});
const provisionPorts = ref<ProvisionPort[]>([]);
const autoFlash = ref(false);
const flashDeviceType = ref('');
const retryLoading = ref<Record<string, boolean>>({});

const onlineDevices = computed(() => devices.value.filter(d => d.connected));

onMounted(async () => {
  try {
    // 1. 加载配置和设备列表
    await Promise.all([loadDeviceTypes(), loadDeviceTypeConfigs(), refreshDevices()]);

    // 2. 读取自动供给设置（后端持久化），再启动测试平台+串口自动供给
    await loadProvisionState();
    await startPlatform();

    // 3. 建立 SSE 连接
    connectSSE();

  } catch (error: any) {
    ElMessage.error(error.message || '初始化失败');
  }
});

onUnmounted(async () => {
  // 1. 关闭 SSE
  if (eventSource.value) {
    eventSource.value.close();
  }
  
  // 2. 停止测试平台
  try {
    await fetch('/api/test/stop', { method: 'POST' });
  } catch (e) {
    console.error('停止测试失败', e);
  }
});

async function loadDeviceTypes() {
  const res = await fetch('/api/device-types');
  deviceTypeMap.value = await res.json();
}

async function loadDeviceTypeConfigs() {
  const res = await fetch('/api/device-types/configs');
  deviceTypeConfigs.value = await res.json();
}

async function refreshDevices() {
  const res = await fetch('/api/devices');
  devices.value = await res.json();
}

async function startPlatform() {
  const res = await fetch('/api/test/start', { method: 'POST' });
  const data = await res.json().catch(() => null);
  if (data?.provision) applyProvisionState(data.provision);
}

async function loadProvisionState() {
  const res = await fetch('/api/test/provision');
  applyProvisionState(await res.json());
}

function applyProvisionState(state: any) {
  if (!state) return;
  provisionPorts.value = Array.isArray(state.ports) ? state.ports : [];
  autoFlash.value = state.settings?.autoFlash === true;
  flashDeviceType.value = state.settings?.deviceType || '';
}

async function saveProvisionSettings() {
  try {
    const res = await fetch('/api/test/provision/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoFlash: autoFlash.value, deviceType: flashDeviceType.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || '设置保存失败');
    applyProvisionState(data);
  } catch (error: any) {
    ElMessage.error(error?.message || '设置保存失败');
    await loadProvisionState();
  }
}

async function retryPort(port: ProvisionPort) {
  retryLoading.value[port.path] = true;
  try {
    const res = await fetch(`/api/test/provision/ports/${encodeURIComponent(port.path)}/retry`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || '重试失败');
    applyProvisionState(data);
  } catch (error: any) {
    ElMessage.error(error?.message || '重试失败');
  } finally {
    retryLoading.value[port.path] = false;
  }
}

function stageLabel(stage: string) {
  return STAGE_LABELS[stage] || stage;
}

function stageTagType(stage: string) {
  if (stage === 'connected') return 'success';
  if (stage === 'failed') return 'danger';
  if (stage === 'flashing') return 'warning';
  return 'info';
}

function connectSSE() {
  eventSource.value = new EventSource('/api/test/stream');
  
  eventSource.value.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'update') {
        updateDeviceData(msg.deviceId, msg.data);
      } else if (msg.type === 'provision') {
        applyProvisionState(msg.state);
        // 端口刚连上时设备列表还没这台设备，拉一次让它出现在下面的测试表里
        if (msg.state?.ports?.some((p: ProvisionPort) => p.stage === 'connected')) refreshDevices();
      }
    } catch (e) {
      console.error('SSE 解析失败', e);
    }
  };
}

function updateDeviceData(deviceId: string, data: any) {
  const device = devices.value.find(d => d.id === deviceId);
  if (device) {
    device.data = { ...device.data, ...data };
  } else {
    // 如果是新设备，刷新列表（简单处理）
    refreshDevices();
  }
}

async function restartTest(device: Device) {
  try {
    await fetch(`/api/test/device/${device.id}/start`, { method: 'POST' });
    ElMessage.success('已发送开始命令');
  } catch (e) {
    ElMessage.error('发送失败');
  }
}

async function blinkDevice(device: Device) {
  blinkLoading.value[device.id] = true;
  try {
    const res = await fetch('/api/mqtt-client/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: `/drecv/${device.id}`,
        message: { method: 'action', action: 'blink' },
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || data.message || '下发失败');
    ElMessage.success('已下发闪烁指令');
  } catch (error: any) {
    ElMessage.error(error?.message || '下发失败');
  } finally {
    blinkLoading.value[device.id] = false;
  }
}

// 辅助函数
function hasMonitorData(type: string) {
  const config = deviceTypeConfigs.value[type];
  return config?.monitorData && config.monitorData.length > 0;
}

function getMonitorData(device: Device) {
  const config = deviceTypeConfigs.value[device.type];
  return config?.monitorData || [];
}

function formatValue(val: any, unit?: string) {
  if (val === undefined || val === null) return '-';
  return unit ? `${val} ${unit}` : val;
}

function getMonitorColor(config: any, val: any) {
  // 简单根据是否有值显示颜色，或者可以复用之前的阈值逻辑
  return val !== undefined ? 'var(--accent)' : 'var(--text-muted)';
}
</script>

<style scoped>
.auto-test-page {
  padding: 20px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.provision-card {
  margin-bottom: 16px;
}

.provision-options {
  display: flex;
  align-items: center;
  gap: 12px;
}

.type-select {
  width: 140px;
}

.provision-alert {
  margin-bottom: 12px;
}

.error-code {
  color: var(--text-muted);
  font-size: 12px;
  margin-left: 4px;
}

.text-danger {
  color: var(--el-color-danger);
}

.monitor-data {
  display: flex;
  flex-wrap: wrap;
  gap: 15px;
}

.monitor-item {
  display: flex;
  align-items: center;
  gap: 5px;
  background: var(--bg-app);
  padding: 4px 8px;
  border-radius: 4px;
}

.label {
  color: var(--text-secondary);
  font-weight: 500;
}

.value {
  font-weight: bold;
}

.no-data {
  color: var(--text-muted);
  font-size: 12px;
}

.action-buttons {
  display: flex;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
