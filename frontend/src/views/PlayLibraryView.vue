<template>
  <div class="page">
    <div class="header-row">
      <div>
        <h1>本地游戏</h1>
        <p class="muted">本机已保存和内置的游戏与插件，选择一个配置并接入设备运行。</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Reading" @click="$router.push('/plays/dev-guide')">开发指南</el-button>
        <el-button :icon="Refresh" :loading="busy.refresh" @click="refresh">刷新</el-button>
      </div>
    </div>

    <!-- 当前运行提示条（替代原「当前游戏」侧边栏项） -->
    <el-alert
      v-if="activePlay"
      class="running-banner"
      type="success"
      :closable="false"
      show-icon
    >
      <template #title>
        <div class="banner-inner">
          <span>当前运行：{{ activePlay.title }}</span>
          <span class="banner-actions">
            <el-button size="small" type="primary" @click="resumeRun">返回运行页</el-button>
            <el-button size="small" type="danger" :loading="busy.stop" @click="stopCurrent">停止</el-button>
          </span>
        </div>
      </template>
    </el-alert>

    <section class="toolbar-card">
      <div class="row">
        <el-input
          v-model="search"
          class="search"
          placeholder="搜索本地游戏或插件..."
          clearable
          :prefix-icon="Search"
        />
        <el-button :icon="Upload" :loading="busy.upload" @click="triggerUpload">加载外部游戏</el-button>
        <el-button :icon="Close" :loading="busy.stop" type="danger" plain @click="stopCurrent">停止当前运行</el-button>
        <input ref="fileInput" type="file" accept=".js" style="display:none" @change="onFileSelected" />
      </div>
      <el-alert
        v-if="error"
        class="inline-alert"
        :title="error"
        type="error"
        :closable="false"
        show-icon
      />
    </section>

    <el-empty v-if="!busy.refresh && filteredItems.length === 0" description="暂无本地游戏或插件" />

    <div class="play-grid">
      <article
        v-for="item in filteredItems"
        :key="`${item.carrierType}:${item.id}`"
        class="play-card"
        :class="`carrier-${item.carrierType}`"
      >
        <div class="play-main">
          <div class="play-icon">
            <el-icon><component :is="iconOf(item)" /></el-icon>
          </div>
          <div class="play-content">
            <div class="title-row">
              <h2>{{ titleOf(item) }}</h2>
              <el-tag size="small" :type="item.carrierType === 'game' ? 'primary' : 'success'">
                {{ item.carrierType === 'game' ? '游戏' : '插件' }}
              </el-tag>
            </div>
            <p v-if="descOf(item)" class="desc">{{ descOf(item) }}</p>
            <div class="meta">
              <!-- 插件：目标域名 / 版本 / 来源 -->
              <template v-if="item.carrierType === 'plugin'">
                <el-tag size="small" type="info">{{ hostOf(item.homeUrl) || '未配置目标站点' }}</el-tag>
                <el-tag size="small">v{{ item.version || '1.0.0' }}</el-tag>
                <el-tag v-if="item.source" size="small" type="success">{{ item.source === 'builtin' ? '内置' : '用户' }}</el-tag>
              </template>
              <!-- 游戏：版本 / 来源 / 最后游玩 / 参数 -->
              <template v-else>
                <el-tag size="small" type="info">版本：{{ item.version || '-' }}</el-tag>
                <el-tag v-if="item.source === 'saved'" size="small" type="warning" effect="plain">已保存</el-tag>
                <el-tag v-else size="small" type="success" effect="plain">本地</el-tag>
                <el-tag v-if="isCachedGame(item)" size="small" type="success">已缓存</el-tag>
                <el-tag size="small" type="success">最后游玩：{{ formatLastPlayed(item.lastPlayed) }}</el-tag>
                <el-tag v-if="item.arguments" size="small">参数：{{ item.arguments }}</el-tag>
              </template>
            </div>
            <div v-if="devicesOf(item).length" class="devices">
              <span v-for="d in devicesOf(item)" :key="d.id || d.name" class="device-tag">
                {{ d.required ? '●' : '○' }} {{ d.name || d.id || '设备' }}
              </span>
            </div>
          </div>
        </div>
        <div class="play-actions">
          <el-button type="primary" :icon="VideoPlay" @click="goConfig(item)">{{ item.carrierType === 'game' ? '启动' : '配置启动' }}</el-button>
          <el-button v-if="item.carrierType === 'game'" type="danger" plain :icon="Delete" @click="deleteGame(item)">删除</el-button>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, markRaw } from 'vue';
