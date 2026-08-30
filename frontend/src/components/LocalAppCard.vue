<template>
  <article class="play-card carrier-local-app">
    <div class="play-main">
      <div class="play-content">
        <div class="title-row">
          <h2>{{ app.title || app.id }}</h2>
          <el-tag size="small" type="warning">{{ t('plays.localApp') }}</el-tag>
        </div>
        <p class="desc">{{ app.description || '' }}</p>
        <div class="meta">
          <el-tag size="small" type="info">{{ versionLabel }}</el-tag>
          <el-tag v-if="app.installed && !app.needsUpdate" size="small" type="success">{{ t('plays.installed') }}</el-tag>
          <el-tag v-else-if="app.needsUpdate && app.installed" size="small" type="warning">{{ t('plays.hasUpdate') }}</el-tag>
          <el-tag v-else size="small">{{ t('plays.notInstalled') }}</el-tag>
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
      <el-button v-if="!app.installed" type="primary" :loading="busy" @click="syncOnly">{{ t('common.install') }}</el-button>
      <el-button v-if="app.needsUpdate && app.installed" :loading="busy" @click="syncOnly">{{ t('common.update') }}</el-button>
      <el-button v-if="app.installed" type="primary" :loading="busy" @click="startOnly">{{ t('common.start') }}</el-button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessageBox } from 'element-plus';
import { setActivePlay } from '../composables/useActivePlay';
import { currentLocale } from '../i18n';
import { useAuth } from '../composables/useAuth';

const { t } = useI18n();
const props = defineProps<{ app: Record<string, any> }>();
const emit = defineEmits<{ (e: 'refresh'): void }>();
const { authState, checkSession } = useAuth();
const busy = ref(false);
const error = ref('');
const progress = ref({
  doneBytes: 0, totalBytes: 0, phase: 'idle',
  filesDone: 0, filesTotal: 0, extractDone: 0, extractTotal: 0, detail: '',
});
const processInfo = ref({ phase: 'idle', detail: '', elapsedMs: 0, running: false });
let pollTimer: number | null = null;
let launching = false;

const versionLabel = computed(() => {
  const latest = props.app.version || '-';
  const local = props.app.installedVersion;
  if (props.app.installed && local && local !== latest) return t('plays.localLatest', { local, latest });
  return t('plays.version', { version: latest });
});

const percent = computed(() => {
  const phase = progress.value.phase;
  const total = Number(progress.value.totalBytes || 0);
  const done = Number(progress.value.doneBytes || 0);
  if (phase === 'downloading') {
    if (total <= 0) return 8;
    return Math.min(80, Math.round((80 * done) / total));
  }
  if (phase === 'verifying') return 84;
  if (phase === 'installing') {
    const filesTotal = Number(progress.value.filesTotal || 1);
    const filesDone = Number(progress.value.filesDone || 0);
    const extractTotal = Number(progress.value.extractTotal || 0);
    const part = extractTotal > 0 ? Number(progress.value.extractDone || 0) / extractTotal : 0;
    return Math.min(99, 85 + Math.round((15 * (filesDone + part)) / filesTotal));
  }
  if (phase === 'ready') return 100;
  if (processInfo.value.phase === 'waiting' || processInfo.value.phase === 'starting') {
    return Math.min(90, 20 + Math.floor((processInfo.value.elapsedMs || 0) / 1000) * 3);
  }
  if (processInfo.value.phase === 'ready') return 100;
  return phase === 'checking' ? 5 : 10;
});

const statusText = computed(() => {
  if (error.value) return error.value;
  if (!busy.value) return '';
  if (progress.value.detail) return String(progress.value.detail);
  if (progress.value.phase === 'downloading') {
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    return t('localApp.downloading', { done: mb(progress.value.doneBytes), total: mb(progress.value.totalBytes) });
  }
  if (progress.value.phase === 'verifying') return t('localApp.verifying');
  if (progress.value.phase === 'installing') {
    const extra = progress.value.extractTotal
      ? t('localApp.files', { done: progress.value.extractDone, total: progress.value.extractTotal })
      : '';
    return t('localApp.extracting', { extra });
  }
  if (progress.value.phase === 'checking') return t('localApp.checking');
  if (processInfo.value.phase === 'starting') return processInfo.value.detail || t('localApp.starting');
  if (processInfo.value.phase === 'waiting') {
    const sec = Math.max(0, Math.floor((processInfo.value.elapsedMs || 0) / 1000));
    return t('localApp.waiting', { sec });
  }
  if (processInfo.value.phase === 'ready') return t('localApp.opening');
  return t('localApp.processing');
});

function stopPoll() {
  if (pollTimer != null) window.clearInterval(pollTimer);
  pollTimer = null;
}

async function readStatus() {
  const res = await fetch(`/api/local-apps/${encodeURIComponent(props.app.id)}/status`);
  const data = await res.json();
  if (data?.progress) progress.value = { ...progress.value, ...data.progress };
  if (data?.process) processInfo.value = data.process;
  return data;
}

async function confirmGuestLaunch() {
  await checkSession();
  if (authState.status === 'authed') return true;
  try {
    await ElMessageBox.confirm(t('localApp.guestConfirm'), t('localApp.guestTitle'), {
      confirmButtonText: t('common.yes'),
      cancelButtonText: t('common.no'),
      type: 'warning',
    });
    return true;
  } catch {
    return false;
  }
}

async function withBusy(work: () => Promise<void>, failText: string) {
  if (launching || busy.value) return;
  launching = true;
  busy.value = true;
  error.value = '';
  try {
    pollTimer = window.setInterval(() => { void readStatus(); }, 800);
    await work();
    emit('refresh');
  } catch (e: any) {
    error.value = e?.message || failText;
  } finally {
    stopPoll();
    busy.value = false;
    launching = false;
  }
}

async function syncOnly() {
  await withBusy(async () => {
    const res = await fetch(`/api/local-apps/${encodeURIComponent(props.app.id)}/sync`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || t('localApp.syncFailed'));
  }, t('localApp.syncFailed'));
}

async function startOnly() {
  if (!(await confirmGuestLaunch())) return;
  await withBusy(async () => {
    const startRes = await fetch(`/api/local-apps/${encodeURIComponent(props.app.id)}/start`, { method: 'POST' });
    const started = await startRes.json();
    if (!startRes.ok) throw new Error(started?.error?.message || t('localApp.startFailed'));
    const url = String(started.url || 'http://127.0.0.1:8020/').replace(/\/api\/info$/, '/');
    const title = props.app.title || props.app.id;
    setActivePlay({
      carrierType: 'local-app', id: props.app.id, title,
      resume: { name: 'plays' }, resumeWindow: true,
    });
    if (window.localAppWindowApi) {
      const opened = await window.localAppWindowApi.open({ url, id: props.app.id, title, locale: currentLocale() });
      if (!opened?.ok) throw new Error(opened?.error || t('localApp.openFailed'));
    } else {
      window.open(url, 'local-app-xiaoya');
    }
  }, t('localApp.startFailed'));
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
.play-actions { display: flex; align-items: flex-start; gap: 8px; }
</style>
