<template>
  <div class="page">
    <div class="header-row">
      <div>
        <h1>{{ t('plays.title') }}</h1>
        <p class="muted">{{ t('plays.desc') }}</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Reading" @click="openDevGuide">{{ t('plays.guide') }}</el-button>
        <el-button :icon="Refresh" :loading="busy.refresh" @click="refresh">{{ t('common.refresh') }}</el-button>
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
          <span>{{ t('plays.running', { title: activePlay.title }) }}</span>
          <span class="banner-actions">
            <el-button size="small" type="primary" @click="resumeRun">{{ t('plays.resume') }}</el-button>
            <el-button size="small" type="danger" :loading="busy.stop" @click="stopCurrent">{{ t('common.stop') }}</el-button>
          </span>
        </div>
      </template>
    </el-alert>

    <section class="toolbar-card">
      <div class="row">
        <el-input
          v-model="search"
          class="search"
          :placeholder="t('plays.search')"
          clearable
          :prefix-icon="Search"
        />
        <el-button :icon="Upload" :loading="busy.upload" @click="triggerUpload">{{ t('plays.loadExternal') }}</el-button>
        <el-button :icon="Close" :loading="busy.stop" type="danger" plain @click="stopCurrent">{{ t('plays.stopCurrent') }}</el-button>
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

    <el-empty v-if="!busy.refresh && filteredItems.length === 0 && localApps.length === 0" :description="t('plays.empty')" />

    <div class="play-grid">
      <LocalAppCard
        v-for="app in localApps"
        :key="`local-app:${app.id}`"
        :app="app"
        @refresh="loadAll"
      />
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
                {{ item.carrierType === 'game' ? t('plays.game') : t('plays.plugin') }}
              </el-tag>
            </div>
            <p v-if="descOf(item)" class="desc">{{ descOf(item) }}</p>
            <div class="meta">
              <!-- 插件：目标域名 / 版本 / 来源 -->
              <template v-if="item.carrierType === 'plugin'">
                <el-tag size="small" type="info">{{ hostOf(item.homeUrl) || t('plays.noSite') }}</el-tag>
                <el-tag size="small">v{{ item.version || '1.0.0' }}</el-tag>
                <el-tag v-if="item.source" size="small" type="success">{{ item.source === 'builtin' ? t('plays.builtin') : t('plays.user') }}</el-tag>
              </template>
              <!-- 游戏：版本 / 来源 / 最后游玩 / 参数 -->
              <template v-else>
                <el-tag size="small" type="info">{{ t('plays.version', { version: item.version || '-' }) }}</el-tag>
                <el-tag v-if="item.source === 'saved'" size="small" type="warning" effect="plain">{{ t('plays.saved') }}</el-tag>
                <el-tag v-else size="small" type="success" effect="plain">{{ t('plays.local') }}</el-tag>
                <el-tag v-if="isCachedGame(item)" size="small" type="success">{{ t('plays.cached') }}</el-tag>
                <el-tag size="small" type="success">{{ t('plays.lastPlayed', { time: formatLastPlayed(item.lastPlayed) }) }}</el-tag>
                <el-tag v-if="item.arguments" size="small">{{ t('plays.params', { value: item.arguments }) }}</el-tag>
              </template>
            </div>
            <div v-if="devicesOf(item).length" class="devices">
              <span v-for="d in devicesOf(item)" :key="d.id || d.name" class="device-tag">
                {{ d.required ? '●' : '○' }} {{ d.name || d.id || t('plays.deviceFallback') }}
              </span>
            </div>
          </div>
        </div>
        <div class="play-actions">
          <el-button type="primary" :icon="VideoPlay" @click="goConfig(item)">{{ item.carrierType === 'game' ? t('plays.start') : t('plays.configStart') }}</el-button>
          <el-button v-if="item.carrierType === 'game'" type="danger" plain :icon="Delete" @click="deleteGame(item)">{{ t('common.delete') }}</el-button>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, markRaw } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { track } from '../analytics';
import { useActivePlay, clearActivePlay } from '../composables/useActivePlay';
import LocalAppCard from '../components/LocalAppCard.vue';
import { currentLocale } from '../i18n';
import { localizePlay } from '../i18n/play';
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
const { t, locale } = useI18n();
const { activePlay } = useActivePlay();