import { useRouter } from 'vue-router';
import { track } from '../analytics';
import { useActivePlay, clearActivePlay } from '../composables/useActivePlay';
import {
  Close, Delete, Operation, Reading, Refresh, Search, Upload, VideoPlay,
} from '@element-plus/icons-vue';

type CarrierType = 'game' | 'plugin';

interface PlayDevice { id?: string; name?: string; logicalId?: string; required?: boolean; capabilities?: string[] }
interface PlayItem {
  carrierType: CarrierType;
  id: string;
  // 公共
  title?: string;
  name?: string;
  description?: string;
  version?: string;
  devices?: PlayDevice[];
  // 插件
  homeUrl?: string;
  source?: string;
  origin?: string;
  // 游戏
  arguments?: string;
  lastPlayed?: number | null;
  gamePath?: string;
  externalUrl?: string;
  cached?: boolean;
  localGamePath?: string;
  packageSha256?: string;
}

const router = useRouter();
const { activePlay } = useActivePlay();

const games = ref<PlayItem[]>([]);
const plugins = ref<PlayItem[]>([]);
const search = ref('');
const error = ref('');
const busy = ref({ refresh: false, upload: false, stop: false });
const fileInput = ref<HTMLInputElement | null>(null);

const allItems = computed(() => [
  ...games.value,
  ...plugins.value,
]);

const filteredItems = computed(() => {
  const q = search.value.trim().toLowerCase();
  const list = q
    ? allItems.value.filter((it) => (titleOf(it) || '').toLowerCase().includes(q))
    : allItems.value.slice();
  // 游戏按最后游玩倒序在前，插件按标题字母序在后
  const gamePart = list.filter((it) => it.carrierType === 'game').sort((a, b) => Number(b.lastPlayed || 0) - Number(a.lastPlayed || 0));
  const pluginPart = list.filter((it) => it.carrierType === 'plugin').sort((a, b) => (titleOf(a) || '').localeCompare(titleOf(b) || '', 'zh-CN'));
  return [...gamePart, ...pluginPart];
});

onMounted(loadAll);

async function loadAll() {
  error.value = '';
  const [gRes, pRes] = await Promise.all([
    fetch('/api/games').then((r) => r.json()).catch(() => null),
    fetch('/api/plugins').then((r) => r.json()).catch(() => null),
  ]);

  try {
    const localGames: PlayItem[] = (gRes && Array.isArray(gRes))
      ? gRes.map((g: any) => ({ ...g, carrierType: 'game' as const, source: g.source || 'builtin' }))
      : [];
    games.value = localGames;
  } catch (e: any) {
    error.value = e?.message || '游戏列表获取失败';
  }
  try {
    if (pRes && Array.isArray(pRes)) {
      plugins.value = pRes.map((p: any) => ({ ...p, carrierType: 'plugin' as const }));
    } else if (pRes && pRes.error) {
      throw new Error(pRes.error?.message || '插件列表获取失败');
    }
  } catch (e: any) {
    error.value = e?.message || '插件列表获取失败';
  }
}

async function refresh() {
  busy.value.refresh = true;
  error.value = '';
  try {
    // 游戏侧：触发后端重扫；插件侧：仅重新拉取列表
    const res = await fetch('/api/games/reload', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data?.message || '刷新失败');
    await loadAll();
  } catch (e: any) {
    error.value = e?.message || '刷新失败';
  } finally {
    busy.value.refresh = false;
  }
}

function triggerUpload() {
  fileInput.value?.click();
}

async function onFileSelected(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0] || null;
  input.value = '';
  if (!file) return;
  busy.value.upload = true;
  error.value = '';
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/games/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data?.message || '上传失败');
    track('game_upload');
    await loadAll();
  } catch (e: any) {
    error.value = e?.message || '上传失败';
  } finally {
    busy.value.upload = false;
  }
}

