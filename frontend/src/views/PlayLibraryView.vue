<template>
  <div class="library-page">
    <header class="lib-header">
      <div class="lib-header__title">
        <p class="section-label">{{ t('plays.eyebrow') }}</p>
        <h1>{{ t('plays.title') }}</h1>
        <p class="lib-subtitle">{{ t('plays.desc') }}</p>
      </div>
      <div class="lib-header__actions">
        <el-button :icon="TopRight" @click="openSite">{{ t('plays.openSite') }}</el-button>
        <el-dropdown trigger="click" :disabled="busy.refresh || busy.upload" @command="onHeaderCommand">
          <button class="icon-btn" :title="t('plays.more')" :aria-label="t('plays.more')">
            <el-icon v-if="busy.refresh || busy.upload" class="is-loading"><Loading /></el-icon>
            <el-icon v-else><MoreFilled /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="refresh" :icon="Refresh">{{ t('common.refresh') }}</el-dropdown-item>
              <el-dropdown-item command="upload" :icon="Upload">{{ t('plays.loadExternal') }}</el-dropdown-item>
              <el-dropdown-item command="guide" :icon="Reading">{{ t('plays.guide') }}</el-dropdown-item>
              <el-dropdown-item command="stop" :icon="Close" divided>{{ t('plays.stopCurrent') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <input ref="fileInput" type="file" accept=".js" style="display: none" @change="onFileSelected" />
      </div>
    </header>

    <section v-if="activePlay" class="lib-focus lib-focus--running">
      <div class="lib-focus__main">
        <span class="lib-pulse" />
        <div class="lib-focus__text">
          <p class="lib-focus__label">{{ t('plays.runningLabel') }}</p>
          <h2 class="lib-focus__title">{{ activePlay.title }}</h2>
        </div>
      </div>
      <div class="lib-focus__actions">
        <el-button type="primary" plain @click="resumeRun">{{ t('plays.resume') }}</el-button>
        <el-button :loading="busy.stop" @click="stopCurrent">{{ t('common.stop') }}</el-button>
      </div>
    </section>

    <section v-else-if="recentGame" class="lib-focus lib-focus--recent" @click="startGame(recentGame)">
      <div class="lib-cover lib-cover--mini" :style="coverStyle(recentGame.id)">
        <span class="lib-cover__glyph">{{ firstGlyph(recentGame.title) }}</span>
      </div>
      <div class="lib-focus__text">
        <p class="lib-focus__label">{{ t('plays.continueTitle') }}</p>
        <h2 class="lib-focus__title">{{ recentGame.title }}</h2>
        <p v-if="recentGame.description" class="lib-focus__desc">{{ recentGame.description }}</p>
        <span class="lib-meta">{{ playedText(recentGame.lastPlayed) }}</span>
      </div>
      <el-button class="lib-focus__cta" type="primary" @click.stop="startGame(recentGame)">
        {{ t('plays.start') }}
      </el-button>
    </section>

    <div class="lib-toolbar">
      <div class="lib-filters" role="tablist">
        <button
          v-for="tab in filterTabs"
          :key="tab.key"
          class="lib-filter"
          :class="{ 'is-active': filter === tab.key }"
          role="tab"
          :aria-selected="filter === tab.key"
          @click="filter = tab.key"
        >
          {{ t(tab.label) }}<span class="lib-filter__count mono">{{ tab.count }}</span>
        </button>
      </div>
      <div class="lib-toolbar__right">
        <span v-if="registryLoading" class="lib-hint">{{ t('plays.onlineSyncing') }}</span>
        <span v-else-if="registryFailed" class="lib-hint">
          {{ t('plays.onlineUnavailable') }}
          <button class="lib-hint__retry" @click="loadRegistry(true)">{{ t('common.retry') }}</button>
        </span>
        <span v-else-if="registryStale" class="lib-hint">{{ t('plays.onlineStale') }}</span>
        <el-input
          v-model="search"
          class="lib-search"
          :placeholder="t('plays.search')"
          :prefix-icon="Search"
          clearable
        />
      </div>
    </div>

    <div v-if="loading" class="lib-loading">
      <el-skeleton :rows="3" animated />
    </div>

    <div v-else-if="hasVisible" class="lib-grid">
      <article
        v-for="card in gameCards"
        :key="`game:${card.id}`"
        class="lib-card"
        tabindex="0"
        @click="startGame(card)"
        @keydown.enter.self.prevent="startGame(card)"
      >
        <div class="lib-cover" :style="coverStyle(card.id)">
          <span class="lib-cover__glyph">{{ firstGlyph(card.title) }}</span>
          <span class="lib-badge" :class="`lib-badge--${card.badgeTone}`">
            <span v-if="card.running" class="lib-pulse" />
            {{ card.badgeText }}
          </span>
          <div v-if="card.remote || card.local" class="lib-menu" @click.stop>
            <el-dropdown trigger="click" @command="(cmd: string) => onGameCommand(cmd, card)">
              <button class="lib-menu-btn" :aria-label="t('plays.more')">
                <el-icon><MoreFilled /></el-icon>
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-if="card.remote" command="site">{{ t('plays.viewOnSite') }}</el-dropdown-item>
                  <el-dropdown-item v-if="card.local" command="delete" divided>{{ t('common.delete') }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
        <div class="lib-body">
          <h2 class="lib-title">{{ card.title }}</h2>
          <p class="lib-desc">{{ card.description || ' ' }}</p>
          <div v-if="card.chips.length" class="lib-chips">
            <el-tooltip v-for="chip in card.chips" :key="chip.key" :content="chipTip(chip)" placement="top">
              <span class="lib-chip" :class="{ 'lib-chip--required': chip.required }">{{ chipLabel(chip) }}</span>
            </el-tooltip>
            <span v-if="card.overflow" class="lib-chip lib-chip--more">+{{ card.overflow }}</span>
          </div>
        </div>
        <div class="lib-foot">
          <div class="lib-foot__info">
            <span class="lib-meta">{{ card.meta }}</span>
            <el-tooltip v-if="card.runtime" :content="t(card.runtime.tipKey)" placement="top">
              <span class="lib-runtime" :class="{ 'lib-runtime--accent': card.runtime.accent }">
                {{ t(card.runtime.key) }}
              </span>
            </el-tooltip>
          </div>
          <div class="lib-action" @click.stop>
            <el-tooltip
              :disabled="card.launch !== 'remote' || card.cached"
              :content="t('plays.firstDownload')"
              placement="top"
            >
              <el-button type="primary" size="small" @click="startGame(card)">{{ t('plays.start') }}</el-button>
            </el-tooltip>
          </div>
        </div>
      </article>

      <article
        v-for="plugin in pluginCards"
        :key="`plugin:${plugin.id}`"
        class="lib-card"
        tabindex="0"
        @click="startPlugin(plugin.id)"
        @keydown.enter.self.prevent="startPlugin(plugin.id)"
      >
        <div class="lib-cover lib-cover--plugin" :style="coverStyle(plugin.id)">
          <el-icon class="lib-cover__icon"><Operation /></el-icon>
          <span class="lib-badge">{{ t('plays.plugin') }}</span>
        </div>
        <div class="lib-body">
          <h2 class="lib-title">{{ plugin.title }}</h2>
          <p class="lib-desc">{{ plugin.description || ' ' }}</p>
          <div class="lib-chips">
            <span class="lib-chip">{{ plugin.host || t('plays.noSite') }}</span>
          </div>
        </div>
        <div class="lib-foot">
          <div class="lib-foot__info">
            <span class="lib-meta">{{ plugin.meta }}</span>
          </div>
          <div class="lib-action" @click.stop>
            <el-button type="primary" size="small" @click="startPlugin(plugin.id)">
              {{ t('plays.configStart') }}
            </el-button>
          </div>
        </div>
      </article>

      <LocalAppCard v-for="app in visibleApps" :key="`local-app:${app.id}`" :app="app" @refresh="loadAll" />
    </div>

    <el-empty v-else :description="emptyText" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Close, Loading, MoreFilled, Operation, Reading, Refresh, Search, TopRight, Upload } from '@element-plus/icons-vue';
import { track } from '../analytics';
import { trackPlayEnd } from '../playAnalytics';
import { clearActivePlay, setActivePlay, useActivePlay } from '../composables/useActivePlay';
import { useRemoteSession } from '../composables/useRemoteSession';
import LocalAppCard from '../components/LocalAppCard.vue';
import { currentLocale } from '../i18n';
import { localizePlay } from '../i18n/play';
import { runtimeTagFor, type RuntimeTag } from '../play/runtimeTag';
import {
  deviceChips,
  filterGames,
  firstGlyph,
  formatSize,
  hueForId,
  matchesQuery,
  mergeGames,
  mostRecentGame,
  relativeTime,
  sortGames,
  titleOf,
  type DeviceChip,
  type LibraryFilter,
  type LibraryGame,
  type LocalGame,
  type RemoteGame,
} from '../play/library';

interface GameCard extends LibraryGame {
  chips: DeviceChip[];
  overflow: number;
  running: boolean;
  badgeTone: 'local' | 'online' | 'update' | 'running';
  badgeText: string;
  meta: string;
  runtime: RuntimeTag | null;
}

interface PluginCard {
  id: string;
  title: string;
  description: string;
  host: string;
  meta: string;
}

const router = useRouter();
const { t, te, locale } = useI18n();
const { activePlay } = useActivePlay();
const remoteSession = useRemoteSession();

const SITE_HOME = import.meta.env.VITE_BROWSER_HOME_URL || 'https://game.undersilicon.cn/';

const games = ref<LocalGame[]>([]);
const remoteGames = ref<RemoteGame[]>([]);
const plugins = ref<Record<string, any>[]>([]);
const localApps = ref<Record<string, any>[]>([]);
/** 分离式（runtime: host）游戏 id：逻辑在被控端跑 */
const hostGameIds = ref<Set<string>>(new Set());
const search = ref('');
const filter = ref<LibraryFilter>('all');
const loading = ref(true);
const loaded = ref(false);
const registryFailed = ref(false);
const registryStale = ref(false);
const registryLoading = ref(false);
const nowMs = ref(Date.now());
const busy = ref({ upload: false, refresh: false, stop: false });
const fileInput = ref<HTMLInputElement | null>(null);

const mergedGames = computed(() => mergeGames(games.value, remoteGames.value));
const runningId = computed(() => (activePlay.value?.carrierType === 'game' ? activePlay.value.id : null));
const sortedGames = computed(() =>
  sortGames(mergedGames.value, { runningId: runningId.value, locale: t('plays.sortLocale') }),
);
const recentGame = computed(() => mostRecentGame(mergedGames.value));

function runtimeTagOf(game: LibraryGame): RuntimeTag | null {
  return runtimeTagFor({
    isGame: true,
    isHostRuntime: hostGameIds.value.has(String(game.id)),
    isOperatorRemote: remoteSession.isOperatorRemote.value === true,
  });
}

function capLabel(cap: string): string {
  const key = `playConfig.caps.${cap}`;
  return te(key) ? t(key) : cap;
}

function chipLabel(chip: DeviceChip): string {
  if (chip.label) return chip.label;
  if (chip.capabilities.length) return capLabel(chip.capabilities[0]);
  return t('plays.deviceFallback');
}

function chipTip(chip: DeviceChip): string {
  if (!chip.capabilities.length) return chipLabel(chip);
  const caps = chip.capabilities.map(capLabel).join(t('common.sep'));
  return t(chip.required ? 'plays.needsCaps' : 'plays.optionalCaps', { caps });
}

function playedText(ts?: number | null): string {
  const rel = relativeTime(ts, nowMs.value);
  if (rel.kind === 'never') return t('plays.neverPlayed');
  const time = rel.kind === 'justNow' ? t('plays.time.justNow') : t(`plays.time.${rel.kind}`, { n: rel.value });
  return t('plays.playedAgo', { time });
}

function toGameCard(game: LibraryGame): GameCard {
  const running = !!runningId.value && game.id === runningId.value;
  let badgeTone: GameCard['badgeTone'] = 'local';
  let badgeText = t('plays.badgeLocal');
  if (running) {
    badgeTone = 'running';
    badgeText = t('plays.badgeRunning');
  } else if (game.updateAvailable) {
    badgeTone = 'update';
    badgeText = t('plays.badgeUpdate', { version: game.remoteVersion || '' });
  } else if (!game.local) {
    badgeTone = 'online';
    badgeText = t('plays.badgeOnline');
  }
  const parts: string[] = [];
  if (game.local) {
    parts.push(`v${game.version}`);
    parts.push(playedText(game.lastPlayed));
  } else {
    parts.push(t('plays.badgeOnline'));
    const size = formatSize(game.packageSize);
    if (size) parts.push(size);
  }
  const { chips, overflow } = deviceChips(game.devices);
  return {
    ...game,
    chips,
    overflow,
    running,
    badgeTone,
    badgeText,
    meta: parts.join(' · '),
    runtime: running ? null : runtimeTagOf(game),
  };
}

const gameCards = computed(() =>
  filterGames(sortedGames.value, filter.value, search.value).map(toGameCard),
);

const filterTabs = computed(() => {
  const all = mergedGames.value;
  return [
    { key: 'all' as LibraryFilter, label: 'plays.filter.all', count: all.length + plugins.value.length + localApps.value.length },
    { key: 'local' as LibraryFilter, label: 'plays.filter.local', count: filterGames(all, 'local').length },
    { key: 'online' as LibraryFilter, label: 'plays.filter.online', count: filterGames(all, 'online').length },
    { key: 'apps' as LibraryFilter, label: 'plays.filter.apps', count: plugins.value.length + localApps.value.length },
  ];
});

function hostOf(url?: string): string {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
}

const pluginCards = computed<PluginCard[]>(() => {
  if (filter.value !== 'all' && filter.value !== 'apps') return [];
  return plugins.value
    .filter((p) => matchesQuery({ title: titleOf(p), description: String(p.description || '') }, search.value))
    .map((p) => {
      const meta = [`v${p.version || '1.0.0'}`, p.source === 'builtin' ? t('plays.builtin') : t('plays.user')];
      return {
        id: String(p.id),
        title: titleOf(p),
        description: String(p.description || ''),
        host: hostOf(p.homeUrl),
        meta: meta.join(' · '),
      };
    });
});

const visibleApps = computed(() => {
  if (filter.value !== 'all' && filter.value !== 'apps') return [];
  return localApps.value.filter((app) =>
    matchesQuery({ title: titleOf(app), description: String(app.description || '') }, search.value),
  );
});

const hasVisible = computed(
  () => gameCards.value.length > 0 || pluginCards.value.length > 0 || visibleApps.value.length > 0,
);

const emptyText = computed(() =>
  search.value.trim() ? t('plays.emptySearch') : t('plays.empty'),
);

function coverStyle(id: string): Record<string, string> {
  return { '--hue': String(hueForId(id)) };
}

function openSite() {
  router.push({ name: 'browser' });
}

async function loadRegistry(force = false) {
  registryLoading.value = true;
  try {
    const res = await fetch(`/api/game-registry${force ? '?refresh=1' : ''}`);
    const data = await res.json().catch(() => null);
    const games = Array.isArray(data?.games) ? data.games : [];
    // error / 空离线缓存都算不可用；stale 但有缓存游戏时照常显示并提示离线
    if (!res.ok || data?.error || (data?.stale && games.length === 0)) {
      throw new Error(data?.error?.message || data?.error || t('plays.loadRegistryFailed'));
    }
    remoteGames.value = games.map((g: any) => localizePlay(g, currentLocale()) as RemoteGame);
    registryFailed.value = false;
    registryStale.value = !!data?.stale;
  } catch {
    // 在线库不可用时只显示弱提示，本机游戏照常显示
    remoteGames.value = [];
    registryFailed.value = true;
    registryStale.value = false;
  } finally {
    registryLoading.value = false;
  }
}

async function loadStatus() {
  try {
    const status = await fetch('/api/games/status').then((r) => r.json());
    if (status?.running && status.runtimeMode === 'host') {
      setActivePlay({
        carrierType: 'game',
        id: status.gameId,
        title: status.snapshot?.title || status.gameId,
        resume: { name: 'game_runtime', query: { id: status.gameId } },
      });
    }
  } catch {}
}

async function loadAll(options: { registry?: boolean } = {}) {
  if (!loaded.value) loading.value = true;
  const [gRes, pRes, aRes, rRes] = await Promise.all([
    fetch('/api/games').then((r) => r.json()).catch(() => null),
    fetch('/api/plugins').then((r) => r.json()).catch(() => null),
    fetch('/api/local-apps').then((r) => r.json()).catch(() => null),
    fetch('/api/game-runtime/games').then((r) => r.json()).catch(() => null),
  ]);
  localApps.value = Array.isArray(aRes) ? aRes : [];
  hostGameIds.value = new Set(
    (Array.isArray(rRes) ? rRes : [])
      .filter((row: any) => row?.runtimeMode === 'host' && row?.id)
      .map((row: any) => String(row.id)),
  );
  try {
    games.value = gRes && Array.isArray(gRes)
      ? gRes.map((g: any) => localizePlay(g, currentLocale()) as LocalGame)
      : [];
    if (gRes && !Array.isArray(gRes) && gRes.error) throw new Error(gRes.error?.message || t('plays.loadGamesFailed'));
  } catch (e: any) {
    games.value = [];
    ElMessage.error(e?.message || t('plays.loadGamesFailed'));
  }
  try {
    if (pRes && Array.isArray(pRes)) {
      plugins.value = pRes.map((p: any) => localizePlay(p, currentLocale()));
    } else {
      plugins.value = [];
      if (pRes?.error) throw new Error(pRes.error?.message || t('plays.loadPluginsFailed'));
    }
  } catch (e: any) {
    plugins.value = [];
    ElMessage.error(e?.message || t('plays.loadPluginsFailed'));
  }
  // 首屏不等在线库：本机列表一到就结束 loading，在线库稍后增量合并
  nowMs.value = Date.now();
  loaded.value = true;
  loading.value = false;
  if (options.registry !== false) void loadRegistry(false);
  void loadStatus();
}
async function refresh() {
  busy.value.refresh = true;
  try {
    const res = await fetch('/api/games/reload', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data?.message || t('plays.refreshFailed'));
    await loadAll({ registry: false });
    await loadRegistry(true);
    nowMs.value = Date.now();
  } catch (e: any) {
    ElMessage.error(e?.message || t('plays.refreshFailed'));
  } finally {
    busy.value.refresh = false;
  }
}

function openDevGuide() {
  window.open(`${new URL('docs/agent-guide.html', SITE_HOME)}`, '_blank');
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
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/games/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data?.message || t('plays.uploadFailed'));
    track('game_upload');
    ElMessage.success(t('plays.uploadSuccess'));
    await loadAll();
    nowMs.value = Date.now();
  } catch (e: any) {
    ElMessage.error(e?.message || t('plays.uploadFailed'));
  } finally {
    busy.value.upload = false;
  }
}

