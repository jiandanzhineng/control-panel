<template>
  <PlayCarrierShell
    mode="browser"
    :stoppable="false"
    :address="currentUrl"
    :can-back="canBack"
    :can-forward="canForward"
    :loading="loading"
    @back="goBack"
    @forward="goForward"
    @reload="reload"
    @home="goHome"
    @navigate="navigate"
  >
    <template #toolbar-actions>
      <el-tag v-if="grantStatus.origin" size="small" :type="grantStatus.granted ? 'success' : 'info'" effect="plain">
        {{ grantStatus.granted ? '设备已授权' : '设备未授权' }}
      </el-tag>
      <el-button
        v-if="grantStatus.granted"
        size="small"
        plain
        @click="stopOrigin"
      >
        停止设备
      </el-button>
      <el-button
        v-if="grantStatus.granted"
        size="small"
        type="danger"
        plain
        @click="revokeOrigin"
      >
        撤销授权
      </el-button>
    </template>

    <template v-if="detected" #banner>
      <el-alert class="play-banner" type="success" :closable="false" show-icon>
        <div class="banner-inner">
          <span>检测到可接入设备的玩法：<b>{{ detected.name }}</b></span>
          <el-button size="small" type="primary" @click="runDetected">配置并运行</el-button>
        </div>
      </el-alert>
    </template>

    <webview
      ref="webviewEl"
      class="webview"
      :src="HOME"
      partition="persist:browser"
      allowpopups
    ></webview>
  </PlayCarrierShell>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import PlayCarrierShell from '../components/PlayCarrierShell.vue';

interface PluginMatcher {
  id: string;
  title?: string;
  name?: string;
  homeUrl?: string;
  matchUrls?: string[];
}

type DetectedPlay =
  | { kind: 'game'; name: string; externalUrl: string }
  | { kind: 'plugin'; id: string; name: string };

const router = useRouter();
const HOME = import.meta.env.VITE_BROWSER_HOME_URL || 'https://game.undersilicon.cn/';

const webviewEl = ref<any>(null);
const currentUrl = ref(HOME);
const loading = ref(false);
const canBack = ref(false);
const canForward = ref(false);
const detected = ref<DetectedPlay | null>(null);
const plugins = ref<PluginMatcher[]>([]);
const grantStatus = ref<{ granted: boolean; origin: string; expiresAt?: number }>({ granted: false, origin: '' });

let detectTimer: number | undefined;
let grantTimer: number | undefined;

