<template>
  <div class="page">
    <h1>设备管理</h1>

    <section class="card">
      <div class="row header-row">
        <div class="stats">
          <span>总数：<strong>{{ devices.length }}</strong></span>
          <span>在线：<strong class="ok">{{ connectedCount }}</strong></span>
          <span>离线：<strong class="error">{{ disconnectedCount }}</strong></span>
        </div>
        <div class="actions">
          <button @click="refreshDevices" :disabled="loading">{{ loading ? '刷新中...' : '刷新列表' }}</button>
          <button @click="clearAllDevices" :disabled="loading || devices.length === 0" class="danger">清空设备</button>
        </div>
      </div>

      <div class="row" v-if="loadError">
        <span class="error">{{ loadError }}</span>
      </div>

      <div class="table-wrap">
        <table class="device-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>设备ID</th>
              <th>状态</th>
              <th>电量</th>
              <th>最后上报</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="dev in devices" :key="dev.id" :class="{ selected: dev.id === selectedDeviceId }" @click="selectDevice(dev.id)">
              <td>{{ deviceTypeMap[dev.type] || dev.type }}</td>
              <td>{{ dev.id }}</td>
              <td>
                <span class="status-badge" :class="dev.connected ? 'online' : 'offline'">{{ dev.connected ? '在线' : '离线' }}</span>
              </td>
              <td><span class="battery-level" :class="getBatteryLevelClass(dev.data?.battery)">{{ formatBattery(dev.data?.battery) }}</span></td>
              <td>{{ formatLastReport(dev.lastReport) }}</td>
              <td>
                <button @click.stop="removeDevice(dev.id)" class="danger">删除</button>
              </td>
            </tr>
            <tr v-if="devices.length === 0">
              <td colspan="6" class="muted">暂无设备数据</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2>设备详情</h2>
      <div v-if="selectedDevice" class="detail">
        <div class="detail-grid">
          <div class="detail-item"><label>设备名称</label><span>{{ selectedDevice.name }}</span></div>
          <div class="detail-item"><label>设备ID</label><span>{{ selectedDevice.id }}</span></div>
          <div class="detail-item"><label>设备类型</label><span>{{ deviceTypeMap[selectedDevice.type] || selectedDevice.type }}</span></div>
          <div class="detail-item"><label>连接状态</label>
            <span class="status-badge" :class="selectedDevice.connected ? 'online' : 'offline'">{{ selectedDevice.connected ? '在线' : '离线' }}</span>
          </div>
          <div class="detail-item"><label>最后上报</label><span>{{ formatLastReport(selectedDevice.lastReport) }}</span></div>
          <div class="detail-item"><label>电量</label>
            <span class="battery-level" :class="getBatteryLevelClass(selectedDevice.data?.battery)">{{ formatBattery(selectedDevice.data?.battery) }}</span>
          </div>
        </div>

        <div v-if="selectedDevice.data && Object.keys(selectedDevice.data).length > 0" class="device-data">
          <div class="row space-between">
            <h3>设备数据</h3>
            <div class="row">
              <button v-if="!isEditing" @click="startEdit">编辑</button>
              <template v-else>
                <button @click="saveChanges" class="primary">保存</button>
                <button @click="cancelEdit">取消</button>
              </template>
            </div>
          </div>

          <div class="data-grid">
            <div v-for="(value, key) in selectedDevice.data" :key="key" class="data-item">
              <label>{{ key }}</label>
              <template v-if="!isEditing">
                <span>{{ value }}</span>
              </template>
              <template v-else>
                <input v-if="getInputType(value) === 'number'" v-model="editData[key]" type="number" />
                <input v-else-if="getInputType(value) === 'checkbox'" v-model="editData[key]" type="checkbox" />
                <input v-else v-model="editData[key]" type="text" />
              </template>
            </div>
          </div>
        </div>
      </div>
      <p v-else class="muted">请选择一个设备查看详情</p>
    </section>
  </div>
  
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

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

function selectDevice(id: string) {
  selectedDeviceId.value = id;
}

async function clearAllDevices() {
  if (!confirm('确定要删除所有设备吗？此操作不可恢复！')) return;
  try {
    const res = await fetch('/api/devices/all', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || '清空设备失败');
    devices.value = [];
    selectedDeviceId.value = '';
  } catch (e: any) {
    alert(e?.message || '清空设备失败');
  }
}

async function removeDevice(id: string) {
  if (!confirm('确定要删除这个设备吗？')) return;
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || '删除设备失败');
    devices.value = devices.value.filter(d => d.id !== id);
    if (selectedDeviceId.value === id) selectedDeviceId.value = '';
  } catch (e: any) {
    alert(e?.message || '删除设备失败');
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
  } catch (e: any) {
    alert(e?.message || '保存失败');
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

function getBatteryLevelClass(battery: any) {
  if (battery === undefined || battery === null) return 'unknown';
  const level = typeof battery === 'number' ? battery : parseFloat(String(battery));
  if (isNaN(level)) return 'unknown';
  if (level <= 20) return 'low';
  if (level <= 50) return 'medium';
  return 'high';
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
.page { max-width: 960px; margin: 40px auto; padding: 0 24px; text-align: left; }
.row { display: flex; gap: 12px; align-items: center; }
.space-between { justify-content: space-between; }
.card { margin-top: 24px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fafafa; }
.header-row { justify-content: space-between; }
.stats { display: flex; gap: 16px; color: #6b7280; }
.actions button { padding: 6px 12px; border: 1px solid #0ea5e9; background: #0ea5e9; color: white; border-radius: 6px; cursor: pointer; }
.actions button.danger { border-color: #e11d48; background: #e11d48; }
.actions button:disabled { opacity: 0.6; cursor: not-allowed; }
.error { color: #e11d48; }
.ok { color: #16a34a; }
.muted { color: #6b7280; }

.table-wrap { overflow-x: auto; }
.device-table { width: 100%; border-collapse: collapse; }
.device-table th, .device-table td { border-bottom: 1px solid #e5e7eb; padding: 10px; text-align: left; }
.device-table thead th { background: #f3f4f6; }
.device-table tbody tr { cursor: pointer; }
.device-table tbody tr.selected { background: #e0f2fe; }

.status-badge { padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
.status-badge.online { background: #d4edda; color: #155724; }
.status-badge.offline { background: #f8d7da; color: #721c24; }

.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.detail-item { display: flex; justify-content: space-between; border-bottom: 1px solid #eee; padding: 6px 0; }
.detail-item label { color: #6b7280; }

.data-grid { display: grid; gap: 10px; }
.data-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.data-item input[type="text"], .data-item input[type="number"] { padding: 6px 8px; border: 1px solid #e5e7eb; border-radius: 6px; }

.battery-level { padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; text-align: center; min-width: 50px; display: inline-block; }
.battery-level.high { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
.battery-level.medium { background-color: #fff3cd; color: #856404; border: 1px solid #ffeaa7; }
.battery-level.low { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
.battery-level.unknown { background-color: #e2e3e5; color: #6c757d; border: 1px solid #d6d8db; }
</style>