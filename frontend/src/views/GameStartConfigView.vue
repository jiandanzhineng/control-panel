<template>
  <div class="game-start-config-page">
    <el-card shadow="never" class="config-header-card">
      <template #header>
        <div class="card-header">
          <el-icon><Setting /></el-icon>
          <span>启动前配置</span>
        </div>
      </template>
      <div class="game-overview">
        <div class="game-basic-info">
          <h2 class="game-title">{{ game?.name || '未知玩法' }}</h2>
          <p v-if="game?.description" class="game-description">{{ game?.description }}</p>
          <div class="game-meta">
            <el-tag size="small" type="info">
              版本：{{ game?.version || '-' }}
            </el-tag>
            <el-tag size="small" type="success">
              最后游玩：{{ formatLastPlayed(game?.lastPlayed) }}
            </el-tag>
          </div>
        </div>
        <div class="loading-status">
          <div v-if="loadingAll" class="loading-info">
            <el-icon class="is-loading"><Loading /></el-icon>
            <span>加载中...</span>
          </div>
          <el-alert 
            v-if="error" 
            :title="error" 
            type="error" 
            :closable="false"
            show-icon
          />
        </div>
      </div>
    </el-card>

    <!-- 设备映射 -->
    <el-card shadow="never" class="device-mapping-card">
      <template #header>
        <div class="card-header">
          <el-icon><Connection /></el-icon>
          <span>设备映射</span>
        </div>
      </template>
      <div v-if="loadingDevices" class="loading-container">
        <el-skeleton :rows="3" animated />
      </div>
      <el-alert 
        v-else-if="deviceError" 
        :title="deviceError" 
        type="error" 
        :closable="false"
        show-icon
      />
      <div v-else>
        <!-- 桌面端表格布局 -->
        <el-table :data="deviceMappings" stripe style="width: 100%">
          <el-table-column prop="roleName" label="游戏角色" width="200">
            <template #default="{ row }">
              <div class="role-info">
                <strong>{{ row.roleName }}</strong>
                <div class="role-description">{{ row.roleDescription }}</div>
                <div class="role-description">
                  <span v-if="row.deviceInterface">接口：{{ row.deviceInterface }}</span>
                  <span v-else-if="row.deviceType">类型：{{ typeName(row.deviceType) }}</span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="映射设备" width="380">
            <template #default="{ row }">
              <el-checkbox-group v-model="row.deviceIds" @change="updateMapping(row)" style="display:flex;flex-wrap:wrap;gap:8px">
                <el-checkbox
                  v-for="device in getAvailableDevicesForRole(row)"
                  :key="device.id"
                  :label="device.id"
                >{{ device.name }}</el-checkbox>
              </el-checkbox-group>
            </template>
          </el-table-column>
          <el-table-column label="设备状态" width="160">
            <template #default="{ row }">
              <el-tag :type="row.required ? 'danger' : 'success'" size="small" style="margin-right:8px">{{ row.required ? '必需' : '可选' }}</el-tag>
              <el-tag v-if="(row.deviceIds && row.deviceIds.length > 0)" type="success" size="small">已选 {{ row.deviceIds.length }} 台</el-tag>
              <el-tag v-else type="info" size="small">未选择</el-tag>
            </template>
          </el-table-column>
        </el-table>
        
        <!-- 移动端卡片布局 -->
        <div class="device-mapping-mobile">
          <div v-for="row in deviceMappings" :key="row.logicalId || row.roleName" class="device-card">
            <div class="device-card-header">
              <div class="device-card-title">{{ row.roleName }}</div>
              <el-tag :type="row.required ? 'danger' : 'success'" size="small" style="margin-right:8px">{{ row.required ? '必需' : '可选' }}</el-tag>
              <el-tag v-if="(row.deviceIds && row.deviceIds.length > 0)" type="success" size="small">已选 {{ row.deviceIds.length }} 台</el-tag>
              <el-tag v-else type="info" size="small">未选择</el-tag>
            </div>
            <div v-if="row.roleDescription" class="device-card-description">
              {{ row.roleDescription }}
            </div>
            <el-checkbox-group v-model="row.deviceIds" @change="updateMapping(row)" class="device-card-select" style="display:flex;flex-direction:column;gap:8px">
              <el-checkbox
                v-for="device in getAvailableDevicesForRole(row)"
                :key="device.id"
                :label="device.id"
              >{{ device.name }}</el-checkbox>
            </el-checkbox-group>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 参数配置 -->
    <el-card shadow="never" class="params-config-card">
      <template #header>
        <div class="card-header">
          <el-icon><Tools /></el-icon>
          <span>参数配置</span>
        </div>
      </template>
      <el-empty 
        v-if="schemaEntries.length === 0" 
        description="暂无参数元信息"
        :image-size="80"
      />
      <el-form v-else :model="parameters" label-width="120px" class="params-form">
        <el-form-item 
          v-for="p in schemaEntries" 
          :key="p.key"
          :label="p.name || p.key"
        >
          <template #label>
            <div class="param-label">
              <span>{{ p.name || p.key }}</span>
              <el-tooltip v-if="p.placeholder" :content="p.placeholder" placement="top">
                <el-icon><QuestionFilled /></el-icon>
              </el-tooltip>
            </div>
          </template>
          
          <el-input
            v-if="p.type === 'string'"
            v-model="parameters[p.key]"
            :placeholder="p.placeholder || ''"
          />
          <el-input-number
            v-else-if="p.type === 'number'"
            v-model="parameters[p.key]"
            :min="p.min"
            :max="p.max"
            style="width: 200px"
          />
          <el-select
            v-else-if="p.type === 'enum'"
            v-model="parameters[p.key]"
            placeholder="请选择"
            style="width: 200px"
          >
            <el-option
              v-for="opt in (p.enum || [])"
              :key="String(opt)"
              :label="String(opt)"
              :value="opt"
            />
          </el-select>
          <el-switch
            v-else-if="p.type === 'boolean'"
            v-model="parameters[p.key]"
          />
          <el-input
            v-else
            v-model="parameters[p.key]"
            :placeholder="p.placeholder || ''"
          />
          
          <div v-if="p.required && (parameters[p.key] === undefined || parameters[p.key] === null || parameters[p.key] === '')" class="param-warning">
            <el-text type="warning" size="small">必填</el-text>
          </div>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 摘要与校验 -->
    <el-card shadow="never" class="summary-card">
      <template #header>
        <div class="card-header">
          <el-icon><DocumentChecked /></el-icon>
          <span>摘要与校验</span>
          <div class="status-badge">
            <el-tag v-if="blocking.length === 0" type="success" size="small">
              校验通过
            </el-tag>
            <el-tag v-else type="warning" size="small">
              有阻塞 {{ blocking.length }} 项
            </el-tag>
          </div>
        </div>
      </template>
      
      <div class="summary-content">
        <div class="summary-section">
          <h4>设备映射</h4>
          <ul class="mapping-list">
            <li v-for="d in requiredDevices" :key="d.logicalId || d.name">
              {{ d.logicalId || d.name }} → {{ formatMapping(d) }}
            </li>
          </ul>
        </div>
        
        <div class="summary-section">
          <h4>参数</h4>
          <el-input
            type="textarea"
            :value="safeStringify(parameters)"
            readonly
            :rows="6"
            class="params-preview"
          />
        </div>
      </div>
      
      <div class="action-section">
        <div class="error-display">
          <el-alert 
            v-if="startError" 
            :title="startError" 
            type="error" 
            :closable="false"
            show-icon
          />
        </div>
        
        <div class="action-buttons">
          <el-button @click="cancel" :icon="ArrowLeft">
            取消返回
          </el-button>
          <el-button 
            :disabled="startBusy" 
            @click="start(true)"
          >
            强行启动
          </el-button>
          <el-button 
            type="primary" 
            :icon="VideoPlay"
            :loading="startBusy"
            :disabled="blocking.length > 0"
            @click="start(false)"
          >
            {{ startBusy ? '启动中...' : '启动' }}
          </el-button>
        </div>
      </div>
      
      <div v-if="blocking.length > 0" class="blocking-section">
        <h4>阻塞项</h4>
        <el-alert
          v-for="b in blocking"
          :key="b"
          :title="b"
          type="warning"
          :closable="false"
          show-icon
          style="margin-bottom: 8px"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { 
  Setting, 
  Connection, 
  Tools, 
  QuestionFilled, 
  DocumentChecked, 
  VideoPlay, 
  ArrowLeft,
  Loading
} from '@element-plus/icons-vue';

