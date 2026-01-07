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
          <el-checkbox v-model="autoRefreshEnabled" style="margin-left: 12px;">
            自动刷新(3秒)
          </el-checkbox>
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
      
      <!-- 桌面端：在线设备表格 -->
      <h4 style="margin: 8px 0 12px">在线设备（{{ connectedCount }}）</h4>
      <el-table 
        :data="onlineDevices" 
        style="width: 100%"
        highlight-current-row
        @current-change="handleCurrentChange"
        v-loading="loading"
        empty-text="暂无在线设备"
        class="desktop-table"
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
        
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <div class="table-actions">
              <el-button 
                v-if="hasMonitorData(row.type)"
                type="primary" 
                size="small"
                @click="openMonitorModal(row)"
              >
                数据监控
              </el-button>
              <el-dropdown 
                v-if="hasOperations(row.type)"
                @command="(command: any) => executeDeviceOperation(row, command)"
                trigger="click"
              >
                <el-button type="success" size="small">
                   操作 <el-icon class="el-icon--right"><ArrowDown /></el-icon>
                 </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item 
                      v-for="operation in getDeviceOperations(row.type)" 
                      :key="operation.key"
                      :command="operation"
                    >
                      {{ operation.name }}
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-button 
                type="danger" 
                size="small"
                :icon="Delete"
                @click="removeDevice(row.id)"
              >
                删除
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <!-- 桌面端：离线设备折叠表格 -->
      <el-collapse v-model="offlineCollapseActive" class="desktop-table">
        <el-collapse-item :name="'offline'">
          <template #title>
            <span>离线设备（{{ disconnectedCount }}）</span>
          </template>
          <el-table 
            :data="offlineDevices" 
            style="width: 100%"
            empty-text="暂无离线设备"
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
            <el-table-column label="操作" width="200">
              <template #default="{ row }">
                <div class="table-actions">
                  <el-button 
                    v-if="hasMonitorData(row.type)"
                    type="primary" 
                    size="small"
                    @click="openMonitorModal(row)"
                  >
                    数据监控
                  </el-button>
                  <el-dropdown 
                    v-if="hasOperations(row.type)"
                    @command="(command: any) => executeDeviceOperation(row, command)"
                    trigger="click"
                  >
                    <el-button type="success" size="small">
                       操作 <el-icon class="el-icon--right"><ArrowDown /></el-icon>
                     </el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item 
                          v-for="operation in getDeviceOperations(row.type)" 
                          :key="operation.key"
                          :command="operation"
                        >
                          {{ operation.name }}
                        </el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                  <el-button 
                    type="danger" 
                    size="small"
                    :icon="Delete"
                    @click="removeDevice(row.id)"
                  >
                    删除
                  </el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>

      <!-- 移动端：在线设备卡片 -->
      <h4 class="mobile-device-list" style="margin: 8px 0 12px">在线设备（{{ connectedCount }}）</h4>
      <div class="mobile-device-list">
        <div 
          v-for="device in onlineDevices" 
          :key="device.id" 
          class="mobile-device-card"
          @click="selectDevice(device)"
        >
          <div class="device-card-header">
            <div class="device-type">
              {{ deviceTypeMap[device.type] || device.type }}
            </div>
            <el-tag :type="device.connected ? 'success' : 'danger'" size="small">
              {{ device.connected ? '在线' : '离线' }}
            </el-tag>
          </div>
          
          <div class="device-card-content">
            <div class="device-info-row">
              <span class="info-label">设备ID:</span>
              <span class="info-value">{{ device.id }}</span>
            </div>
            
            <div class="device-info-row">
              <span class="info-label">电量:</span>
              <el-tag 
                :type="getBatteryTagType(device.data?.battery)" 
                size="small"
              >
                {{ formatBattery(device.data?.battery) }}
              </el-tag>
            </div>
            
            <div class="device-info-row">
              <span class="info-label">最后上报:</span>
              <span class="info-value">{{ formatLastReport(device.lastReport) }}</span>
            </div>
          </div>
          
          <div class="device-card-actions">
            <el-button 
              v-if="hasMonitorData(device.type)"
              type="primary" 
              size="small"
              @click.stop="openMonitorModal(device)"
            >
              数据监控
            </el-button>
            <el-dropdown 
              v-if="hasOperations(device.type)"
              @command="(command: any) => executeDeviceOperation(device, command)"
              trigger="click"
            >
              <el-button type="success" size="small" @click.stop>
                 操作 <el-icon class="el-icon--right"><ArrowDown /></el-icon>
               </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item 
                    v-for="operation in getDeviceOperations(device.type)" 
                    :key="operation.key"
                    :command="operation"
                  >
                    {{ operation.name }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button 
              type="danger" 
              size="small"
              :icon="Delete"
              @click.stop="removeDevice(device.id)"
            >
              删除
            </el-button>
          </div>
        </div>
      </div>

      <!-- 移动端：离线设备折叠卡片 -->
      <el-collapse v-model="offlineCollapseActive" class="mobile-device-list">
        <el-collapse-item :name="'offline'">
          <template #title>
            <span>离线设备（{{ disconnectedCount }}）</span>
          </template>
          <div class="mobile-device-list">
            <div 
              v-for="device in offlineDevices" 
              :key="device.id" 
              class="mobile-device-card"
              @click="selectDevice(device)"
            >
              <div class="device-card-header">
                <div class="device-type">
                  {{ deviceTypeMap[device.type] || device.type }}
                </div>
                <el-tag :type="device.connected ? 'success' : 'danger'" size="small">
                  {{ device.connected ? '在线' : '离线' }}
                </el-tag>
              </div>
              <div class="device-card-content">
                <div class="device-info-row">
                  <span class="info-label">设备ID:</span>
                  <span class="info-value">{{ device.id }}</span>
                </div>
                <div class="device-info-row">
                  <span class="info-label">电量:</span>
                  <el-tag 
                    :type="getBatteryTagType(device.data?.battery)" 
                    size="small"
                  >
                    {{ formatBattery(device.data?.battery) }}
                  </el-tag>
                </div>
                <div class="device-info-row">
                  <span class="info-label">最后上报:</span>
                  <span class="info-value">{{ formatLastReport(device.lastReport) }}</span>
                </div>
              </div>
              <div class="device-card-actions">
                <el-button 
                  v-if="hasMonitorData(device.type)"
                  type="primary" 
                  size="small"
                  @click.stop="openMonitorModal(device)"
                >
                  数据监控
                </el-button>
                <el-dropdown 
                  v-if="hasOperations(device.type)"
                  @command="(command: any) => executeDeviceOperation(device, command)"
                  trigger="click"
                >
                  <el-button type="success" size="small" @click.stop>
                     操作 <el-icon class="el-icon--right"><ArrowDown /></el-icon>
                   </el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item 
                        v-for="operation in getDeviceOperations(device.type)" 
                        :key="operation.key"
                        :command="operation"
                      >
                        {{ operation.name }}
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
                <el-button 
                  type="danger" 
                  size="small"
                  :icon="Delete"
                  @click.stop="removeDevice(device.id)"
                >
                  删除
                </el-button>
              </div>
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>
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

        <!-- 设备操作 -->
        <el-col :xs="24" :sm="12" :md="8" v-if="deviceOperations.length > 0">
          <h4>设备操作</h4>
          <div class="device-operations">
            <el-button 
              v-for="operation in deviceOperations" 
              :key="operation.key"
              :type="operation.type || 'primary'"
              :loading="operationLoading[operation.key]"
              @click="executeOperation(operation)"
              style="margin-bottom: 8px; width: 100%;"
            >
              {{ operation.name }}
            </el-button>
          </div>
        </el-col>

        <!-- 监控数据 -->
        <el-col :xs="24" :sm="12" :md="8" v-if="monitorData && Object.keys(monitorData).length > 0">
          <h4>监控数据 
            <el-tag :type="monitorConnected ? 'success' : 'danger'" size="small">
              {{ monitorConnected ? '实时' : '离线' }}
            </el-tag>
          </h4>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item 
              v-for="(config, key) in deviceMonitorConfig" 
              :key="key" 
              :label="config.name"
            >
              <span :style="{ color: getMonitorValueColor(String(key), monitorData[key]) }">
                {{ formatMonitorValue(String(key), monitorData[key]) }}
              </span>
            </el-descriptions-item>
          </el-descriptions>
        </el-col>
      </el-row>
    </el-card>

    <el-empty v-else description="请选择一个设备查看详情" style="margin-top: 20px" />

    <div style="margin-top: 30px; text-align: center;">
      <el-button link type="info" @click="$router.push('/test')" style="opacity: 0.3;">自动化测试</el-button>
    </div>

    <!-- 数据监控弹窗 -->
    <DeviceMonitorModal 
      :visible="monitorModalVisible"
      :device-info="monitorDevice"
      @close="closeMonitorModal"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { Refresh, Delete, Edit, Check, Close, ArrowDown } from '@element-plus/icons-vue'
import DeviceMonitorModal from '../components/DeviceMonitorModal.vue'

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
const deviceTypeConfigs = ref<Record<string, any>>({});
const loading = ref(false);
const loadError = ref('');
const selectedDeviceId = ref('');
const autoRefreshEnabled = ref(true);
const autoRefreshTimer = ref<number | null>(null);

// 设备操作相关
const operationLoading = ref<Record<string, boolean>>({});

// 监控数据相关
const monitorData = ref<Record<string, any>>({});
const monitorConnected = ref(false);
const monitorEventSource = ref<EventSource | null>(null);

// 监控弹窗相关
const monitorModalVisible = ref(false);
const monitorDevice = ref<Device | null>(null);

const selectedDevice = computed<Device | null>(() => {
  return devices.value.find(d => d.id === selectedDeviceId.value) || null;
});
const connectedCount = computed(() => devices.value.filter(d => d.connected).length);
const disconnectedCount = computed(() => devices.value.filter(d => !d.connected).length);
const onlineDevices = computed(() => devices.value.filter(d => d.connected));
const offlineDevices = computed(() => devices.value.filter(d => !d.connected));
const offlineCollapseActive = ref<string[]>([]);

// 当前设备的操作配置
const deviceOperations = computed(() => {
  if (!selectedDevice.value) return [];
  const config = deviceTypeConfigs.value[selectedDevice.value.type];
  return config?.operations || [];
});

// 当前设备的监控数据配置
const deviceMonitorConfig = computed(() => {
  if (!selectedDevice.value) return {};
  const config = deviceTypeConfigs.value[selectedDevice.value.type];
  return config?.monitorData || {};
});

// 编辑状态
const isEditing = ref(false);
const editData = ref<DeviceData>({});
const originalData = ref<DeviceData>({});

onMounted(async () => {
  await init();
  if (autoRefreshEnabled.value) startAutoRefresh();
});

onUnmounted(() => {
  closeMonitorConnection();
  stopAutoRefresh();
});

async function init() {
  loading.value = true;
  loadError.value = '';
  try {
    await Promise.all([loadDeviceTypes(), loadDeviceTypeConfigs(), refreshDevices()]);
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

async function loadDeviceTypeConfigs() {
  const res = await fetch('/api/device-types/configs');
  if (!res.ok) throw new Error('设备类型配置获取失败');
  deviceTypeConfigs.value = await res.json();
}

async function refreshDevices() {
  const res = await fetch('/api/devices');
  if (!res.ok) throw new Error('设备列表获取失败');
  const list: Device[] = await res.json();
  devices.value = list;
  // 刷新后保留原选中设备；若设备已不存在则清空并关闭监控
  if (selectedDeviceId.value) {
    const exists = list.some(d => d.id === selectedDeviceId.value);
    if (!exists) {
      selectedDeviceId.value = '';
      closeMonitorConnection();
    }
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer.value = window.setInterval(() => {
    refreshDevices();
  }, 3000);
}

function stopAutoRefresh() {
  if (autoRefreshTimer.value) {
    clearInterval(autoRefreshTimer.value);
    autoRefreshTimer.value = null;
  }
}

watch(autoRefreshEnabled, (enabled) => {
  if (enabled) startAutoRefresh();
  else stopAutoRefresh();
});



function handleCurrentChange(currentRow: Device | null) {
  // 仅在明确选中新的行时才切换设备与监控连接
  if (currentRow) {
    closeMonitorConnection();
    selectedDeviceId.value = currentRow.id;
  }
}

function selectDevice(device: Device) {
  closeMonitorConnection();
  selectedDeviceId.value = device.id;
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

// 执行设备操作
async function executeOperation(operation: any) {
  if (!selectedDevice.value) return;
  
  const operationKey = operation.key;
  operationLoading.value[operationKey] = true;
  
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(selectedDevice.value.id)}/operations/${operationKey}`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || '操作执行失败');
    ElMessage.success(`${operation.name} 执行成功`);
  } catch (error: any) {
    ElMessage.error(error?.message || `${operation.name} 执行失败`);
  } finally {
    operationLoading.value[operationKey] = false;
  }
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

// 建立监控数据连接
async function setupMonitorConnection(deviceId: string, deviceType: string) {
  const config = deviceTypeConfigs.value[deviceType];
  if (!config?.monitorData || Object.keys(config.monitorData).length === 0) {
    return;
  }

  try {
    // 先获取当前监控数据
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/monitor-data`);
    if (res.ok) {
      const data = await res.json();
      if (!data.error) {
        monitorData.value = data;
      }
    }

    // 建立SSE连接获取实时数据
    const eventSource = new EventSource(`/api/devices/${encodeURIComponent(deviceId)}/monitor-stream`);
    
    eventSource.onopen = () => {
      monitorConnected.value = true;
    };
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        monitorData.value = { ...monitorData.value, ...data };
      } catch (e) {
        console.error('解析监控数据失败:', e);
      }
    };
    
    eventSource.onerror = () => {
      monitorConnected.value = false;
    };
    
    monitorEventSource.value = eventSource;
  } catch (error) {
    console.error('建立监控连接失败:', error);
  }
}

