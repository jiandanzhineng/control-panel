<template>
  <div class="play-config-page">
    <el-card shadow="never" class="config-header-card">
      <template #header>
        <div class="card-header">
          <el-icon><Setting /></el-icon>
          <span>启动前配置</span>
          <el-tag class="carrier-type-tag" size="small" :type="carrierType === 'game' ? 'primary' : 'success'">
            {{ carrierType === 'game' ? '游戏' : '插件' }}
          </el-tag>
        </div>
      </template>
      <div class="play-overview">
        <div class="play-basic-info">
          <h2 class="play-title">{{ title }}</h2>
          <p v-if="play?.description" class="play-description">{{ play?.description }}</p>
          <div class="play-meta">
            <template v-if="carrierType === 'plugin'">
              <el-tag size="small" type="info">{{ hostOf(play?.homeUrl) || '未配置目标站点' }}</el-tag>
              <el-tag size="small">版本：{{ play?.version || '-' }}</el-tag>
            </template>
            <template v-else>
              <el-tag size="small" type="info">版本：{{ play?.version || '-' }}</el-tag>
              <el-tag size="small" type="success">最后游玩：{{ formatLastPlayed(play?.lastPlayed) }}</el-tag>
            </template>
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
          <el-table-column prop="roleName" label="设备角色" width="200">
            <template #default="{ row }">
              <div class="role-info">
                <strong>{{ row.roleName }}</strong>
                <div class="role-description">
                  <span v-if="row.capabilities && row.capabilities.length">能力：{{ row.capabilities.join(', ') }}</span>
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
                  :value="device.id"
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
            <div v-if="row.capabilities && row.capabilities.length" class="device-card-description">
              能力：{{ row.capabilities.join(', ') }}
            </div>
            <el-checkbox-group v-model="row.deviceIds" @change="updateMapping(row)" class="device-card-select" style="display:flex;flex-direction:column;gap:8px">
              <el-checkbox
                v-for="device in getAvailableDevicesForRole(row)"
                :key="device.id"
                :value="device.id"
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
          <div style="margin-left:auto;display:flex;gap:8px">
            <el-button size="small" @click="resetToDefault">恢复默认配置</el-button>
          </div>
        </div>
      </template>
      <el-empty
        v-if="schemaEntries.length === 0"
        description="暂无参数元信息"
        :image-size="80"
      />
      <el-form
        v-else
        :model="parameters"
        :label-position="isMobile ? 'top' : 'right'"
        :label-width="isMobile ? undefined : '150px'"
        class="params-form"
      >
        <el-form-item
          v-for="p in basicSchemaEntries"
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
            :style="{ width: isMobile ? '100%' : '200px' }"
          />
          <el-select
            v-else-if="p.type === 'enum'"
            v-model="parameters[p.key]"
            placeholder="请选择"
            :style="{ width: isMobile ? '100%' : '200px' }"
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

        <el-collapse
          v-if="advancedSchemaEntries.length > 0"
          v-model="advancedCollapseActive"
          class="advanced-collapse"
        >
          <el-collapse-item name="advanced">
            <template #title>
              <span>高级配置（{{ advancedSchemaEntries.length }}项）</span>
            </template>

            <el-form-item
              v-for="p in advancedSchemaEntries"
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
                :style="{ width: isMobile ? '100%' : '200px' }"
              />
              <el-select
                v-else-if="p.type === 'enum'"
                v-model="parameters[p.key]"
                placeholder="请选择"
                :style="{ width: isMobile ? '100%' : '200px' }"
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
          </el-collapse-item>
        </el-collapse>
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
            <li v-for="d in requiredDevices" :key="d.id">
              {{ d.id }} → {{ formatMapping(d) }}
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
            {{ startBusy ? '启动中...' : (carrierType === 'plugin' ? '启动插件' : '启动') }}
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

    <el-dialog
      v-model="carrierConfirm.visible"
      :title="carrierConfirm.title"
      width="520px"
      append-to-body
      @closed="onCarrierConfirmClosed"
    >
      <p class="carrier-confirm-message">{{ carrierConfirm.message }}</p>
      <template #footer>
        <el-button @click="resolveCarrierConfirm(false)">取消</el-button>
        <el-button type="primary" @click="resolveCarrierConfirm(true)">继续</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { track } from '../analytics';
