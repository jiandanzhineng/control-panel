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
        <h2>即将开始</h2>
        <p class="wait-desc">请按下「{{ triggerLabel }}」的按键，正式开始玩法。</p>
        <p class="wait-hint">进入游戏后由玩法自己控制设备，开始机制不再监听按键。</p>
        <div class="wait-actions">
          <el-button @click="cancelWait">取消</el-button>
          <el-button type="primary" @click="beginGame">强制开始</el-button>
        </div>
      </div>
    </div>

    <el-empty
      v-else
      class="game-empty"
      description="未提供游戏配置，请先在本地游戏启动"
      :image-size="120"
    >
      <el-button type="primary" @click="$router.push('/plays')">前往本地游戏</el-button>
    </el-empty>
  </PlayCarrierShell>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { track } from '../analytics';
import { clearActivePlay } from '../composables/useActivePlay';
import { listenDeviceButtonPress } from '../composables/useButtonStart';
import PlayCarrierShell from '../components/PlayCarrierShell.vue';

const route = useRoute();
const router = useRouter();
const iframeSrc = ref('');
const stopping = ref(false);
const triggerId = String(route.query.startTriggerDeviceId || '');
const waitingForButton = ref(String(route.query.startMode || '') === 'button' && !!triggerId);
const triggerLabel = ref('触发设备');
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

  // 基础游戏 URL：
  // - 外部游戏：后端已返回前缀代理路径 gamePath（/games/proxy/...）
  // - 本地游戏：优先 gamePath，否则按 id 兜底（后端 gamePath 形如 /games/<folder>/index.html）
  let base = gamePath;
  if (!base && id) base = `/games/${encodeURIComponent(id)}/index.html`;
  if (!base && externalUrl) base = externalUrl;
  if (!base) return '';

  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}deviceMap=${encodeURIComponent(deviceMap)}&params=${encodeURIComponent(params)}`;
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
  triggerLabel.value = deviceId;
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