interface GameItem {
  id: string;
  name: string;
  description?: string;
  status?: string;
  arguments?: string;
  configPath?: string;
  requiredDevices?: Array<{ logicalId?: string; name?: string; type?: string; interface?: string; required?: boolean; description?: string }>;
  version?: string;
  author?: string;
  createdAt?: number;
  lastPlayed?: number | null;
  // 可选扩展：参数元信息
  parameterSchema?: Record<string, { type: string; required?: boolean; default?: any; enum?: any[]; min?: number; max?: number; name?: string; placeholder?: string }>;
  parameter?: Array<{ key: string; type: string; required?: boolean; default?: any; enum?: any[]; min?: number; max?: number; name?: string; placeholder?: string }>;
}

interface DeviceItem { id: string; name?: string; type?: string; connected: boolean; lastReport?: string | null; data?: Record<string, any> }

const route = useRoute();
const router = useRouter();
const gameId = computed(() => String(route.params.id || ''));

const game = ref<GameItem | null>(null);
const devices = ref<DeviceItem[]>([]);
const deviceTypeMap = ref<Record<string, string>>({});
const typeInterfaceMap = ref<Record<string, string[]>>({});
const loadingAll = ref(false);
const error = ref('');

const deviceMapping = reactive<Record<string, string[]>>({});
const parameters = reactive<Record<string, any>>({});
const deviceError = ref('');
const loadingDevices = ref(false);
 