import { setActivePlay } from '../composables/useActivePlay';

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

interface PlayDevice { id: string; capabilities?: string[]; required?: boolean }
interface PlayParam { key: string; type: string; default?: any; label?: string; min?: number; max?: number; enum?: any[]; required?: boolean; name?: string; placeholder?: string }

interface PlayDetail {
  id: string;
  name?: string;       // 游戏
  title?: string;      // 插件
  description?: string;
  version?: string;
  devices?: PlayDevice[];
  params?: PlayParam[];
  // 游戏专属
  gamePath?: string;
  external?: boolean;
  externalUrl?: string;
  cacheable?: boolean;
  cached?: boolean;
  localGamePath?: string;
  packageSha256?: string;
  lastPlayed?: number | null;
  arguments?: string;
  // 插件专属
  homeUrl?: string;
  source?: string;
  origin?: string;
  lastDeviceMap?: Record<string, string[]>;
  lastParams?: Record<string, any>;
}

interface DeviceItem { id: string; name?: string; nickname?: string; type?: string; connected: boolean; lastReport?: string | null; data?: Record<string, any> }

const route = useRoute();
const router = useRouter();

// carrierType 来自路由参数：game | plugin
const carrierType = computed<'game' | 'plugin'>(() => {
  const t = String(route.params.type || 'game');
  return t === 'plugin' ? 'plugin' : 'game';
});
const playId = computed(() => String(route.params.id || ''));

const play = ref<PlayDetail | null>(null);
const devices = ref<DeviceItem[]>([]);
const typeCapabilityMap = ref<Record<string, string[]>>({});
const loadingAll = ref(false);
const loadingDevices = ref(false);
const error = ref('');
const deviceError = ref('');

const deviceMapping = reactive<Record<string, string[]>>({});
const parameters = reactive<Record<string, any>>({});

const isMobile = ref(window.innerWidth <= 768);
function onResize() { isMobile.value = window.innerWidth <= 768; }

const title = computed(() => play.value?.title || play.value?.name || play.value?.id || '未知玩法');

const requiredDevices = computed(() => {
  const arr = (play.value?.devices || []).filter(Boolean);
  return Array.isArray(arr) ? arr : [];
});

// 参数 schema：提取 label 括号说明为 tooltip，默认值回填。基础/高级按 required 切分。
const schemaEntries = computed(() => {
  const list = (play.value?.params || []).filter(p => p && typeof p.key === 'string');
  for (const p of list) {
    if (parameters[p.key] === undefined && p.default !== undefined) {
      parameters[p.key] = p.default;
    }
  }
  for (const p of list as any[]) {
    const nm = String(p.label ?? p.key ?? '');
    p.name = nm;
    const m = nm.match(/^(.*?)(?:（(.*?)）|\((.*?)\))$/);
    if (m) {
      p.name = (m[1] ?? '').trim() || nm;
      const extra = (m[2] ?? m[3] ?? '').trim();
      if (extra && !p.placeholder) p.placeholder = extra;
    }
  }
  return list as any[];
});

const basicSchemaEntries = computed(() => schemaEntries.value.filter(p => p.required !== false));
const advancedSchemaEntries = computed(() => schemaEntries.value.filter(p => p.required === false));
const advancedCollapseActive = ref<string[]>([]);

const deviceMappings = computed(() => {
  return requiredDevices.value.map(rd => ({
    roleName: rd.id || '未知角色',
    deviceIds: deviceMapping[rdKey(rd)] || [],
    logicalId: rd.id,
    required: rd.required,
    capabilities: rdCapabilities(rd),
  }));
});

function rdCapabilities(rd: any): string[] {
  if (Array.isArray(rd?.capabilities)) return rd.capabilities.filter((x: any) => typeof x === 'string' && x.length > 0);
  return [];
}

