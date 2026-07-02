<template>
  <div class="plugin-config-page">
    <el-card shadow="never" class="section-card">
      <template #header>
        <div class="card-header">
          <el-icon><Setting /></el-icon>
          <span>插件启动配置</span>
        </div>
      </template>
      <div class="plugin-overview">
        <div>
          <h2>{{ plugin?.title || plugin?.name || '未知插件' }}</h2>
          <p v-if="plugin?.description" class="muted">{{ plugin.description }}</p>
          <div class="meta">
            <el-tag size="small" type="info">{{ hostOf(plugin?.homeUrl) || '未配置目标站点' }}</el-tag>
            <el-tag size="small">v{{ plugin?.version || '-' }}</el-tag>
          </div>
        </div>
        <div v-if="loadingAll" class="loading-info">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>加载中...</span>
        </div>
      </div>
      <el-alert v-if="error" class="inline-alert" :title="error" type="error" :closable="false" show-icon />
    </el-card>

    <el-card shadow="never" class="section-card">
      <template #header>
        <div class="card-header">
          <el-icon><Connection /></el-icon>
          <span>设备映射</span>
        </div>
      </template>
      <el-skeleton v-if="loadingAll" :rows="3" animated />
      <el-table v-else :data="deviceMappings" stripe style="width: 100%">
        <el-table-column prop="roleName" label="插件设备" min-width="180">
          <template #default="{ row }">
            <div class="role-info">
              <strong>{{ row.roleName }}</strong>
              <span v-if="row.capabilities.length" class="muted small">能力：{{ row.capabilities.join(', ') }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="映射设备" min-width="320">
          <template #default="{ row }">
            <el-checkbox-group v-model="row.deviceIds" class="device-checks" @change="updateMapping(row)">
              <el-checkbox
                v-for="device in getAvailableDevicesForRole(row)"
                :key="device.id"
                :value="device.id"
              >
                {{ device.name }}
              </el-checkbox>
            </el-checkbox-group>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="160">
          <template #default="{ row }">
            <el-tag :type="row.required ? 'danger' : 'success'" size="small">
              {{ row.required ? '必需' : '可选' }}
            </el-tag>
            <el-tag v-if="row.deviceIds.length" class="mapped-tag" type="success" size="small">已选 {{ row.deviceIds.length }} 台</el-tag>
            <el-tag v-else class="mapped-tag" type="info" size="small">未选择</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="section-card">
      <template #header>
        <div class="card-header">
          <el-icon><Tools /></el-icon>
          <span>参数配置</span>
          <el-button class="reset-button" size="small" @click="resetToDefault">恢复默认配置</el-button>
        </div>
      </template>
      <el-empty v-if="schemaEntries.length === 0" description="暂无参数" :image-size="80" />
      <el-form
        v-else
        :model="parameters"
        :label-position="isMobile ? 'top' : 'right'"
        :label-width="isMobile ? undefined : '150px'"
        class="params-form"
      >
        <el-form-item v-for="p in schemaEntries" :key="p.key" :label="p.name || p.key">
          <template #label>
            <span>{{ p.name || p.key }}</span>
          </template>
          <el-input v-if="p.type === 'string'" v-model="parameters[p.key]" />
          <el-input-number
            v-else-if="p.type === 'number'"
            v-model="parameters[p.key]"
            :min="p.min"
            :max="p.max"
            :style="{ width: isMobile ? '100%' : '220px' }"
          />
          <el-select
            v-else-if="p.type === 'enum'"
            v-model="parameters[p.key]"
            :style="{ width: isMobile ? '100%' : '220px' }"
          >
            <el-option v-for="opt in p.enum || []" :key="String(opt)" :label="String(opt)" :value="opt" />
          </el-select>
          <el-switch v-else-if="p.type === 'boolean'" v-model="parameters[p.key]" />
          <el-input v-else v-model="parameters[p.key]" />
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" class="section-card">
      <template #header>
        <div class="card-header">
          <el-icon><DocumentChecked /></el-icon>
          <span>摘要与校验</span>
          <el-tag class="status-tag" :type="blocking.length ? 'warning' : 'success'" size="small">
            {{ blocking.length ? `有阻塞 ${blocking.length} 项` : '校验通过' }}
          </el-tag>
        </div>
      </template>

      <div class="summary-grid">
        <div>
          <h3>设备映射</h3>
          <ul>
            <li v-for="device in requiredDevices" :key="device.id">{{ device.id }} → {{ formatMapping(device) }}</li>
          </ul>
        </div>
        <div>
          <h3>参数</h3>
          <el-input type="textarea" :rows="6" :value="safeStringify(parameters)" readonly />
        </div>
      </div>

      <el-alert v-if="startError" class="inline-alert" :title="startError" type="error" :closable="false" show-icon />
      <div v-if="blocking.length" class="blocking-list">
        <el-alert
          v-for="item in blocking"
          :key="item"
          :title="item"
          type="warning"
          :closable="false"
          show-icon
        />
      </div>

      <div class="actions">
        <el-button :icon="ArrowLeft" @click="router.push('/plugins')">取消返回</el-button>
        <el-button :disabled="startBusy" @click="start(true)">强行启动</el-button>
        <el-button type="primary" :icon="VideoPlay" :loading="startBusy" :disabled="blocking.length > 0" @click="start(false)">
          {{ startBusy ? '启动中...' : '启动插件' }}
        </el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import {
  ArrowLeft,
  Connection,
  DocumentChecked,
  Loading,
  Setting,
  Tools,
  VideoPlay,
} from '@element-plus/icons-vue';

interface PluginDevice { id: string; capabilities?: string[]; required?: boolean }
interface PluginParam { key: string; type: string; default?: any; label?: string; min?: number; max?: number; enum?: any[]; required?: boolean; name?: string }
interface PluginItem {
  id: string;
  title?: string;
  name?: string;
  description?: string;
  version?: string;
  homeUrl?: string;
  devices?: PluginDevice[];
  params?: PluginParam[];
}
interface DeviceItem { id: string; name?: string; nickname?: string; type?: string; connected: boolean }

const route = useRoute();
const router = useRouter();
const pluginId = computed(() => String(route.params.id || ''));

const plugin = ref<PluginItem | null>(null);
const devices = ref<DeviceItem[]>([]);
const typeCapabilityMap = ref<Record<string, string[]>>({});
const loadingAll = ref(false);
const error = ref('');
const startBusy = ref(false);
const startError = ref('');
const isMobile = ref(window.innerWidth <= 768);
const deviceMapping = reactive<Record<string, string[]>>({});
const parameters = reactive<Record<string, any>>({});
const blocking = ref<string[]>([]);

const requiredDevices = computed(() => (plugin.value?.devices || []).filter(Boolean));
const schemaEntries = computed(() => {
  const list = (plugin.value?.params || []).filter((p) => p && typeof p.key === 'string');
  for (const p of list) {
    p.name = p.label || p.key;
    if (parameters[p.key] === undefined && p.default !== undefined) parameters[p.key] = p.default;
  }
  return list;
});
const deviceMappings = computed(() => requiredDevices.value.map((rd) => ({
  roleName: rd.id || '未知设备',
  logicalId: rd.id,
  deviceIds: deviceMapping[rdKey(rd)] || [],
  required: rd.required,
  capabilities: rdCapabilities(rd),
})));

onMounted(() => {
  window.addEventListener('resize', onResize);
  loadAll().then(recomputeBlocking);
});

onUnmounted(() => {
  window.removeEventListener('resize', onResize);
});

watch([deviceMapping, parameters, requiredDevices, schemaEntries], recomputeBlocking, { deep: true });

function onResize() {
  isMobile.value = window.innerWidth <= 768;
}

async function loadAll() {
  loadingAll.value = true;
  error.value = '';
  try {
    const [pluginRes, devicesRes, capabilityRes] = await Promise.all([
      fetch(`/api/plugins/${encodeURIComponent(pluginId.value)}`),
      fetch('/api/devices'),
      fetch('/api/device-capabilities'),
    ]);
    const pluginData = await pluginRes.json();
    if (!pluginRes.ok) throw new Error(apiErrorMessage(pluginData, '获取插件详情失败'));
    plugin.value = pluginData;

    const devicesData = await devicesRes.json();
    if (!devicesRes.ok) throw new Error(apiErrorMessage(devicesData, '获取设备列表失败'));
    devices.value = Array.isArray(devicesData) ? devicesData : [];

    const capabilityData = await capabilityRes.json();
    if (!capabilityRes.ok) throw new Error(apiErrorMessage(capabilityData, '获取设备能力失败'));
    typeCapabilityMap.value = capabilityData?.typeCapabilityMap || {};

    const saved = loadSavedConfig();
    clearReactive(parameters);
    Object.assign(parameters, saved?.params || buildDefaultParameters(pluginData));
    clearReactive(deviceMapping);
    for (const rd of requiredDevices.value) {
      const key = rdKey(rd);
      const savedIds = Array.isArray(saved?.deviceMap?.[key]) ? saved!.deviceMap![key] : null;
      if (savedIds) {
        deviceMapping[key] = savedIds.filter((id) => {
          const device = getDevice(id);
          return device && device.connected && typeSupportsCapabilities(device.type, rdCapabilities(rd));
        });
      } else {
        const candidate = devices.value.find((device) => device.connected && typeSupportsCapabilities(device.type, rdCapabilities(rd)));
        deviceMapping[key] = candidate ? [candidate.id] : [];
      }
    }
  } catch (e: any) {
    error.value = e?.message || '数据加载失败';
  } finally {
    loadingAll.value = false;
  }
}

async function start(force: boolean) {
  startError.value = '';
  recomputeBlocking();
  if (!force && blocking.value.length) {
    startError.value = '存在阻塞项，请修正后再启动';
    return;
  }

  const target = plugin.value?.homeUrl || '';
  try {
    await ElMessageBox.confirm(
      `即将进入外部网站${target ? `（${target}）` : ''}并注入本地检测脚本，插件可能根据页面情况对已连接设备发起控制行为（存在异常或意外触发的风险）。<br/><br/>请确认设备已正确佩戴、参数配置无误，并在可随时中断的环境下使用。是否继续？`,
      '插件启动确认',
      {
        confirmButtonText: '继续',
        cancelButtonText: '取消',
        type: 'warning',
        dangerouslyUseHTMLString: true,
      },
    );
  } catch (_) {
    return;
  }

  startBusy.value = true;
  try {
    saveConfig();
    const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId.value)}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceMap: { ...deviceMapping }, params: { ...parameters } }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(apiErrorMessage(data, '插件启动失败'));
    router.push({ name: 'plugin_run', params: { id: pluginId.value } });
  } catch (e: any) {
    startError.value = e?.message || '插件启动失败';
  } finally {
    startBusy.value = false;
  }
}

