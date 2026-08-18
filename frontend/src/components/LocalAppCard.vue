<template>
  <article class="play-card carrier-local-app">
    <div class="play-main">
      <div class="play-content">
        <div class="title-row">
          <h2>{{ app.title || app.id }}</h2>
          <el-tag size="small" type="warning">本机应用</el-tag>
        </div>
        <p class="desc">{{ app.description || '' }}</p>
        <div class="meta">
          <el-tag size="small" type="info">版本：{{ app.version || '-' }}</el-tag>
          <el-tag v-if="app.installed && !app.needsUpdate" size="small" type="success">已安装</el-tag>
          <el-tag v-else-if="app.needsUpdate && app.installed" size="small" type="warning">有更新</el-tag>
          <el-tag v-else size="small">未安装</el-tag>
        </div>
        <el-progress
          v-if="busy"
          :percentage="percent"
          :stroke-width="10"
          :status="error ? 'exception' : undefined"
        />
        <p v-if="statusText" class="desc">{{ statusText }}</p>
      </div>
    </div>
    <div class="play-actions">
      <el-button type="primary" :loading="busy" @click="launch">{{ actionLabel }}</el-button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { setActivePlay } from '../composables/useActivePlay';

const props = defineProps<{ app: Record<string, any> }>();
const emit = defineEmits<{ (e: 'refresh'): void }>();
const busy = ref(false);
const error = ref('');
const progress = ref({ doneBytes: 0, totalBytes: 0, phase: 'idle' });
let pollTimer: number | null = null;

const actionLabel = computed(() => {
  if (busy.value) return '处理中...';
  if (!props.app.installed) return '安装并启动';
  if (props.app.needsUpdate) return '更新并启动';
  return '启动';
});

const percent = computed(() => {
  const total = Number(progress.value.totalBytes || 0);
  const done = Number(progress.value.doneBytes || 0);
  if (total <= 0) return progress.value.phase === 'ready' ? 100 : 10;
  return Math.min(100, Math.round((done / total) * 100));
});

const statusText = computed(() => {
  if (error.value) return error.value;
  if (!busy.value) return '';
  if (progress.value.phase === 'downloading') {
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `下载 ${mb(progress.value.doneBytes)} / ${mb(progress.value.totalBytes)}`;
  }
  if (progress.value.phase === 'installing') return '正在安装...';
  if (progress.value.phase === 'checking') return '检查更新...';
  return '启动中...';
});

function stopPoll() {
  if (pollTimer != null) window.clearInterval(pollTimer);
  pollTimer = null;
}

async function readStatus() {
  const res = await fetch(`/api/local-apps/${encodeURIComponent(props.app.id)}/status`);
  const data = await res.json();
  if (data?.progress) progress.value = data.progress;
  return data;
}

async function launch() {
  busy.value = true;
  error.value = '';
  try {
    pollTimer = window.setInterval(() => { void readStatus(); }, 800);
    const syncRes = await fetch(`/api/local-apps/${encodeURIComponent(props.app.id)}/sync`, { method: 'POST' });
    const synced = await syncRes.json();
    if (!syncRes.ok) throw new Error(synced?.error?.message || '安装失败');
    const startRes = await fetch(`/api/local-apps/${encodeURIComponent(props.app.id)}/start`, { method: 'POST' });
    const started = await startRes.json();
    if (!startRes.ok) throw new Error(started?.error?.message || '启动失败');
    const url = String(started.url || 'http://127.0.0.1:8020/').replace(/\/api\/info$/, '/');
    const title = props.app.title || props.app.id;
    setActivePlay({
      carrierType: 'local-app',
      id: props.app.id,
      title,
      resume: { name: 'plays' },
      resumeWindow: true,
    });
    emit('refresh');
    if (window.localAppWindowApi) {
      const opened = await window.localAppWindowApi.open({ url, id: props.app.id, title });
      if (!opened?.ok) throw new Error(opened?.error || '打开窗口失败');
    } else {
      window.open(url, 'local-app-xiaoya');
    }
  } catch (e: any) {
    error.value = e?.message || '启动失败';
  } finally {
    stopPoll();
    busy.value = false;
  }
}

onBeforeUnmount(stopPoll);
</script>

<style scoped>
.play-card {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-bg-color);
}
.play-content { min-width: 0; flex: 1; }
.title-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.title-row h2 { margin: 0; font-size: 18px; }
.desc { margin: 0 0 12px; line-height: 1.5; color: var(--el-text-color-secondary); }
.meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.play-actions { display: flex; align-items: flex-start; }
</style>
