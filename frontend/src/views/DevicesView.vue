<template>
  <div class="devices-page">

    <el-card class="stats-card" shadow="never">
      <div class="stats-header">
        <div class="stats-info">
          <el-statistic title="总设备数" :value="devices.length" />
          <el-statistic title="在线设备" :value="connectedCount" class="online-stat" />
          <el-statistic title="离线设备" :value="disconnectedCount" class="offline-stat" />
        </div>
        <div class="actions">
          <el-button 
            type="primary" 
            :icon="Refresh" 
            :loading="loading"
            @click="refreshDevices"
          >
            {{ loading ? '刷新中...' : '刷新列表' }}
          </el-button>
          <el-button 
            type="danger" 
            :icon="Delete"
            :disabled="loading || devices.length === 0"
            @click="clearAllDevices"
          >
            清空设备
          </el-button>
        </div>
      </div>
    </el-card>

    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      :closable="false"
      style="margin: 10px 0"
    />

    <el-card shadow="never">
      <template #header>
        <span>设备列表</span>
      </template>
      
      <el-table 
        :data="devices" 
        style="width: 100%"
        highlight-current-row
        @current-change="handleCurrentChange"
        v-loading="loading"
        empty-text="暂无设备数据"
      >
        <el-table-column prop="type" label="类型" width="120">
          <template #default="{ row }">
            {{ deviceTypeMap[row.type] || row.type }}
          </template>
        </el-table-column>
        
        <el-table-column prop="id" label="设备ID" min-width="150" />
        
        <el-table-column prop="connected" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.connected ? 'success' : 'danger'" size="small">
              {{ row.connected ? '在线' : '离线' }}
            </el-tag>
          </template>
        </el-table-column>
        
        <el-table-column prop="battery" label="电量" width="120">
          <template #default="{ row }">
            <el-tag 
              :type="getBatteryTagType(row.data?.battery)" 
              size="small"
            >
              {{ formatBattery(row.data?.battery) }}
            </el-tag>
          </template>
        </el-table-column>
        
        <el-table-column prop="lastReport" label="最后上报" width="150">
          <template #default="{ row }">
            {{ formatLastReport(row.lastReport) }}
          </template>
        </el-table-column>
        
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button 
              type="danger" 
              size="small"
              :icon="Delete"
              @click="removeDevice(row.id)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="selectedDevice" shadow="never" style="margin-top: 10px">
      <template #header>
        <div class="device-detail-header">
          <span>设备详情</span>
          <el-button-group v-if="selectedDevice.data && Object.keys(selectedDevice.data).length > 0">
            <el-button 
              v-if="!isEditing" 
              type="primary" 
              size="small"
              :icon="Edit"
              @click="startEdit"
            >
              编辑
            </el-button>
            <template v-else>
              <el-button 
                type="success" 
                size="small"
                :icon="Check"
                @click="saveChanges"
              >
                保存
              </el-button>
              <el-button 
                size="small"
                :icon="Close"
                @click="cancelEdit"
              >
                取消
              </el-button>
            </template>
          </el-button-group>
        </div>
      </template>

      <el-row :gutter="20">
        <el-col :xs="24" :sm="12" :md="8">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="设备名称">{{ selectedDevice.name }}</el-descriptions-item>
            <el-descriptions-item label="设备ID">{{ selectedDevice.id }}</el-descriptions-item>
            <el-descriptions-item label="设备类型">{{ deviceTypeMap[selectedDevice.type] || selectedDevice.type }}</el-descriptions-item>
            <el-descriptions-item label="连接状态">
              <el-tag :type="selectedDevice.connected ? 'success' : 'danger'" size="small">
                {{ selectedDevice.connected ? '在线' : '离线' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="最后上报">{{ formatLastReport(selectedDevice.lastReport) }}</el-descriptions-item>
            <el-descriptions-item label="电量">
              <el-tag :type="getBatteryTagType(selectedDevice.data?.battery)" size="small">
                {{ formatBattery(selectedDevice.data?.battery) }}
              </el-tag>
            </el-descriptions-item>
          </el-descriptions>
        </el-col>
        
        <el-col :xs="24" :sm="12" :md="16" v-if="selectedDevice.data && Object.keys(selectedDevice.data).length > 0">
          <h4>设备数据</h4>
          <el-form label-width="100px" v-if="!isEditing">
            <el-form-item v-for="(value, key) in selectedDevice.data" :key="key" :label="key">
              <span>{{ value }}</span>
            </el-form-item>
          </el-form>
          
          <el-form label-width="100px" v-else>
            <el-form-item v-for="(value, key) in selectedDevice.data" :key="key" :label="key">
              <el-input-number 
                v-if="getInputType(value) === 'number'" 
                v-model="editData[key]"
                style="width: 200px"
              />
              <el-switch 
                v-else-if="getInputType(value) === 'checkbox'" 
                v-model="editData[key]"
              />
              <el-input 
                v-else 
                v-model="editData[key]"
                style="width: 200px"
              />
            </el-form-item>
          </el-form>
        </el-col>
      </el-row>
    </el-card>

    <el-empty v-else description="请选择一个设备查看详情" style="margin-top: 20px" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { Refresh, Delete, Edit, Check, Close } from '@element-plus/icons-vue'

interface DeviceData { [key: string]: any }
interface Device {
  id: string;
  name: string;
  type: string;
  connected: boolean;
  lastReport: string | null;
  data: DeviceData;
}

const devices = ref<Device[]>([]);
const deviceTypeMap = ref<Record<string, string>>({});
const loading = ref(false);
const loadError = ref('');
const selectedDeviceId = ref('');

const selectedDevice = computed<Device | null>(() => {
  return devices.value.find(d => d.id === selectedDeviceId.value) || null;
});
const connectedCount = computed(() => devices.value.filter(d => d.connected).length);
const disconnectedCount = computed(() => devices.value.filter(d => !d.connected).length);

// 编辑状态
const isEditing = ref(false);
const editData = ref<DeviceData>({});
const originalData = ref<DeviceData>({});

onMounted(async () => {
  await init();
});

async function init() {
  loading.value = true;
  loadError.value = '';
  try {
    await Promise.all([loadDeviceTypes(), refreshDevices()]);
  } catch (e: any) {
    loadError.value = e?.message || '数据加载失败';
  } finally {
    loading.value = false;
  }
}

async function loadDeviceTypes() {
  const res = await fetch('/api/device-types');
  if (!res.ok) throw new Error('设备类型获取失败');
  deviceTypeMap.value = await res.json();
}

async function refreshDevices() {
  const res = await fetch('/api/devices');
  if (!res.ok) throw new Error('设备列表获取失败');
  devices.value = await res.json();
}



function handleCurrentChange(currentRow: Device | null) {
  if (currentRow) {
    selectedDeviceId.value = currentRow.id;
  }
}

async function clearAllDevices() {
  try {
    await ElMessageBox.confirm(
      '确定要删除所有设备吗？此操作不可恢复！',
      '警告',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning',
      }
    );
    
    const res = await fetch('/api/devices/all', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || '清空设备失败');
    devices.value = [];
    selectedDeviceId.value = '';
    ElMessage.success('设备清空成功');
  } catch (error: any) {
    if (error !== 'cancel') {
      ElMessage.error(error?.message || '清空设备失败');
    }
  }
}

async function removeDevice(id: string) {
  try {
    await ElMessageBox.confirm(
      '确定要删除这个设备吗？',
      '确认删除',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning',
      }
    );
    
    const res = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || '删除设备失败');
    devices.value = devices.value.filter(d => d.id !== id);
    if (selectedDeviceId.value === id) selectedDeviceId.value = '';
    ElMessage.success('设备删除成功');
  } catch (error: any) {
    if (error !== 'cancel') {
      ElMessage.error(error?.message || '删除设备失败');
    }
  }
}

