<template>
  <div class="auto-test-page">
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

        <el-table-column label="操作" width="150" align="center">
          <template #default="{ row }">
            <el-button 
              type="primary" 
              size="small" 
              @click="restartTest(row)"
            >
              重新开始
            </el-button>
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

const devices = ref<Device[]>([]);
const deviceTypeMap = ref<Record<string, string>>({});
const deviceTypeConfigs = ref<Record<string, any>>({});
const eventSource = ref<EventSource | null>(null);

const onlineDevices = computed(() => devices.value.filter(d => d.connected));

onMounted(async () => {
  try {
    // 1. 加载配置和设备列表
    await Promise.all([loadDeviceTypes(), loadDeviceTypeConfigs(), refreshDevices()]);
    
    // 2. 启动测试平台
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
  await fetch('/api/test/start', { method: 'POST' });
}

function connectSSE() {
  eventSource.value = new EventSource('/api/test/stream');
  
  eventSource.value.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'update') {
        updateDeviceData(msg.deviceId, msg.data);
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
  return val !== undefined ? '#409EFF' : '#909399';
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

.monitor-data {
  display: flex;
  flex-wrap: wrap;
  gap: 15px;
}

.monitor-item {
  display: flex;
  align-items: center;
  gap: 5px;
  background: #f5f7fa;
  padding: 4px 8px;
  border-radius: 4px;
}

.label {
  color: #606266;
  font-weight: 500;
}

.value {
  font-weight: bold;
}

.no-data {
  color: #909399;
  font-size: 12px;
}
</style>