const games = ref<PlayItem[]>([]);
const plugins = ref<PlayItem[]>([]);
const localApps = ref<Record<string, any>[]>([]);
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
  const pluginPart = list.filter((it) => it.carrierType === 'plugin').sort((a, b) => (titleOf(a) || '').localeCompare(titleOf(b) || '', t('plays.sortLocale')));
  return [...gamePart, ...pluginPart];
});

onMounted(loadAll);
watch(locale, () => { void loadAll(); });

async function loadAll() {
  error.value = '';
  const [gRes, pRes, aRes] = await Promise.all([
    fetch('/api/games').then((r) => r.json()).catch(() => null),
    fetch('/api/plugins').then((r) => r.json()).catch(() => null),
    fetch('/api/local-apps').then((r) => r.json()).catch(() => null),
  ]);
  localApps.value = Array.isArray(aRes) ? aRes : [];

  try {
    const localGames: PlayItem[] = (gRes && Array.isArray(gRes))
      ? gRes.map((g: any) => ({ ...localizePlay(g, currentLocale()), carrierType: 'game' as const, source: g.source || 'builtin' }))
      : [];
    games.value = localGames;
  } catch (e: any) {
    error.value = e?.message || t('plays.loadGamesFailed');
  }
  try {
    if (pRes && Array.isArray(pRes)) {
      plugins.value = pRes.map((p: any) => ({ ...localizePlay(p, currentLocale()), carrierType: 'plugin' as const }));
    } else if (pRes && pRes.error) {
      throw new Error(pRes.error?.message || t('plays.loadPluginsFailed'));
    }
  } catch (e: any) {
    error.value = e?.message || t('plays.loadPluginsFailed');
  }
}

function openDevGuide() {
  window.open('https://game.undersilicon.cn/docs/agent-guide.html', '_blank');
}

async function refresh() {
  busy.value.refresh = true;
  error.value = '';
  try {
    // 游戏侧：触发后端重扫；插件侧：仅重新拉取列表
    const res = await fetch('/api/games/reload', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data?.message || t('plays.refreshFailed'));
    await loadAll();
  } catch (e: any) {
    error.value = e?.message || t('plays.refreshFailed');
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
    if (!res.ok || data.error) throw new Error(data?.message || t('plays.uploadFailed'));
    track('game_upload');
    await loadAll();
  } catch (e: any) {
    error.value = e?.message || t('plays.uploadFailed');
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
        throw new Error(t('plays.pluginStopUnsupported'));
      }
      const result = await window.pluginApi.stopCurrent();
      if (result?.ok === false) throw new Error(result.error || t('plays.stopPluginFailed'));
      track('plugin_stop', { plugin_id: current.id });
    } else {
      const res = await fetch('/api/games/stop-current', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 501) {
        alert(data?.error?.message || t('plays.stopPending'));
        return;
      }
      if (!res.ok || data.error) throw new Error(data?.message || t('plays.stopFailed'));
      track('game_stop');
    }
    if (current?.carrierType === 'local-app') {
      await window.localAppWindowApi?.close();
    }
    clearActivePlay();
    await loadAll();
  } catch (e: any) {
    error.value = e?.message || t('plays.stopFailed');
  } finally {
    busy.value.stop = false;
  }
}

async function deleteGame(item: PlayItem) {
  const sure = confirm(t('plays.deleteConfirm'));
  if (!sure) return;
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(item.id)}?removeFile=1`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data?.message || t('plays.deleteFailed'));
    track('game_delete', { game_id: item.id });
    games.value = games.value.filter((x) => x.id !== item.id);
  } catch (e: any) {
    alert(e?.message || t('plays.deleteFailed'));
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
  if (activePlay.value?.resumeWindow) {
    void window.localAppWindowApi?.focus();
    return;
  }
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
  if (!ts) return t('plays.neverPlayed');
  try {
    return new Date(ts).toLocaleString(locale.value === 'en' ? 'en-US' : 'zh-CN');
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
  background: var(--accent-glow);
  color: var(--accent);
  font-size: 20px;
}

.carrier-plugin .play-icon {
  background: rgba(74, 222, 128, 0.1);
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
