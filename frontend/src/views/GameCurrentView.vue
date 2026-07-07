<template>
  <PlayCarrierShell mode="iframe" :stoppable="!!iframeSrc" :stopping="stopping" @stop="stopGame">
    <iframe
      v-if="iframeSrc"
      :src="iframeSrc"
      class="game-frame"
      allow="fullscreen; autoplay; gyroscope; accelerometer"
      allowfullscreen
    ></iframe>

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
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { track } from '../analytics';
import { clearActivePlay } from '../composables/useActivePlay';
import PlayCarrierShell from '../components/PlayCarrierShell.vue';

const route = useRoute();
const router = useRouter();
const iframeSrc = ref('');
const stopping = ref(false);
let stopped = false;

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

async function stopCurrentBridge() {
  if (stopped) return;
  stopped = true;
  try {
    await fetch('/api/games/stop-current', { method: 'POST' });
  } catch (_) {}
}

async function stopGame() {
  stopping.value = true;
  track('game_stop', { game_id: String(route.query.id || 'unknown') });
  await stopCurrentBridge();
  clearActivePlay();
  iframeSrc.value = '';
  router.push('/plays');
}

onMounted(() => {
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

.game-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--el-bg-color);
}
</style>