function recomputeBlocking() {
  const items: string[] = [];
  for (const rd of requiredDevices.value) {
    const key = rdKey(rd);
    const ids = deviceMapping[key] || [];
    if (rd.required && ids.length === 0) items.push(`必需设备未映射: ${key}`);
    for (const id of ids) {
      const device = getDevice(id);
      if (!device || !device.connected) items.push(`设备离线或不存在: ${key}`);
      if (device && !typeSupportsCapabilities(device.type, rdCapabilities(rd))) items.push(`能力不匹配(${key}): 需 ${rdCapabilities(rd).join(', ')}`);
    }
  }
  for (const p of schemaEntries.value) {
    const value = parameters[p.key];
    if (p.required && (value === undefined || value === null || value === '')) items.push(`参数必填: ${p.key}`);
    if (p.type === 'number' && value !== undefined && value !== null) {
      const n = Number(value);
      if (Number.isNaN(n)) items.push(`参数类型错误(${p.key}): 需 number`);
      if (p.min !== undefined && n < p.min) items.push(`参数过小(${p.key}): 最小 ${p.min}`);
      if (p.max !== undefined && n > p.max) items.push(`参数过大(${p.key}): 最大 ${p.max}`);
    }
  }
  blocking.value = Array.from(new Set(items));
}