function startEdit() {
  if (!selectedDevice.value || !selectedDevice.value.data) return;
  isEditing.value = true;
  originalData.value = JSON.parse(JSON.stringify(selectedDevice.value.data));
  editData.value = JSON.parse(JSON.stringify(selectedDevice.value.data));
}

function cancelEdit() {
  isEditing.value = false;
  editData.value = {};
  originalData.value = {};
}

async function saveChanges() {
  if (!selectedDevice.value) return;
  try {
    const updateData: Record<string, any> = { method: 'update' };
    for (const key in editData.value) {
      if (editData.value[key] !== originalData.value[key]) {
        const originalValue = originalData.value[key];
        let newValue = editData.value[key];
        if (typeof originalValue === 'number') {
          newValue = Number(newValue);
        } else if (typeof originalValue === 'boolean') {
          newValue = newValue === 'true' || newValue === true;
        }
        updateData[key] = newValue;
      }
    }
    if (Object.keys(updateData).length === 1) { // 没有变更
      cancelEdit();
      return;
    }
    const topic = `/drecv/${selectedDevice.value.id}`;
    const ok = await publishMessage(topic, updateData);
    if (!ok) throw new Error('消息下发失败');
    // 更新本地数据与状态
    devices.value = devices.value.map(d => {
      if (d.id === selectedDevice!.value!.id) {
        const merged = { ...d.data };
        for (const k in updateData) {
          if (k !== 'method') merged[k] = updateData[k];
        }
        return { ...d, data: merged, connected: true, lastReport: new Date().toISOString() };
      }
      return d;
    });
    cancelEdit();
    ElMessage.success('设备数据更新成功');
  } catch (e: any) {
    ElMessage.error(e?.message || '保存失败');
  }
}