function typeSupportsCapabilities(type?: string, capabilities?: string[]) {
  const required = Array.isArray(capabilities) ? capabilities : [];
  if (!type) return false;
  const list = typeCapabilityMap.value[type] || [];
  return required.every(cap => list.includes(cap));
}

function getAvailableDevicesForRole(row: any) {
  const capabilities = Array.isArray(row.capabilities) ? row.capabilities : [];
  const filteredDevices = capabilities.length
    ? devices.value.filter(device => device.connected && typeSupportsCapabilities(device.type, capabilities))
    : devices.value.filter(device => device.connected);
  filteredDevices.sort((a, b) => Number(b.connected) - Number(a.connected));
  return filteredDevices.map(device => {
    const devAny = device as any;
    const shortId = String(device.id).slice(-4);
    const displayName = devAny.nickname ? `${devAny.nickname}-${shortId}` : (device.name || device.id);
    return { id: device.id, name: displayName };
  });
}

function formatLastPlayed(ts?: number | null) {
  if (!ts) return '从未游玩';
  try { return new Date(ts).toLocaleString('zh-CN'); } catch { return String(ts); }
}

function safeStringify(obj: any) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

function apiErrorMessage(data: any, fallback: string) {
  return data?.error?.message || data?.message || fallback;
}

function getDevice(id?: string) { return devices.value.find(d => d.id === id) || null; }

function buildDefaultParameters(meta: any) {
  const defaults: Record<string, any> = {};
  if (Array.isArray(meta?.params)) {
    for (const item of meta.params) {
      if (item?.key && Object.prototype.hasOwnProperty.call(item, 'default')) {
        defaults[item.key] = item.default;
      }
    }
  }
  return defaults;
}

function clearReactive(obj: Record<string, any>) {
  for (const k of Object.keys(obj)) delete obj[k];
}

function updateMapping(row: any) {
  const key = String(row.logicalId ?? '');
  if (key) {
    deviceMapping[key] = Array.isArray(row.deviceIds) ? row.deviceIds.slice() : [];
  }
}

function rdKey(d: { id?: string }) {
  return String(d.id ?? '');
}

function formatMapping(d: { id?: string }): string {
  const arr = deviceMapping[rdKey(d)] ?? [];
  if (arr.length === 0) return '未映射';
  return arr.map(id => {
    const dev = getDevice(id) as any;
    if (dev) {
      const shortId = String(dev.id).slice(-4);
      return dev.nickname ? `${dev.nickname}-${shortId}` : (dev.name || dev.id);
    }
    return id;
  }).join(', ');
}

function hostOf(url?: string) {
  try { return url ? new URL(url).hostname : ''; } catch { return ''; }
}

function storageKey() {
  if (carrierType.value === 'plugin') return `pluginConfig:${playId.value}`;
  // 远程仓库游戏：用稳定 id 命名，不随站点迁移丢失已存的设备映射/参数
  if (route.query.source === 'remote') return `gameConfig:remote:${playId.value}`;
  if (route.query.source === 'saved') return `gameConfig:saved:${playId.value}`;
  const ext = String(route.query.externalUrl || '');
  return ext ? `gameConfig:ext:${ext}` : `gameConfig:${playId.value}`;
}

function loadSavedConfig(): { deviceMap?: Record<string, string[]>; params?: Record<string, any> } | null {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (_) { return null; }
}

function saveConfig() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({
      deviceMap: { ...deviceMapping },
      params: { ...parameters },
    }));
  } catch (_) {}
}

const launchGamePath = ref('');
const launchCacheInfo = ref<any | null>(null);

function gameOrigin() {
  if (route.query.source === 'remote') return 'remote';
  return String(route.query.origin || '') || (String(route.query.externalUrl || '') ? 'external' : 'saved');
}