async function stopCurrent() {
  busy.value.stop = true;
  error.value = '';
  try {
    const current = activePlay.value;
    if (current?.carrierType === 'plugin') {
      if (!window.pluginApi) {
        throw new Error('当前环境不支持停止插件，请在 Electron 中打开控制面板');
      }
      const result = await window.pluginApi.stopCurrent();
      if (result?.ok === false) throw new Error(result.error || '停止插件失败');
      track('plugin_stop', { plugin_id: current.id });
    } else {
      const res = await fetch('/api/games/stop-current', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 501) {
        alert(data?.error?.message || '停止接口待实现');
        return;
      }
      if (!res.ok || data.error) throw new Error(data?.message || '停止失败');
      track('game_stop');
    }
    clearActivePlay();
    await loadAll();
  } catch (e: any) {
    error.value = e?.message || '停止失败';
  } finally {
    busy.value.stop = false;
  }
}

async function deleteGame(item: PlayItem) {
  const sure = confirm('确定删除该玩法？仅移除列表，不删除文件。');
  if (!sure) return;
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data?.message || '删除失败');
    track('game_delete', { game_id: item.id });
    games.value = games.value.filter((x) => x.id !== item.id);
  } catch (e: any) {
    alert(e?.message || '删除失败');
  }
}

function goConfig(item: PlayItem) {
  const query: Record<string, string> = {};
  if (item.source === 'saved') {
    query.source = 'saved';
    if (item.origin) query.origin = item.origin;
    if (item.externalUrl) query.externalUrl = item.externalUrl;
    if (item.gamePath) query.gamePath = item.gamePath;
  }
  router.push({ name: 'play_config', params: { type: item.carrierType, id: item.id }, query });
}

function resumeRun() {
  if (activePlay.value) router.push(activePlay.value.resume);
}

function titleOf(item: PlayItem) {
  return item.title || item.name || item.id;
}
function descOf(item: PlayItem) {
  return item.description || '';
}
function isCachedGame(item: PlayItem) {
  return item.cached === true || String(item.gamePath || item.localGamePath || '').startsWith('/games/cache/');
}
function devicesOf(item: PlayItem): PlayDevice[] {
  return Array.isArray(item.devices) ? item.devices : [];
}
function iconOf(item: PlayItem) {
  // markRaw 避免 Vue 把图标对象做成响应式代理
  return item.carrierType === 'plugin' ? markRaw(Operation) : markRaw(VideoPlay);
}

function hostOf(url?: string) {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
}

function formatLastPlayed(ts?: number | null) {
  if (!ts) return '从未游玩';
  try {
    return new Date(ts).toLocaleString('zh-CN');
  } catch {
    return String(ts);
  }
}
</script>

<style scoped>
.page {
  max-width: 1120px;
  margin: 0 auto;
  padding: 16px;
}

.header-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}

.header-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

h1 {
  margin: 0 0 6px;
  font-size: 24px;
}

.muted,
.desc {
  color: var(--el-text-color-secondary);
}

.running-banner {
  margin-bottom: 16px;
}

.banner-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.banner-actions {
  display: flex;
  gap: 8px;
}

.toolbar-card {
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-bg-color);
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.search {
  flex: 1 1 240px;
  min-width: 200px;
}

.inline-alert {
  margin-top: 10px;
}

.play-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}

.play-card {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-bg-color);
}

.play-main {
  display: flex;
  min-width: 0;
  gap: 12px;
}

.play-icon {
  display: grid;
  place-items: center;
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: #eef5ff;
  color: var(--el-color-primary);
  font-size: 20px;
}

.carrier-plugin .play-icon {
  background: #f0f9eb;
  color: var(--el-color-success);
}

.play-content {
  min-width: 0;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.title-row h2 {
  margin: 0;
  font-size: 18px;
}

.desc {
  margin: 0 0 12px;
  line-height: 1.5;
}

.meta,
.devices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.devices {
  margin-top: 10px;
}

.device-tag {
  padding: 2px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 999px;
  color: var(--el-text-color-regular);
  font-size: 12px;
  background: var(--el-fill-color-light);
}

.play-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
}

@media (max-width: 768px) {
  .header-row,
  .play-card,
  .play-main {
    flex-direction: column;
  }

  .play-grid {
    grid-template-columns: 1fr;
  }

  .play-actions {
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
  }

  .play-actions .el-button {
    flex: 1;
  }
}
</style>