async function publishMessage(topic: string, message: any) {
  const res = await fetch('/api/mqtt-client/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, message })
  });
  const data = await res.json();
  if (!res.ok || data.error) return false;
  return true;
}

function getInputType(value: any): 'number' | 'checkbox' | 'text' {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'checkbox';
  return 'text';
}

function formatBattery(battery: any) {
  if (battery === undefined || battery === null) return '未知';
  if (typeof battery === 'number') return `${Math.round(battery)}%`;
  const num = Number(battery);
  if (!isNaN(num)) return `${Math.round(num)}%`;
  return String(battery);
}



function getBatteryTagType(battery: any): 'success' | 'warning' | 'danger' | 'info' {
  if (battery === undefined || battery === null) return 'info';
  const level = typeof battery === 'number' ? battery : parseFloat(String(battery));
  if (isNaN(level)) return 'info';
  if (level <= 20) return 'danger';
  if (level <= 50) return 'warning';
  return 'success';
}

function formatLastReport(timestamp: string | null) {
  if (!timestamp) return '从未上报';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}
</script>

<style scoped>
.devices-page {
  padding: 20px;
}

.stats-card {
  margin-bottom: 20px;
}

.stats-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 20px;
}

.stats-info {
  display: flex;
  gap: 40px;
  flex-wrap: wrap;
}

.online-stat :deep(.el-statistic__number) {
  color: #67c23a;
}

.offline-stat :deep(.el-statistic__number) {
  color: #f56c6c;
}

.actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.device-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .devices-page {
    padding: 15px;
  }
  
  .stats-header {
    flex-direction: column;
    align-items: stretch;
  }
  
  .stats-info {
    justify-content: space-around;
    gap: 20px;
  }
  
  .actions {
    justify-content: center;
  }
  
  .device-detail-header {
    flex-direction: column;
    align-items: stretch;
  }
  
  .device-detail-header .el-button-group {
    align-self: center;
  }
}

@media (max-width: 480px) {
  .devices-page {
    padding: 10px;
  }
  
  .stats-info {
    flex-direction: column;
    gap: 15px;
  }
  
  .actions .el-button {
    flex: 1;
  }
}
</style>