const requiredDevices = computed(() => {
  const arr = (game.value?.requiredDevices || []).filter(Boolean);
  return Array.isArray(arr) ? arr : [];
});

const schemaEntries = computed(() => {
  const g = game.value;
  const list: Array<{ key: string; type: string; required?: boolean; default?: any; enum?: any[]; min?: number; max?: number; name?: string; placeholder?: string }> = [];
  if (g?.parameterSchema && typeof g.parameterSchema === 'object') {
    for (const [k, v] of Object.entries(g.parameterSchema)) {
      list.push({ key: k, ...(v as any) });
    }
  } else if (Array.isArray(g?.parameter)) {
    for (const item of g!.parameter!) {
      if (item && typeof item.key === 'string') list.push(item as any);
    }
  }
  // 初始化默认值（仅第一次）
  for (const p of list) {
    if (parameters[p.key] === undefined && p.default !== undefined) {
      parameters[p.key] = p.default;
    }
  }
  return list;
});

const deviceMappings = computed(() => {
  return requiredDevices.value.map(rd => ({
    roleName: rd.name || rd.logicalId || '未知角色',
    roleDescription: rd.description || '',
    deviceIds: deviceMapping[rdKey(rd)] || [],
    logicalId: rd.logicalId,
    required: rd.required,
    deviceType: rd.type,
    deviceInterface: (rd as any).interface
  }));
});


function typeSupportsInterface(type?: string, iface?: string) {
  if (!iface) return true;
  if (!type) return false;
  const list = typeInterfaceMap.value[type] || [];
  return list.includes(iface);
}