function updateMapping(row: any) {
  const key = String(row.logicalId || '');
  if (key) deviceMapping[key] = Array.isArray(row.deviceIds) ? row.deviceIds.slice() : [];
}

function resetToDefault() {
  try { localStorage.removeItem(storageKey()); } catch (_) {}
  clearReactive(parameters);
  Object.assign(parameters, buildDefaultParameters(plugin.value));
  for (const rd of requiredDevices.value) {
    const key = rdKey(rd);
    const candidate = devices.value.find((device) => device.connected && typeSupportsCapabilities(device.type, rdCapabilities(rd)));
    deviceMapping[key] = candidate ? [candidate.id] : [];
  }
  recomputeBlocking();
}

function getAvailableDevicesForRole(row: any) {
  const capabilities = Array.isArray(row.capabilities) ? row.capabilities : [];
  return devices.value
    .filter((device) => device.connected && typeSupportsCapabilities(device.type, capabilities))
    .map((device) => {
      const shortId = String(device.id).slice(-4);
      return {
        id: device.id,
        name: device.nickname ? `${device.nickname}-${shortId}` : (device.name || device.id),
      };
    });
}

function typeSupportsCapabilities(type?: string, capabilities?: string[]) {
  const required = Array.isArray(capabilities) ? capabilities : [];
  if (!required.length) return true;
  if (!type) return false;
  const list = typeCapabilityMap.value[type] || [];
  return required.every((capability) => list.includes(capability));
}