async function savePlayedGame(gamePathOverride = '') {
  if (carrierType.value !== 'game' || !play.value) return;
  const externalUrl = String(route.query.externalUrl || '') || play.value.externalUrl || '';
  const gamePath = gamePathOverride || launchGamePath.value || play.value.gamePath || String(route.query.gamePath || '');
  if (!gamePath && !externalUrl) return;
  const cached = gamePath.startsWith('/games/cache/') || !!launchCacheInfo.value?.localGamePath;

  await fetch('/api/games/played', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: play.value.id || playId.value || externalUrl,
      title: title.value,
      description: play.value.description || '',
      version: play.value.version || '1.0.0',
      devices: play.value.devices || [],
      params: play.value.params || [],
      gamePath,
      externalUrl,
      origin: gameOrigin(),
      cached,
      localGamePath: cached ? (launchCacheInfo.value?.localGamePath || gamePath) : '',
      packageSha256: launchCacheInfo.value?.packageSha256 || play.value.packageSha256 || '',
      deviceMap: { ...deviceMapping },
      parameters: { ...parameters },
    }),
  }).catch(() => null);
}

function metaUrlForPlay(source: string, externalUrl: string) {
  if (carrierType.value === 'plugin') return `/api/plugins/${encodeURIComponent(playId.value)}`;
  if (source === 'remote') return `/api/game-registry/${encodeURIComponent(playId.value)}`;
  if (source === 'saved') return `/api/games/${encodeURIComponent(playId.value)}`;
  if (externalUrl) return `/api/games/external/meta?url=${encodeURIComponent(externalUrl)}`;
  return `/api/games/${encodeURIComponent(playId.value)}`;
}

async function tryLoadRegistryDetailForExternalGame() {
  if (carrierType.value !== 'game' || !play.value) return null;
  if (route.query.source === 'remote' || playId.value !== 'external') return play.value;
  const id = play.value.id;
  if (!id || id === 'external') return play.value;
  try {
    const res = await fetch(`/api/game-registry/${encodeURIComponent(id)}`);
    if (!res.ok) return play.value;
    const detail = await res.json();
    if (!detail || detail.id !== id) return play.value;
    return { ...play.value, ...detail };
  } catch {
    return play.value;
  }
}

