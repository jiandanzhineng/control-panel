<template>
  <div class="game-runtime">
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
      description="未提供游戏配置，请先在游戏列表启动"
      :image-size="120"
    >
      <el-button type="primary" @click="$router.push('/games')">前往游戏列表</el-button>
    </el-empty>

    <button class="stop-fab" @click="stopGame" title="停止游戏">
      <el-icon><Close /></el-icon>
      <span>停止</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Close } from '@element-plus/icons-vue';

const route = useRoute();
const router = useRouter();
const iframeSrc = ref('');

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

function stopGame() {
  // 卸载 iframe → WebSocket 断开 → 后端兜底 close（安全停机）
  iframeSrc.value = '';
  router.push('/games');
}

onMounted(() => {
  iframeSrc.value = buildSrc();
});
</script>

<style scoped>
.game-runtime {
  position: fixed;
  inset: 0;
  background: #000;
  z-index: 2000;
}

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

.stop-fab {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2100;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border: none;
  border-radius: 24px;
  background: rgba(220, 38, 38, 0.92);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
  -webkit-tap-highlight-color: transparent;
}

.stop-fab:hover {
  background: rgba(220, 38, 38, 1);
}

.stop-fab:active {
  transform: scale(0.96);
}
</style>