// 关闭监控数据连接
function closeMonitorConnection() {
  if (monitorEventSource.value) {
    monitorEventSource.value.close();
    monitorEventSource.value = null;
  }
  monitorConnected.value = false;
  monitorData.value = {};
}

// 格式化监控数据值
function formatMonitorValue(key: string, value: any) {
  const config = deviceMonitorConfig.value[key];
  if (!config) return String(value || '-');
  
  if (value === undefined || value === null) return '-';
  
  if (config.unit) {
    return `${value}${config.unit}`;
  }
  
  return String(value);
}

// 获取监控数据值的颜色
function getMonitorValueColor(key: string, value: any) {
  const config = deviceMonitorConfig.value[key];
  if (!config || !config.thresholds || value === undefined || value === null) {
    return '#606266';
  }
  
  const numValue = Number(value);
  if (isNaN(numValue)) return '#606266';
  
  const { warning, danger } = config.thresholds;
  
  if (danger && numValue >= danger) return '#f56c6c';
  if (warning && numValue >= warning) return '#e6a23c';
  return '#67c23a';
}

// 检查设备是否支持监控数据
function hasMonitorData(deviceType: string) {
  const config = deviceTypeConfigs.value[deviceType];
  return config?.monitorData && Object.keys(config.monitorData).length > 0;
}

