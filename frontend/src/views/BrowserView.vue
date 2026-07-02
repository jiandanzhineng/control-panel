<template>
  <div class="browser-view">
    <div class="toolbar">
      <el-button :disabled="!canBack" @click="goBack" :icon="ArrowLeft" circle size="small" />
      <el-button :disabled="!canForward" @click="goForward" :icon="ArrowRight" circle size="small" />
      <el-button @click="reload" :icon="Refresh" circle size="small" />
      <el-button @click="goHome" :icon="HomeFilled" circle size="small" />
      <el-input
        v-model="addressInput"
        class="address"
        placeholder="输入网址，如 example.com"
        clearable
        @keyup.enter="navigate"
      >
        <template #prefix>
          <el-icon v-if="isHttps" class="lock-ok"><Lock /></el-icon>
          <el-icon v-else class="lock-warn"><Warning /></el-icon>
        </template>
      </el-input>
      <el-button :loading="loading" type="primary" @click="navigate">前往</el-button>
    </div>

    <el-alert
      v-if="detectedGame"
      class="game-banner"
      type="success"
      :closable="false"
      show-icon
    >
      <div class="banner-inner">
        <span>检测到可控制硬件的游戏：<b>{{ detectedGame.name }}</b></span>
        <el-button size="small" type="primary" @click="runInPanel">在控制端运行（接入设备）</el-button>
      </div>
    </el-alert>

    <webview
      ref="webviewEl"
      class="webview"
      :src="HOME"
      partition="persist:browser"
      allowpopups
    ></webview>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import {
  ArrowLeft, ArrowRight, Refresh, HomeFilled, Lock, Warning,
} from '@element-plus/icons-vue';

const router = useRouter();
const HOME = 'http://127.0.0.1:8080/';

const webviewEl = ref<any>(null);
const addressInput = ref(HOME);
const currentUrl = ref(HOME);
const loading = ref(false);
const canBack = ref(false);
const canForward = ref(false);
const isHttps = ref(false);
const detectedGame = ref<null | { name: string; externalUrl: string; gamePath: string }>(null);

let detectTimer: number | undefined;

function normalizeUrl(s: string): string {
  const t = s.trim();
  if (!t) return HOME;
  if (/^https?:\/\//i.test(t)) return t;
  // 像域名（含 host[:port] 或 IP）→ 默认补 http；否则交给搜索
  if (/^[\w.-]+(:\d+)?(\/|$)/.test(t) && /[.:]/.test(t)) return `http://${t}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(t)}`;
}

function navigate() {
  const url = normalizeUrl(addressInput.value);
  try { webviewEl.value?.loadURL(url); } catch { /* webview 未就绪 */ }
}
function goBack() { try { webviewEl.value?.goBack(); } catch {} }
function goForward() { try { webviewEl.value?.goForward(); } catch {} }
function reload() { try { webviewEl.value?.reload(); } catch {} }
function goHome() { addressInput.value = HOME; navigate(); }

function syncNavState() {
  const wv = webviewEl.value;
  if (!wv) return;
  try {
    currentUrl.value = wv.getURL();
    addressInput.value = currentUrl.value;
    isHttps.value = currentUrl.value.startsWith('https:');
    canBack.value = wv.canGoBack();
    canForward.value = wv.canGoForward();
  } catch {}
}

async function detectGame(url: string) {
  detectedGame.value = null;
  if (!/^https?:\/\//i.test(url)) return;
  try {
    const r = await fetch(`/api/games/external/meta?url=${encodeURIComponent(url)}`);
    if (!r.ok) return; // 422 NO_MANIFEST = 普通网页，静默
    const g = await r.json();
    detectedGame.value = {
      name: g.name || g.title || '未命名游戏',
      externalUrl: g.externalUrl || url,
      gamePath: g.gamePath || '',
    };
  } catch { /* 普通网页或检测失败，忽略 */ }
}

function onNavigated() {
  syncNavState();
  if (detectTimer) clearTimeout(detectTimer);
  detectTimer = window.setTimeout(() => detectGame(currentUrl.value), 300);
}

function runInPanel() {
  if (!detectedGame.value) return;
  router.push({
    name: 'game_config',
    params: { id: 'external' },
    query: { externalUrl: detectedGame.value.externalUrl },
  });
}

function bindEvents() {
  const wv = webviewEl.value;
  if (!wv) return;
  wv.addEventListener('did-start-loading', () => { loading.value = true; });
  wv.addEventListener('did-stop-loading', () => { loading.value = false; });
  wv.addEventListener('did-navigate', onNavigated);
  wv.addEventListener('did-navigate-in-page', onNavigated);
}

onMounted(() => {
  // webview 需在元素 attach 后绑定事件
  setTimeout(bindEvents, 0);
});
onBeforeUnmount(() => {
  if (detectTimer) clearTimeout(detectTimer);
});
</script>

<style scoped>
.browser-view {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--el-border-color);
  flex: 0 0 auto;
}
.address { flex: 1 1 auto; }
.lock-ok { color: var(--el-color-success); }
.lock-warn { color: var(--el-color-warning); }
.game-banner { flex: 0 0 auto; border-radius: 0; }
.banner-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.webview {
  flex: 1 1 auto;
  width: 100%;
  border: 0;
  display: inline-flex;
}
</style>