function onHeaderCommand(command: string) {
  if (command === 'upload') triggerUpload();
  else if (command === 'guide') openDevGuide();
  else if (command === 'stop') void stopCurrent();
  else if (command === 'refresh') void refresh();
}

function siteUrl(path: string): string {
  try {
    return new URL(path, SITE_HOME).toString();
  } catch {
    return path;
  }
}

function viewOnSite(game: LibraryGame) {
  router.push({ name: 'browser', query: { url: siteUrl(`game-intro.html?id=${encodeURIComponent(game.id)}`) } });
}

function onGameCommand(command: string, game: GameCard) {
  if (command === 'site') viewOnSite(game);
  else if (command === 'delete') void deleteGame(game);
}

function startGame(game: LibraryGame) {
  if (game.launch === 'remote') {
    router.push({ name: 'play_config', params: { type: 'game', id: game.id }, query: { source: 'remote' } });
    return;
  }
  const local = game.local;
  const query: Record<string, string> = {};
  if (local?.source === 'saved') {
    query.source = 'saved';
    if (local.origin) query.origin = String(local.origin);
    if (local.externalUrl) query.externalUrl = String(local.externalUrl);
    if (local.gamePath) query.gamePath = String(local.gamePath);
  }
  router.push({ name: 'play_config', params: { type: 'game', id: game.id }, query });
}