function getAvailableDevicesForRole(row: any) {
  const deviceType = row.deviceType;
  const deviceInterface = row.deviceInterface;
  let filteredDevices = devices.value;
  if (deviceInterface) {
    filteredDevices = devices.value.filter(device => device.connected && typeSupportsInterface(device.type, deviceInterface));
  } else if (deviceType) {
    filteredDevices = devices.value.filter(device => device.connected && device.type === deviceType);
  }
  filteredDevices.sort((a, b) => Number(b.connected) - Number(a.connected));
  return filteredDevices.map(device => ({ id: device.id, name: device.name || device.id }));
}

function formatLastPlayed(ts?: number | null) {
  if (!ts) return '从未游玩';
  try { return new Date(ts).toLocaleString('zh-CN'); } catch { return String(ts); }
}

function safeStringify(obj: any) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

function typeName(t?: string) {
  if (!t) return '-';
  const map = deviceTypeMap.value;
  return map[t] ?? t;
}
function getDevice(id?: string) { return devices.value.find(d => d.id === id) || null; }

function updateMapping(row: any) {
  const key = rdKey({ logicalId: row.logicalId, name: row.roleName });
  if (key) {
    deviceMapping[key] = Array.isArray(row.deviceIds) ? row.deviceIds.slice() : [];
  }
}

function getDeviceStatusType(deviceId: string): string {
  const device = getDevice(deviceId);
  if (!device) return 'danger';
  return device.connected ? 'success' : 'warning';
}

function getDeviceStatus(deviceId: string): string {
  const device = getDevice(deviceId);
  if (!device) return '设备不存在';
  return device.connected ? '在线' : '离线';
}

function rdKey(d: { logicalId?: string; name?: string }) {
  return String(d.logicalId ?? d.name ?? '');
}

function formatMapping(d: { logicalId?: string; name?: string }): string {
  const arr = deviceMapping[rdKey(d)] ?? [];
  if (arr.length === 0) return '未映射';
  return arr.map(id => getDevice(id)?.name || id).join(', ');
}

function sameTypeDevices(d: { type?: string }) {
  const t = d?.type;
  const list = devices.value.filter(dev => !t || dev.type === t);
  // 在线优先
  list.sort((a, b) => Number(b.connected) - Number(a.connected));
  return list;
}

async function loadAll() {
  loadingAll.value = true;
  error.value = '';
  try {
    const [gRes, metaRes, dRes, tRes, iRes] = await Promise.all([
      fetch(`/api/games/${encodeURIComponent(gameId.value)}`),
      fetch(`/api/games/${encodeURIComponent(gameId.value)}/meta`),
      fetch('/api/devices'),
      fetch('/api/device-types'),
      fetch('/api/device-interfaces'),
    ]);
    const g = await gRes.json();
    if (!gRes.ok) throw new Error(g?.message || '获取游戏详情失败');
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok) {
      console.warn('获取玩法元信息失败', meta?.message || meta);
    }
    game.value = { ...(g || {}), ...(meta || {}) } as any;
    const devs = await dRes.json();
    if (!dRes.ok) throw new Error(devs?.message || '获取设备列表失败');
    devices.value = Array.isArray(devs) ? devs : [];
    const types = await tRes.json();
    if (!tRes.ok) throw new Error(types?.message || '获取设备类型失败');
    deviceTypeMap.value = types || {};
    const iface = await iRes.json();
    if (!iRes.ok) throw new Error(iface?.message || '获取设备接口失败');
    typeInterfaceMap.value = (iface?.typeInterfaceMap) || {};
    // 初始化映射默认值：按类型筛选并默认选择第一项（在线优先）
    for (const rd of requiredDevices.value) {
      const key = rdKey(rd);
      if (!key) continue;
      let candidates: DeviceItem[] = [];
      const ifaceName = (rd as any).interface as string | undefined;
      if (ifaceName) {
        candidates = devices.value.filter(d => d.connected && typeSupportsInterface(d.type, ifaceName));
      } else {
        candidates = devices.value.filter(d => d.connected && (!rd.type || d.type === rd.type));
      }
      const candidate = candidates.find(d => d.connected) || undefined;
      deviceMapping[key] = candidate ? [candidate.id] : [];
    }
  } catch (e: any) {
    error.value = e?.message || '数据加载失败';
  } finally {
    loadingAll.value = false;
  }
}

 