function normalizeUrl(s: string): string {
  const t = s.trim();
  if (!t) return HOME;
  if (/^https?:\/\//i.test(t)) return t;
  // 像域名（含 host[:port] 或 IP）→ 默认补 http；否则交给搜索
  if (/^[\w.-]+(:\d+)?(\/|$)/.test(t) && /[.:]/.test(t)) return `http://${t}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(t)}`;
}

function navigate(input: string) {
  const url = normalizeUrl(input);
  try { webviewEl.value?.loadURL(url); } catch { /* webview 未就绪 */ }
}
function goBack() { try { webviewEl.value?.goBack(); } catch {} }
function goForward() { try { webviewEl.value?.goForward(); } catch {} }
function reload() { try { webviewEl.value?.reload(); } catch {} }
function goHome() { navigate(HOME); }

function syncNavState() {
  const wv = webviewEl.value;
  if (!wv) return;
  try {
    currentUrl.value = wv.getURL();
    canBack.value = wv.canGoBack();
    canForward.value = wv.canGoForward();
  } catch {}
}

/**
 * 复刻 electron/main.js 的 urlMatchesPattern：转义正则元字符（保留 *）、
 * * → .*、大小写不敏感、整串全匹配。
 */
function urlMatchesPattern(url: string, pattern: string): boolean {
  if (!url || !pattern) return false;
  const escaped = String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(url);
}

function matchPlugin(url: string): PluginMatcher | null {
  return (
    plugins.value.find((p) => Array.isArray(p.matchUrls) && p.matchUrls.some((pat) => urlMatchesPattern(url, pat))) ||
    null
  );
}

async function detectExternalGame(url: string): Promise<{ name: string; externalUrl: string } | null> {
  try {
    const r = await fetch(`/api/games/external/meta?url=${encodeURIComponent(url)}`);
    if (!r.ok) return null; // 422 NO_MANIFEST = 普通网页，静默
    const g = await r.json();
    return {
      name: g.name || g.title || '未命名玩法',
      externalUrl: g.externalUrl || url,
    };
  } catch {
    return null;
  }
}

async function detect(url: string) {
  detected.value = null;
  if (!/^https?:\/\//i.test(url)) return;
  // 本地通配匹配已安装插件（即时）；外部游戏抓取（网络）
  const matchedPlugin = matchPlugin(url);
  const externalGame = await detectExternalGame(url);
  if (externalGame) {
    detected.value = { kind: 'game', name: externalGame.name, externalUrl: externalGame.externalUrl };
  } else if (matchedPlugin) {
    detected.value = {
      kind: 'plugin',
      id: matchedPlugin.id,
      name: matchedPlugin.title || matchedPlugin.name || matchedPlugin.id,
    };
  }
}

function getWebContentsId(): number | null {
  const wv = webviewEl.value;
  if (!wv) return null;
  try {
    const id = Number(wv.getWebContentsId?.());
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

async function refreshGrantStatus() {
  const id = getWebContentsId();
  if (!id || !window.browserDeviceApi?.getGrantStatusForWebview) {
    grantStatus.value = { granted: false, origin: '' };
    return;
  }
  try {
    const status = await window.browserDeviceApi.getGrantStatusForWebview(id);
    if (!status.ok) {
      grantStatus.value = { granted: false, origin: '' };
      return;
    }
    grantStatus.value = {
      granted: !!status.granted,
      origin: status.origin || '',
      expiresAt: status.expiresAt,
    };
  } catch {
    grantStatus.value = { granted: false, origin: '' };
  }
}

async function revokeOrigin() {
  const id = getWebContentsId();
  if (!id || !window.browserDeviceApi?.revokeAccessForWebview) return;
  const res = await window.browserDeviceApi.revokeAccessForWebview(id);
  if (!res.ok) {
    ElMessage.error(res.error || '撤销授权失败');
    return;
  }
  ElMessage.success('已撤销当前网站设备授权');
  await refreshGrantStatus();
}

async function stopOrigin() {
  const id = getWebContentsId();
  if (!id || !window.browserDeviceApi?.stopOriginForWebview) return;
  const res = await window.browserDeviceApi.stopOriginForWebview(id);
  if (!res.ok) {
    ElMessage.error(res.error || '停止设备失败');
    return;
  }
  ElMessage.success('已停止当前网站设备会话');
}

function onNavigated() {
  syncNavState();
  refreshGrantStatus();
  if (detectTimer) clearTimeout(detectTimer);
  detectTimer = window.setTimeout(() => detect(currentUrl.value), 300);
}

function runDetected() {
  const d = detected.value;
  if (!d) return;
  if (d.kind === 'game') {
    router.push({
      name: 'play_config',
      params: { type: 'game', id: 'external' },
      query: { externalUrl: d.externalUrl },
    });
  } else {
    router.push({ name: 'play_config', params: { type: 'plugin', id: d.id } });
  }
}

async function loadPlugins() {
  try {
    const res = await fetch('/api/plugins');
    const data = await res.json();
    if (res.ok && Array.isArray(data)) plugins.value = data;
  } catch { /* 列表加载失败不影响浏览 */ }
}

function bindEvents() {
  const wv = webviewEl.value;
  if (!wv) return;
  wv.addEventListener('did-start-loading', () => { loading.value = true; });
  wv.addEventListener('did-stop-loading', () => { loading.value = false; });
  wv.addEventListener('did-navigate', onNavigated);
  wv.addEventListener('did-navigate-in-page', onNavigated);
  refreshGrantStatus();
}

onMounted(() => {
  loadPlugins();
  // webview 需在元素 attach 后绑定事件
  setTimeout(bindEvents, 0);
  grantTimer = window.setInterval(refreshGrantStatus, 2000);
});
onBeforeUnmount(() => {
  if (detectTimer) clearTimeout(detectTimer);
  if (grantTimer) clearInterval(grantTimer);
});
</script>

<style scoped>
.play-banner {
  flex: 0 0 auto;
  border-radius: 0;
}

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