function startPlugin(id: string) {
  router.push({ name: 'play_config', params: { type: 'plugin', id } });
}

function resumeRun() {
  if (activePlay.value?.resumeWindow) {
    void window.localAppWindowApi?.focus();
    return;
  }
  if (activePlay.value) router.push(activePlay.value.resume);
}

async function stopCurrent() {
  const current = activePlay.value;
  busy.value.stop = true;
  try {
    if (current?.carrierType === 'plugin') {
      if (!window.pluginApi) throw new Error(t('plays.pluginStopUnsupported'));
      const result = await window.pluginApi.stopCurrent();
      if (result?.ok === false) throw new Error(result.error || t('plays.stopPluginFailed'));
      trackPlayEnd('user_stop');
    } else if (current?.carrierType === 'local-app') {
      await fetch(`/api/local-apps/${encodeURIComponent(current.id)}/stop`, { method: 'POST' }).catch(() => null);
      await window.localAppWindowApi?.close();
      trackPlayEnd('user_stop');
    } else {
      const res = await fetch('/api/games/stop-current', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 501) {
        ElMessage.info(data?.error?.message || t('plays.stopPending'));
        return;
      }
      if (!res.ok || data.error) throw new Error(data?.message || t('plays.stopFailed'));
      trackPlayEnd('user_stop');
    }
    clearActivePlay();
    await loadAll();
  } catch (e: any) {
    ElMessage.error(e?.message || t('plays.stopFailed'));
  } finally {
    busy.value.stop = false;
  }
}