const blocking = ref<string[]>([]);
function recomputeBlocking() {
  const items: string[] = [];
  // 设备映射校验
  for (const rd of requiredDevices.value) {
    const key = rdKey(rd);
    if (!key) continue;
    const ids = deviceMapping[key] || [];
    if (rd.required && ids.length === 0) items.push(`必需设备未映射: ${key}`);
    for (const id of ids) {
      const dev = getDevice(id);
      if (!dev || !dev.connected) items.push(`设备离线或不存在: ${key}`);
      if (rd.type && dev && dev.type !== rd.type) items.push(`类型不匹配(${key}): 期望 ${typeName(rd.type)} 实际 ${typeName(dev?.type)}`);
      const ifaceName = (rd as any).interface as string | undefined;
      if (ifaceName && dev && !typeSupportsInterface(dev.type, ifaceName)) items.push(`接口不匹配(${key}): 需 ${ifaceName}`);
    }
  }
  // 参数校验（若有）
  for (const p of schemaEntries.value) {
    const val = parameters[p.key];
    if (p.required && (val === undefined || val === null || val === '')) {
      items.push(`参数必填: ${p.key}`);
      continue;
    }
    if (val !== undefined && val !== null) {
      switch (p.type) {
        case 'number': {
          const n = Number(val);
          if (Number.isNaN(n)) items.push(`参数类型错误(${p.key}): 需 number`);
          if (p.min !== undefined && n < p.min!) items.push(`参数过小(${p.key}): 最小 ${p.min}`);
          if (p.max !== undefined && n > p.max!) items.push(`参数过大(${p.key}): 最大 ${p.max}`);
          break;
        }
        case 'enum': {
          const ok = Array.isArray(p.enum) ? p.enum!.some(x => x === val) : true;
          if (!ok) items.push(`参数不在集合(${p.key})`);
          break;
        }
        case 'boolean': {
          if (typeof val !== 'boolean') items.push(`参数类型错误(${p.key}): 需 boolean`);
          break;
        }
        case 'string': {
          if (typeof val !== 'string') items.push(`参数类型错误(${p.key}): 需 string`);
          break;
        }
      }
    }
  }
  blocking.value = items;
}

watch([deviceMapping, parameters, requiredDevices, schemaEntries], () => { recomputeBlocking(); }, { deep: true });

async function start(force: boolean) {
  startError.value = '';
  if (!force && blocking.value.length > 0) {
    startError.value = '存在阻塞项，请修正后再启动';
    return;
  }
  startBusy.value = true;
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(gameId.value)}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceMapping: { ...deviceMapping }, parameters: { ...parameters } }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      throw new Error('已有玩法运行中，请先停止再启动');
    }
    if (!res.ok || (data && data.error)) {
      throw new Error(data?.message || '启动失败');
    }
    // 启动成功，跳转到当前运行页面
    router.push({ name: 'game_current' });
  } catch (e: any) {
    startError.value = e?.message || '启动失败';
  } finally {
    startBusy.value = false;
  }
}

function cancel() { router.push({ name: 'games' }); }

const startBusy = ref(false);
const startError = ref('');

onMounted(() => { loadAll().then(() => recomputeBlocking()); });
</script>

<style scoped>
.game-start-config-page {
  padding: 16px;
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  box-sizing: border-box;
}

.config-header-card,
.device-mapping-card,
.params-config-card,
.summary-card {
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.status-badge {
  margin-left: auto;
}

.game-overview {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
}

.game-basic-info {
  flex: 1;
}

.game-title {
  margin: 0 0 8px 0;
  font-size: 20px;
  color: var(--el-text-color-primary);
}

.game-description {
  margin: 0 0 12px 0;
  color: var(--el-text-color-regular);
}

.game-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.loading-status {
  display: flex;
  align-items: center;
  gap: 16px;
}

.loading-info {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--el-text-color-regular);
}

