<template>
  <div class="page">
    <h1>启动前配置</h1>

    <section class="card">
      <div class="row space-between">
        <div>
          <h2 class="title">{{ game?.name || '未知玩法' }}</h2>
          <p v-if="game?.description" class="desc">{{ game?.description }}</p>
          <div class="meta">
            <span>版本：<strong>{{ game?.version || '-' }}</strong></span>
            <span>最后游玩：{{ formatLastPlayed(game?.lastPlayed) }}</span>
          </div>
        </div>
        <div class="status">
          <span v-if="loadingAll" class="muted">加载中...</span>
          <span v-if="error" class="error">{{ error }}</span>
        </div>
      </div>
    </section>

    <!-- 设备映射 -->
    <section class="card">
      <div class="row space-between">
        <h3>设备映射</h3>
        <span class="muted">必需设备需映射到在线设备</span>
      </div>
      <div v-if="requiredDevices.length === 0" class="empty">
        <p class="muted">该玩法未声明设备需求或数据暂不可用</p>
      </div>
      <div v-else class="map-list">
        <div v-for="d in requiredDevices" :key="d.logicalId || d.name" class="map-row">
          <div class="map-info">
            <div class="map-title">
              <strong>{{ d.name || d.logicalId || '设备' }}</strong>
              <span class="pill" :class="d.required ? 'pill-required' : 'pill-optional'">
                {{ d.required ? '必需' : '可选' }}
              </span>
            </div>
            <div class="map-meta">
              <span>类型：<strong>{{ typeName(d.type) }}</strong></span>
              <span v-if="d.description" class="muted">{{ d.description }}</span>
            </div>
          </div>
          <div class="map-select">
            <div class="radio-list">
              <label v-for="dev in sameTypeDevices(d)" :key="dev.id" class="radio-item">
                <input
                  type="radio"
                  :name="`map-${rdKey(d)}`"
                  :value="dev.id"
                  v-model="deviceMapping[rdKey(d)]"
                />
                <span class="radio-text">
                  {{ dev.name || dev.id }} — {{ typeName(dev.type) }} — {{ dev.connected ? '在线' : '离线' }}
                </span>
              </label>
              <label class="radio-item">
                <input
                  type="radio"
                  :name="`map-${rdKey(d)}`"
                  value=""
                  v-model="deviceMapping[rdKey(d)]"
                />
                <span class="radio-text">未映射</span>
              </label>
            </div>
            <div class="hints">
              <span v-if="deviceMapping[rdKey(d)] && !getDevice(deviceMapping[rdKey(d)])?.connected" class="warn">设备离线</span>
              <span v-if="d.type && deviceMapping[rdKey(d)] && getDevice(deviceMapping[rdKey(d)])?.type !== d.type" class="warn">类型不匹配：期望 {{ typeName(d.type) }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 参数配置 -->
    <section class="card">
      <div class="row space-between">
        <h3>参数配置</h3>
        <span class="muted">支持 string/number/boolean/enum/range</span>
      </div>

      <div v-if="schemaEntries.length === 0" class="empty">
        <p class="muted">暂无参数元信息。</p>
      </div>

      <div v-else class="param-grid">
        <div v-for="p in schemaEntries" :key="p.key" class="param-row">
          <label class="label">{{ p.name || p.key }}</label>
          <div class="param-input">
            <input v-if="p.type === 'string'" class="input" type="text" :placeholder="p.placeholder || ''" v-model="parameters[p.key]" />
            <input v-else-if="p.type === 'number'" class="input" type="number" :min="p.min" :max="p.max" v-model.number="parameters[p.key]" />
            <select v-else-if="p.type === 'enum'" class="input" v-model="parameters[p.key]">
              <option v-for="opt in (p.enum || [])" :key="String(opt)" :value="opt">{{ String(opt) }}</option>
            </select>
            <input v-else-if="p.type === 'boolean'" type="checkbox" v-model="parameters[p.key]" />
            <input v-else class="input" type="text" v-model="parameters[p.key]" />
            <span v-if="p.required && (parameters[p.key] === undefined || parameters[p.key] === null || parameters[p.key] === '')" class="warn">必填</span>
          </div>
        </div>
      </div>

      
    </section>

    <!-- 摘要与校验 -->
    <section class="card">
      <div class="row space-between">
        <h3>摘要与校验</h3>
        <div class="status">
          <span v-if="blocking.length === 0" class="ok">校验通过</span>
          <span v-else class="warn">有阻塞 {{ blocking.length }} 项</span>
        </div>
      </div>
      <div class="summary">
        <h4>设备映射</h4>
        <ul>
          <li v-for="d in requiredDevices" :key="d.logicalId || d.name">
            {{ d.logicalId || d.name }} → {{ deviceMapping[rdKey(d)] ? (getDevice(deviceMapping[rdKey(d)])?.name || deviceMapping[rdKey(d)]) : '未映射' }}
          </li>
        </ul>
        <h4>参数</h4>
        <pre class="pre">{{ safeStringify(parameters) }}</pre>
      </div>
      <div class="row space-between">
        <div class="status">
          <span v-if="startError" class="error">{{ startError }}</span>
        </div>
        <div class="row">
          <button class="primary" :disabled="blocking.length > 0 || startBusy" @click="start(false)">{{ startBusy ? '启动中...' : '启动' }}</button>
          <button :disabled="startBusy" @click="start(true)">强行启动</button>
          <button @click="cancel">取消返回</button>
        </div>
      </div>
      <div v-if="blocking.length > 0" class="block-list">
        <h4>阻塞项</h4>
        <ul>
          <li v-for="b in blocking" :key="b">{{ b }}</li>
        </ul>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

interface GameItem {
  id: string;
  name: string;
  description?: string;
  status?: string;
  arguments?: string;
  configPath?: string;
  requiredDevices?: Array<{ logicalId?: string; name?: string; type?: string; required?: boolean; description?: string }>;
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
const loadingAll = ref(false);
const error = ref('');

const deviceMapping = reactive<Record<string, string>>({});
const parameters = reactive<Record<string, any>>({});
 

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

function rdKey(d: { logicalId?: string; name?: string }) {
  return String(d.logicalId ?? d.name ?? '');
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
    const [gRes, metaRes, dRes, tRes] = await Promise.all([
      fetch(`/api/games/${encodeURIComponent(gameId.value)}`),
      fetch(`/api/games/${encodeURIComponent(gameId.value)}/meta`),
      fetch('/api/devices'),
      fetch('/api/device-types'),
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
    // 初始化映射默认值：按类型筛选并默认选择第一项（在线优先）
    for (const rd of requiredDevices.value) {
      const key = rdKey(rd);
      if (!key) continue;
      const candidates = sameTypeDevices(rd);
      const candidate = candidates.find(d => d.connected) || candidates[0];
      deviceMapping[key] = candidate ? candidate.id : '';
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
    const devId = deviceMapping[key];
    if (rd.required && (!devId || devId.length === 0)) items.push(`必需设备未映射: ${key}`);
    if (devId) {
      const dev = getDevice(devId);
      if (!dev || !dev.connected) items.push(`设备离线或不存在: ${key}`);
      if (rd.type && dev && dev.type !== rd.type) items.push(`类型不匹配(${key}): 期望 ${typeName(rd.type)} 实际 ${typeName(dev?.type)}`);
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

function cancel() { router.push({ name: 'gamelist' }); }

const startBusy = ref(false);
const startError = ref('');

onMounted(() => { loadAll().then(() => recomputeBlocking()); });
</script>

<style scoped>
.page { max-width: 960px; margin: 40px auto; padding: 0 24px; text-align: left; }
.card { margin-top: 24px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fafafa; }
.row { display: flex; gap: 12px; align-items: center; }
.space-between { justify-content: space-between; }
.status { display: flex; gap: 12px; align-items: center; }
.error { color: #e11d48; }
.ok { color: #16a34a; }
.warn { color: #f59e0b; }
.muted { color: #6b7280; }
.title { margin: 0; font-size: 20px; }
.desc { margin: 6px 0 8px; color: #374151; }
.meta { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #6b7280; }
.input { padding: 6px 10px; border: 1px solid #e5e7eb; border-radius: 6px; min-width: 240px; }
button { padding: 6px 12px; border: 1px solid #0ea5e9; background: #0ea5e9; color: white; border-radius: 6px; cursor: pointer; }
button.primary { border-color: #0ea5e9; background: #0ea5e9; }
button:disabled { opacity: 0.6; cursor: not-allowed; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
.pill-required { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; }
.pill-optional { background: #e5e7eb; color: #374151; border: 1px solid #d1d5db; }
.map-list { display: grid; grid-template-columns: 1fr; gap: 12px; }
.map-row { display: grid; grid-template-columns: 1.2fr 1fr; gap: 12px; align-items: start; }
.map-title { display: flex; align-items: center; gap: 8px; }
.map-meta { display: flex; gap: 12px; font-size: 12px; color: #6b7280; margin-top: 4px; }
.hints { display: flex; gap: 8px; font-size: 12px; }
.radio-list { display: grid; gap: 8px; }
.radio-item { display: flex; align-items: center; gap: 8px; }
.radio-text { font-size: 14px; }
.param-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
.param-row { display: grid; grid-template-columns: 160px 1fr; gap: 12px; align-items: center; }
.label { font-size: 13px; color: #374151; }
.json-box { margin-top: 12px; }
.summary { margin-top: 8px; }
.pre { background: #fff; border: 1px dashed #e5e7eb; border-radius: 6px; padding: 8px; max-height: 200px; overflow: auto; }
.block-list { margin-top: 12px; }
.empty { text-align: left; padding: 8px 0; }
</style>