async function installRemoteGameIfNeeded(): Promise<string> {
  launchCacheInfo.value = null;
  launchGamePath.value = '';
  if (carrierType.value !== 'game' || !play.value) {
    return '';
  }

  const enriched = await tryLoadRegistryDetailForExternalGame();
  if (enriched && enriched !== play.value) play.value = enriched as any;

  const fallbackPath = play.value.gamePath || String(route.query.gamePath || '');
  if (play.value.localGamePath && play.value.cached) {
    launchGamePath.value = play.value.localGamePath;
    launchCacheInfo.value = {
      localGamePath: play.value.localGamePath,
      packageSha256: play.value.packageSha256 || '',
    };
    return launchGamePath.value;
  }
  if (!play.value.cacheable || !play.value.packageSha256) {
    launchGamePath.value = fallbackPath;
    return fallbackPath;
  }

  const res = await fetch(`/api/game-cache/install/${encodeURIComponent(play.value.id || playId.value)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (fallbackPath) {
      launchGamePath.value = fallbackPath;
      return fallbackPath;
    }
    throw new Error(apiErrorMessage(data, '游戏缓存安装失败'));
  }
  launchCacheInfo.value = data;
  launchGamePath.value = data.localGamePath || fallbackPath;
  return launchGamePath.value;
}

async function loadAll() {
  loadingAll.value = true;
  loadingDevices.value = true;
  error.value = '';
  deviceError.value = '';
  try {
    // 按 carrierType 选数据源
    const source = String(route.query.source || '');
    const externalUrl = String(route.query.externalUrl || '');
    const metaUrl = metaUrlForPlay(source, externalUrl);

    const [mRes, dRes, iRes] = await Promise.all([
      fetch(metaUrl),
      fetch('/api/devices'),
      fetch('/api/device-capabilities'),
    ]);
    const m = await mRes.json();
    if (!mRes.ok) throw new Error(apiErrorMessage(m, carrierType.value === 'plugin' ? '获取插件详情失败' : '获取玩法详情失败'));
    play.value = m as any;

    const devs = await dRes.json();
    if (!dRes.ok) throw new Error(devs?.message || '获取设备列表失败');
    devices.value = Array.isArray(devs) ? devs : [];
    const capabilityData = await iRes.json();
    if (!iRes.ok) throw new Error(capabilityData?.message || '获取设备能力失败');
    typeCapabilityMap.value = (capabilityData?.typeCapabilityMap) || {};

    // 参数：优先 localStorage 回填，否则用 manifest 默认值
    const saved = loadSavedConfig();
    const defaults = buildDefaultParameters(m);
    clearReactive(parameters);
    const savedParams = (saved?.params && typeof saved.params === 'object')
      ? saved.params
      : ((m as any).lastParams && typeof (m as any).lastParams === 'object' ? (m as any).lastParams : null);
    Object.assign(parameters, savedParams || defaults);

    // 设备映射：优先 localStorage 回填（校验在线），否则按能力默认选第一台在线设备
    for (const rd of requiredDevices.value) {
      const key = rdKey(rd);
      if (!key) continue;
      const capabilities = rdCapabilities(rd);
      const detailMap = (m as any).lastDeviceMap && typeof (m as any).lastDeviceMap === 'object' ? (m as any).lastDeviceMap : {};
      const savedIds = Array.isArray(saved?.deviceMap?.[key])
        ? saved!.deviceMap![key]
        : (Array.isArray(detailMap[key]) ? detailMap[key] : null);
      if (savedIds) {
        const valid = savedIds.filter(id => {
          const dev = getDevice(id);
          return dev && dev.connected && typeSupportsCapabilities(dev.type, capabilities);
        });
        deviceMapping[key] = valid;
      } else {
        const candidate = devices.value.find(d => d.connected && typeSupportsCapabilities(d.type, capabilities));
        deviceMapping[key] = candidate ? [candidate.id] : [];
      }
    }
  } catch (e: any) {
    error.value = e?.message || '数据加载失败';
  } finally {
    loadingAll.value = false;
    loadingDevices.value = false;
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
      const capabilities = rdCapabilities(rd);
      if (capabilities.length && dev && !typeSupportsCapabilities(dev.type, capabilities)) items.push(`能力不匹配(${key}): 需 ${capabilities.join(', ')}`);
    }
  }
  // 参数校验
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
  blocking.value = Array.from(new Set(items));
}

watch([deviceMapping, parameters, requiredDevices, schemaEntries], () => { recomputeBlocking(); }, { deep: true });

async function resetToDefault() {
  try { localStorage.removeItem(storageKey()); } catch (_) {}
  clearReactive(parameters);
  Object.assign(parameters, buildDefaultParameters(play.value));
  clearReactive(deviceMapping);
  for (const rd of requiredDevices.value) {
    const key = rdKey(rd);
    if (!key) continue;
    const capabilities = rdCapabilities(rd);
    const candidate = devices.value.find(d => d.connected && typeSupportsCapabilities(d.type, capabilities));
    deviceMapping[key] = candidate ? [candidate.id] : [];
  }
  recomputeBlocking();
}

/** 进入外部载体（插件 / 外部游戏）的统一确认框，文案按 type 微调 */
function carrierConfirmConfig(externalUrl: string, homeUrl: string): { title: string; message: string } {
  if (carrierType.value === 'plugin') {
    return {
      title: '插件启动确认',
      message: `即将进入外部网站${homeUrl ? `（${homeUrl}）` : ''}并注入本地检测脚本，插件可能根据页面情况对已连接设备发起控制行为（存在异常或意外触发的风险）。\n\n请确认设备已正确佩戴、参数配置无误，并在可随时中断的环境下使用。是否继续？`,
    };
  }
  return {
    title: '外部网页提示',
    message: `您即将进入外部网页（${externalUrl}），该页面不受硅基之下控制，请注意安全。`,
  };
}

const carrierConfirm = reactive<{
  visible: boolean;
  title: string;
  message: string;
  resolve: null | ((confirmed: boolean) => void);
}>({
  visible: false,
  title: '',
  message: '',
  resolve: null,
});

function openCarrierConfirm(cfg: { title: string; message: string }): Promise<boolean> {
  carrierConfirm.title = cfg.title;
  carrierConfirm.message = cfg.message;
  carrierConfirm.visible = true;
  return new Promise((resolve) => {
    carrierConfirm.resolve = resolve;
  });
}

function resolveCarrierConfirm(confirmed: boolean) {
  const resolve = carrierConfirm.resolve;
  carrierConfirm.resolve = null;
  carrierConfirm.visible = false;
  resolve?.(confirmed);
}

function onCarrierConfirmClosed() {
  if (carrierConfirm.resolve) resolveCarrierConfirm(false);
}

const startBusy = ref(false);
const startError = ref('');

async function start(force: boolean) {
  startError.value = '';
  if (!force && blocking.value.length > 0) {
    startError.value = '存在阻塞项，请修正后再启动';
    return;
  }

  const externalUrl = String(route.query.externalUrl || '') || (play.value as any)?.externalUrl || '';
  // 外部游戏 / 插件：进入外部载体确认（合流）
  const needsConfirm = carrierType.value === 'plugin' || (carrierType.value === 'game' && externalUrl);
  if (needsConfirm) {
    const cfg = carrierConfirmConfig(externalUrl, (play.value as any)?.homeUrl || '');
    const confirmed = await openCarrierConfirm(cfg);
    if (!confirmed) return;
  }

  startBusy.value = true;
  try {
    saveConfig();
    const installedGamePath = await installRemoteGameIfNeeded();
    await savePlayedGame(installedGamePath);
    const t = title.value;

    if (carrierType.value === 'game') {
      track('game_start', {
        game_id: playId.value || externalUrl || 'unknown',
        device_count: Object.keys(deviceMapping).length,
      });
      const resumeQuery: Record<string, string> = {
        id: playId.value,
        deviceMap: JSON.stringify({ ...deviceMapping }),
        params: JSON.stringify({ ...parameters }),
      };
      const gamePath = installedGamePath || (play.value as any)?.gamePath || String(route.query.gamePath || '');
      if (externalUrl) resumeQuery.externalUrl = externalUrl;
      if (gamePath) resumeQuery.gamePath = gamePath;
      setActivePlay({ carrierType: 'game', id: playId.value, title: t, resume: { name: 'game_current', query: resumeQuery } });
      router.push({ name: 'game_current', query: resumeQuery });
    } else {
      const res = await fetch(`/api/plugins/${encodeURIComponent(playId.value)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceMap: { ...deviceMapping }, params: { ...parameters } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(apiErrorMessage(data, '插件启动失败'));
      track('plugin_start', {
        plugin_id: playId.value,
        device_count: Object.keys(deviceMapping).length,
      });
      setActivePlay({ carrierType: 'plugin', id: playId.value, title: t, resume: { name: 'plugin_run', params: { id: playId.value } } });
      router.push({ name: 'plugin_run', params: { id: playId.value } });
    }
  } catch (e: any) {
    startError.value = e?.message || '启动失败';
  } finally {
    startBusy.value = false;
  }
}