.loading-container {
  padding: 20px 0;
}

.role-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.role-description {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.params-form {
  margin-top: 16px;
}

.param-label {
  display: flex;
  align-items: center;
  gap: 4px;
}

.param-warning {
  margin-top: 4px;
}

.summary-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.summary-section h4 {
  margin: 0 0 8px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.mapping-list {
  margin: 0;
  padding-left: 20px;
  color: var(--el-text-color-regular);
}

.mapping-list li {
  margin-bottom: 4px;
}

.params-preview {
  font-family: 'Courier New', monospace;
}

.action-section {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.action-buttons {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.blocking-section {
  margin-top: 16px;
}

.blocking-section h4 {
  margin: 0 0 12px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-color-warning);
}

@media (max-width: 768px) {
  .game-start-config-page {
    padding: 8px;
    min-height: 100vh;
    box-sizing: border-box;
    overflow-x: hidden;
    position: relative;
  }
  
  .config-header-card,
  .device-mapping-card,
  .params-config-card,
  .summary-card {
    margin-bottom: 12px;
  }
  
  .game-overview {
    flex-direction: column;
    gap: 12px;
  }
  
  .game-title {
    font-size: 18px;
  }
  
  .game-meta {
    flex-direction: column;
    align-items: flex-start;
  }
  
  /* 设备映射表格在移动端改为卡片式布局 */
  .el-table {
    display: none;
  }
  
  .device-mapping-mobile {
    display: block;
  }
  
  .device-card {
    border: 1px solid var(--el-border-color);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
    background: var(--el-bg-color);
  }
  
  .device-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  
  .device-card-title {
    font-weight: 600;
    color: var(--el-text-color-primary);
  }
  
  .device-card-description {
    font-size: 12px;
    color: var(--el-text-color-secondary);
    margin-bottom: 12px;
  }
  
  .device-card-select {
    width: 100%;
    margin-bottom: 8px;
  }
  
  .params-form .el-form-item {
    margin-bottom: 16px;
  }
  
  .params-form .el-form-item__label {
    line-height: 1.4;
    margin-bottom: 8px;
  }
  
  .params-form .el-input-number,
  .params-form .el-select {
    width: 100% !important;
  }
  
  .summary-content {
    gap: 16px;
  }
  
  .mapping-list {
    font-size: 14px;
  }
  
  /* 修复按钮区域的布局问题 */
  .action-section {
    margin-top: 20px;
    margin-bottom: 30px;
    padding: 20px 0;
    position: relative;
    z-index: 10;
    background: var(--el-bg-color);
  }
  
  .action-buttons {
    flex-direction: column;
    gap: 12px;
    width: 100%;
  }
  
  .action-buttons .el-button {
    width: 100%;
    height: 48px;
    font-size: 16px;
    border-radius: 8px;
    touch-action: manipulation;
  }
  
  /* 确保摘要卡片不会遮挡按钮 */
  .summary-card {
    margin-bottom: 20px;
    overflow: visible;
  }
  
  .summary-card .el-card__body {
    padding-bottom: 20px;
  }
  
  .blocking-section {
    margin-bottom: 20px;
  }
  
  .blocking-section .el-alert {
    margin-bottom: 8px;
    font-size: 14px;
  }
  
  /* 确保页面底部有足够的空间 */
  .game-start-config-page::after {
    content: '';
    display: block;
    height: 40px;
  }
  
  /* 优化表单元素的触摸体验 */
  .el-input__inner,
  .el-select .el-input__inner,
  .el-input-number .el-input__inner {
    min-height: 44px;
    font-size: 16px;
  }
  
  .el-select-dropdown__item {
    min-height: 44px;
    line-height: 44px;
    font-size: 16px;
  }
  
  /* 确保卡片内容不会溢出 */
  .el-card {
    overflow: visible;
  }
  
  .el-card__body {
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
}

@media (min-width: 769px) {
  .device-mapping-mobile {
    display: none;
  }
}
</style>