async function deleteGame(game: LibraryGame) {
  try {
    await ElMessageBox.confirm(t('plays.deleteConfirm'), t('plays.deleteTitle'), {
      confirmButtonText: t('common.delete'),
      cancelButtonText: t('common.cancel'),
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(game.id)}?removeFile=1`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data?.message || t('plays.deleteFailed'));
    track('game_delete', { game_id: game.id });
    await loadAll();
  } catch (e: any) {
    ElMessage.error(e?.message || t('plays.deleteFailed'));
  }
}

watch(locale, () => {
  void loadAll();
});
onMounted(loadAll);
</script>

<style scoped>
.library-page {
  width: 100%;
  max-width: 1120px;
  margin: 0 auto;
  padding: 32px 24px 48px;
  box-sizing: border-box;
}

.lib-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 28px;
}

.lib-header h1 {
  margin: 8px 0 0;
  color: var(--text-primary);
  font-size: 30px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
}

.lib-subtitle {
  max-width: 560px;
  margin: 10px 0 0;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.6;
}

.lib-header__actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease, background-color 0.2s ease;
}

.icon-btn:hover {
  border-color: var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.lib-focus {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
  padding: 16px 18px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
}

.lib-focus--running {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border-subtle));
  background:
    linear-gradient(90deg, var(--accent-glow), transparent 62%),
    var(--bg-surface);
}

.lib-focus--recent {
  cursor: pointer;
  transition: border-color 0.2s ease, transform 0.2s ease;
}

.lib-focus--recent:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
}

.lib-focus__main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.lib-focus__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.lib-focus__label {
  margin: 0;
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
}

.lib-focus__title {
  margin: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.lib-focus__desc {
  margin: 0 0 2px;
  overflow: hidden;
  max-width: 720px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.lib-focus__actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}

.lib-focus__cta {
  flex-shrink: 0;
}

.lib-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.lib-filters {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--bg-surface);
}

.lib-filter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12.5px;
  cursor: pointer;
  transition: color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;
}

.lib-filter:hover {
  background: var(--hover-overlay);
  color: var(--text-primary);
}

.lib-filter.is-active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-light);
}

.lib-filter__count {
  color: var(--text-faint);
  font-size: 11px;
}

.lib-filter.is-active .lib-filter__count {
  color: var(--accent);
}

.lib-toolbar__right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.lib-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
  font-size: 12px;
}

.lib-hint__retry {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
}

.lib-hint__retry:hover {
  color: var(--accent-strong);
}

.lib-search {
  width: 220px;
}

.lib-search :deep(.el-input__wrapper) {
  border-radius: 999px;
}

.lib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

.lib-loading {
  padding: 8px 0;
}

@media (max-width: 860px) {
  .library-page {
    padding: 24px 16px 40px;
  }

  .lib-header {
    flex-direction: column;
    gap: 16px;
  }

  .lib-header__actions {
    width: 100%;
  }

  .lib-toolbar {
    align-items: stretch;
  }

  .lib-toolbar__right {
    width: 100%;
  }

  .lib-search {
    flex: 1;
    width: 100%;
  }
}

@media (max-width: 560px) {
  .lib-grid {
    grid-template-columns: 1fr;
  }

  .lib-focus {
    flex-wrap: wrap;
  }

  .lib-focus__actions {
    width: 100%;
  }

  .lib-focus__actions .el-button {
    flex: 1;
  }
}
</style>