// 检查设备是否支持操作
function hasOperations(deviceType: string) {
  const config = deviceTypeConfigs.value[deviceType];
  return config?.operations && config.operations.length > 0;
}

// 获取设备操作列表
function getDeviceOperations(deviceType: string) {
  const config = deviceTypeConfigs.value[deviceType];
  return config?.operations || [];
}

// 打开监控弹窗
function openMonitorModal(device: Device) {
  monitorDevice.value = device;
  if (selectedDeviceId.value !== device.id) {
    selectedDeviceId.value = device.id;
  }
  closeMonitorConnection();
  setupMonitorConnection(device.id, device.type);
  monitorModalVisible.value = true;
}

// 关闭监控弹窗
function closeMonitorModal() {
  monitorModalVisible.value = false;
  monitorDevice.value = null;
  closeMonitorConnection();
}

// 执行设备操作（从表格/卡片操作按钮）
async function executeDeviceOperation(device: Device, operation: any) {
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(device.id)}/operations/${operation.key}`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || '操作执行失败');
    ElMessage.success(`${operation.name} 执行成功`);
  } catch (error: any) {
    ElMessage.error(error?.message || `${operation.name} 执行失败`);
  }
}
</script>

<style scoped>
.devices-page {
  padding: 20px;
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  box-sizing: border-box;
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

.table-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* 移动端卡片样式 */
.mobile-device-list {
  display: none;
}

.mobile-device-card {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  margin-bottom: 12px;
  padding: 16px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.device-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #f0f0f0;
}

.device-type {
  font-weight: 600;
  font-size: 16px;
  color: #303133;
}

.device-card-content {
  margin-bottom: 12px;
}

.device-info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 14px;
}

.device-info-row:last-child {
  margin-bottom: 0;
}

.info-label {
  color: #606266;
  font-weight: 500;
  min-width: 80px;
}

.info-value {
  color: #303133;
  flex: 1;
  text-align: right;
  word-break: break-all;
}

.device-card-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px solid #f0f0f0;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .devices-page {
    padding: 12px;
  }
  
  .stats-card {
    margin-bottom: 16px;
  }
  
  .stats-header {
    flex-direction: column;
    align-items: stretch;
    gap: 16px;
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
  
  /* 隐藏桌面端表格，显示移动端卡片 */
  .desktop-table {
    display: none;
    width: 100%;
    overflow-x: auto;
  }
  
  .mobile-device-list {
    display: block;
  }
}

@media (max-width: 480px) {
  .devices-page {
    padding: 8px;
  }
  
  .stats-card {
    margin-bottom: 12px;
  }
  
  .stats-info {
    flex-direction: column;
    gap: 12px;
    text-align: center;
  }
  
  .actions {
    flex-direction: column;
    gap: 8px;
  }
  
  .actions .el-button {
    width: 100%;
  }
  
  .mobile-device-card {
    padding: 12px;
    margin-bottom: 8px;
  }
  
  .device-type {
    font-size: 15px;
  }
  
  .device-info-row {
    font-size: 13px;
    margin-bottom: 6px;
  }
  
  .info-label {
    min-width: 70px;
  }
}
</style>