function cancel() { router.push({ name: 'play_library' }); }

onMounted(() => {
  onResize();
  window.addEventListener('resize', onResize);
  loadAll().then(() => recomputeBlocking());
});
onUnmounted(() => { window.removeEventListener('resize', onResize); });
</script>

<style scoped>
.play-config-page {
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

.carrier-type-tag,
.advanced-collapse {
  margin-left: 8px;
}

.advanced-collapse {
  margin-top: 8px;
}

.status-badge {
  margin-left: auto;
}

.play-overview {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
}

.play-basic-info {
  flex: 1;
}

.play-title {
  margin: 0 0 8px 0;
  font-size: 20px;
  color: var(--el-text-color-primary);
}

.play-description {
  margin: 0 0 12px 0;
  color: var(--el-text-color-regular);
}

.play-meta {
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
  white-space: normal;
  word-break: break-word;
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

.carrier-confirm-message {
  margin: 0;
  line-height: 1.7;
  color: var(--el-text-color-regular);
  white-space: pre-line;
}

@media (max-width: 768px) {
  .play-config-page {
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

  .play-overview {
    flex-direction: column;
    gap: 12px;
  }

  .play-title {
    font-size: 18px;
  }

  .play-meta {
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

  .play-config-page::after {
    content: '';
    display: block;
    height: 40px;
  }

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