function formatMapping(device: { id?: string }) {
  const ids = deviceMapping[rdKey(device)] || [];
  if (!ids.length) return '未映射';
  return ids.map((id) => {
    const found = getDevice(id);
    if (!found) return id;
    const shortId = String(found.id).slice(-4);
    return found.nickname ? `${found.nickname}-${shortId}` : (found.name || found.id);
  }).join(', ');
}

function rdCapabilities(rd: PluginDevice) {
  return Array.isArray(rd.capabilities) ? rd.capabilities.filter(Boolean) : [];
}

function rdKey(rd: { id?: string }) {
  return String(rd.id || '');
}

function getDevice(id: string) {
  return devices.value.find((device) => device.id === id) || null;
}

function storageKey() {
  return `pluginConfig:${pluginId.value}`;
}

function loadSavedConfig(): { deviceMap?: Record<string, string[]>; params?: Record<string, any> } | null {
  try {
    const raw = localStorage.getItem(storageKey());
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function saveConfig() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({
      deviceMap: { ...deviceMapping },
      params: { ...parameters },
    }));
  } catch (_) {}
}

function buildDefaultParameters(meta: any) {
  const defaults: Record<string, any> = {};
  for (const param of meta?.params || []) {
    if (param?.key && Object.prototype.hasOwnProperty.call(param, 'default')) defaults[param.key] = param.default;
  }
  return defaults;
}

function clearReactive(obj: Record<string, any>) {
  for (const key of Object.keys(obj)) delete obj[key];
}

function safeStringify(value: any) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function apiErrorMessage(data: any, fallback: string) {
  return data?.error?.message || data?.message || fallback;
}

function hostOf(url?: string) {
  try { return url ? new URL(url).hostname : ''; } catch { return ''; }
}
</script>

<style scoped>
.plugin-config-page {
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 16px;
  box-sizing: border-box;
}

.section-card {
  margin-bottom: 16px;
}

.card-header,
.plugin-overview,
.meta,
.loading-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-header {
  font-weight: 600;
}

.plugin-overview {
  justify-content: space-between;
  align-items: flex-start;
}

h2 {
  margin: 0 0 8px;
  font-size: 20px;
}

.muted {
  color: var(--el-text-color-secondary);
}

.small {
  font-size: 12px;
}

.inline-alert,
.blocking-list {
  margin-top: 14px;
}

.blocking-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.role-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.device-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.mapped-tag {
  margin-left: 8px;
}

.reset-button,
.status-tag {
  margin-left: auto;
}

.params-form {
  margin-top: 8px;
}

.summary-grid {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(320px, 1.2fr);
  gap: 24px;
}

h3 {
  margin: 0 0 8px;
  font-size: 14px;
}

ul {
  margin: 0;
  padding-left: 18px;
  color: var(--el-text-color-regular);
}

.actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 20px;
}

@media (max-width: 768px) {
  .plugin-config-page {
    padding: 8px;
  }

  .plugin-overview,
  .summary-grid,
  .actions {
    grid-template-columns: 1fr;
    flex-direction: column;
    align-items: stretch;
  }

  .actions .el-button {
    width: 100%;
  }
}
</style>
