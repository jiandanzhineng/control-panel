<template>
  <div class="plugin-run">
    <div class="toolbar">
      <el-button :disabled="!canBack" :icon="ArrowLeft" circle size="small" @click="goBack" />
      <el-button :disabled="!canForward" :icon="ArrowRight" circle size="small" @click="goForward" />
      <el-button :icon="Refresh" circle size="small" @click="reload" />
      <el-input v-model="currentUrl" class="address" readonly>
        <template #prefix>
          <el-icon v-if="isHttps" class="lock-ok"><Lock /></el-icon>
          <el-icon v-else class="lock-warn"><Warning /></el-icon>
        </template>
      </el-input>
      <el-button type="danger" :icon="Close" :loading="stopping" @click="stopPlugin">停止</el-button>
    </div>

    <el-alert
      v-if="error"
      class="run-alert"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    />

    <webview
      v-if="runtime && !stopped"
      ref="webviewEl"
      class="webview"
      :src="runtime.homeUrl"
      :preload="runtime.detectorUrl"
      partition="persist:browser"
      allowpopups
    ></webview>

    <el-empty v-else class="empty" description="插件未运行或正在加载" :image-size="120">
      <el-button type="primary" @click="$router.push('/plugins')">返回插件列表</el-button>
    </el-empty>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, ArrowRight, Close, Lock, Refresh, Warning } from '@element-plus/icons-vue';

interface RuntimeInfo {
  id: string;
  homeUrl: string;
  detectorUrl: string;
}

const route = useRoute();
const router = useRouter();
const pluginId = String(route.params.id || '');

const runtime = ref<RuntimeInfo | null>(null);
const webviewEl = ref<any>(null);
const currentUrl = ref('');
const canBack = ref(false);
const canForward = ref(false);
const isHttps = ref(false);
const error = ref('');
const stopping = ref(false);
const stopped = ref(false);

onMounted(async () => {
  await loadRuntime();
});

onBeforeUnmount(() => {
  stopBridgeOnly();
});

async function loadRuntime() {
  error.value = '';
  try {
    if (!window.pluginApi) throw new Error('当前环境不支持插件运行，请在 Electron 中打开控制面板');
    const info = await window.pluginApi.getRuntimeInfo(pluginId);
    runtime.value = info;
    currentUrl.value = info.homeUrl;
    isHttps.value = info.homeUrl.startsWith('https:');
    await nextTick();
    setTimeout(bindWebviewEvents, 0);
  } catch (e: any) {
    error.value = e?.message || '插件运行信息加载失败';
  }
}

function bindWebviewEvents() {
  const wv = webviewEl.value;
  if (!wv) return;
  wv.addEventListener('did-start-loading', syncNavState);
  wv.addEventListener('did-stop-loading', syncNavState);
  wv.addEventListener('did-navigate', syncNavState);
  wv.addEventListener('did-navigate-in-page', syncNavState);
  wv.addEventListener('did-fail-load', (event: any) => {
    if (event?.errorCode === -3) return;
    error.value = event?.errorDescription || '目标页面加载失败';
  });
  syncNavState();
}

function syncNavState() {
  const wv = webviewEl.value;
  if (!wv) return;
  try {
    const url = wv.getURL();
    if (url) {
      currentUrl.value = url;
      isHttps.value = url.startsWith('https:');
    }
    canBack.value = wv.canGoBack();
    canForward.value = wv.canGoForward();
  } catch (_) {}
}

function goBack() {
  try { webviewEl.value?.goBack(); } catch (_) {}
}

function goForward() {
  try { webviewEl.value?.goForward(); } catch (_) {}
}

function reload() {
  try { webviewEl.value?.reload(); } catch (_) {}
}

async function stopBridgeOnly() {
  try {
    await window.pluginApi?.stopCurrent();
  } catch (_) {}
}

async function stopPlugin() {
  stopping.value = true;
  await stopBridgeOnly();
  stopped.value = true;
  try {
    webviewEl.value?.remove();
  } catch (_) {}
  router.push('/plugins');
}
</script>

<style scoped>
.plugin-run {
  position: fixed;
  inset: 0;
  z-index: 2100;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
  flex: 0 0 auto;
}

.address {
  flex: 1 1 auto;
}

.lock-ok {
  color: var(--el-color-success);
}

.lock-warn {
  color: var(--el-color-warning);
}

.run-alert {
  border-radius: 0;
}

.webview {
  flex: 1 1 auto;
  width: 100%;
  border: 0;
  display: inline-flex;
}

.empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
}

@media (max-width: 768px) {
  .toolbar {
    gap: 4px;
    padding: 4px 6px;
  }
}
</style>
