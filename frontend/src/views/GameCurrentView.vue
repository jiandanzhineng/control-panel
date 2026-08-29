<template>
  <PlayCarrierShell mode="iframe" :stoppable="stoppable" :stopping="stopping" @stop="stopGame">
    <iframe
      v-if="iframeSrc"
      :src="iframeSrc"
      class="game-frame"
      allow="fullscreen; autoplay; gyroscope; accelerometer; microphone"
      allowfullscreen
    ></iframe>

    <div v-else-if="waitingForButton" class="wait-overlay">
      <div class="wait-card">
        <h2>{{ t('gameRun.soon') }}</h2>
        <p class="wait-desc">{{ t('gameRun.pressToStart', { label: triggerLabel }) }}</p>
        <p class="wait-hint">{{ t('gameRun.afterStart') }}</p>
        <div class="wait-actions">
          <el-button @click="cancelWait">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" @click="beginGame">{{ t('gameRun.forceStart') }}</el-button>
        </div>
      </div>
    </div>

    <el-empty
      v-else
      class="game-empty"
      :description="t('gameRun.empty')"
      :image-size="120"
    >
      <el-button type="primary" @click="$router.push('/plays')">{{ t('gameRun.goPlays') }}</el-button>
    </el-empty>
  </PlayCarrierShell>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { track } from '../analytics';
import { clearActivePlay } from '../composables/useActivePlay';
import { listenDeviceButtonPress } from '../composables/useButtonStart';
import PlayCarrierShell from '../components/PlayCarrierShell.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const iframeSrc = ref('');
const stopping = ref(false);
const triggerId = String(route.query.startTriggerDeviceId || '');
const waitingForButton = ref(String(route.query.startMode || '') === 'button' && !!triggerId);
const triggerLabel = ref('');
let stopped = false;
let stopWait: null | (() => void) = null;

const stoppable = computed(() => !!iframeSrc.value || waitingForButton.value);

function buildSrc(): string {
  const q = route.query;
  const externalUrl = String(q.externalUrl || '');
  const gamePath = String(q.gamePath || '');
  const deviceMap = String(q.deviceMap || '{}');
  const params = String(q.params || '{}');
  const id = String(q.id || '');
  const locale = String(q.locale || 'zh');
  const localeTag = String(q.localeTag || (locale === 'en' ? 'en-US' : 'zh-CN'));

  // 基础游戏 URL：
  // - 外部游戏：后端已返回前缀代理路径 gamePath（/games/proxy/...）
  // - 本地游戏：优先 gamePath，否则按 id 兜底（后端 gamePath 形如 /games/<folder>/index.html）
  let base = gamePath;
  if (!base && id) base = `/games/${encodeURIComponent(id)}/index.html`;
  if (!base && externalUrl) base = externalUrl;
  if (!base) return '';

  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}deviceMap=${encodeURIComponent(deviceMap)}&params=${encodeURIComponent(params)}&locale=${encodeURIComponent(locale)}&localeTag=${encodeURIComponent(localeTag)}`;
}

function beginGame() {
  if (stopped || iframeSrc.value) return;
  stopWaiting();
  waitingForButton.value = false;
  iframeSrc.value = buildSrc();
}

function stopWaiting() {
  if (stopWait) {
    stopWait();
    stopWait = null;
  }
}

async function stopCurrentBridge() {
  if (stopped) return;
  stopped = true;
  stopWaiting();
  try {
    const localApp = String(route.query.localApp || '');
    if (localApp) {
      await fetch(`/api/local-apps/${encodeURIComponent(localApp)}/stop`, { method: 'POST' });
    }
    await fetch('/api/games/stop-current', { method: 'POST' });
  } catch (_) {}
}

async function stopGame() {
  stopping.value = true;
  track('game_stop', { game_id: String(route.query.id || 'unknown') });
  await stopCurrentBridge();
  clearActivePlay();
  iframeSrc.value = '';
  waitingForButton.value = false;
  router.push('/plays');
}

function cancelWait() {
  void stopGame();
}

async function startWaiting(deviceId: string) {
  waitingForButton.value = true;
  triggerLabel.value = t('gameRun.triggerFallback');
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}`);
    const data = await res.json().catch(() => ({}));
    if (res.ok && data) {
      const shortId = String(data.id || deviceId).slice(-4);
      triggerLabel.value = data.nickname ? `${data.nickname}-${shortId}` : (data.name || deviceId);
    }
  } catch (_) {}
  if (stopped || iframeSrc.value || !waitingForButton.value) return;
  stopWait = listenDeviceButtonPress(deviceId, () => {
    beginGame();
  });
}

onMounted(() => {
  if (waitingForButton.value && triggerId) {
    void startWaiting(triggerId);
    return;
  }
  iframeSrc.value = buildSrc();
});

onBeforeUnmount(() => {
  stopCurrentBridge();
});
</script>

<style scoped>
.game-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}

.game-empty,
.wait-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--el-bg-color);
}

.wait-card {
  max-width: 420px;
  padding: 32px 28px;
  text-align: center;
}

.wait-card h2 {
  margin: 0 0 12px;
  font-size: 24px;
}

.wait-desc {
  margin: 0 0 8px;
  color: var(--el-text-color-primary);
  line-height: 1.6;
}

.wait-hint {
  margin: 0 0 24px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}

.wait-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
}
</style>
