<template>
  <div class="game-current-page">
    <el-card shadow="never" class="control-card">
      <template #header>
        <div class="card-header">
          <el-icon><VideoPlay /></el-icon>
          <span>游戏控制</span>
        </div>
      </template>
      <div class="control-content">
        <div class="control-buttons">
          <el-button 
            type="primary" 
            :icon="Refresh" 
            :loading="loading"
            @click="reloadHtml"
          >
            {{ loading ? '加载中...' : '刷新页面' }}
          </el-button>
          <el-button 
            type="danger" 
            :icon="Close"
            :loading="stopping"
            @click="stopGame"
          >
            {{ stopping ? '停止中...' : '停止游戏' }}
          </el-button>
        </div>
        <div class="status-info" v-if="error || stopError">
          <el-alert 
            v-if="error" 
            :title="error" 
            type="error" 
            :closable="false"
            show-icon
          />
          <el-alert 
            v-if="stopError" 
            :title="stopError" 
            type="error" 
            :closable="false"
            show-icon
          />
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="game-content-card">
      <template #header>
        <span>游戏界面</span>
      </template>
      <div ref="containerRef" class="embedded-html"></div>
      <el-empty 
        v-if="!loading && !error && empty" 
        description="暂无运行中的玩法，请先在游戏列表启动"
        :image-size="120"
      >
        <el-button type="primary" @click="$router.push('/games')">
          前往游戏列表
        </el-button>
      </el-empty>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { VideoPlay, Refresh, Close } from '@element-plus/icons-vue';

const router = useRouter();
const containerRef = ref<HTMLDivElement | null>(null);
const loading = ref(false);
const error = ref('');
const empty = ref(false);
const stopping = ref(false);
const stopError = ref('');

let cleanupRunner: () => void = () => {};
let appendedStyles: HTMLStyleElement[] = [];
let appendedScripts: HTMLScriptElement[] = [];

onMounted(async () => {
  await loadHtml();
});

onBeforeUnmount(() => {
  cleanup();
});

async function loadHtml() {
  loading.value = true;
  error.value = '';
  empty.value = false;
  try {
    const res = await fetch('/api/games/current/html');
    const text = await res.text();
    if (!res.ok) {
      // 尝试解析后端错误消息
      try {
        const json = JSON.parse(text);
        error.value = json?.message || '页面获取失败';
      } catch {
        error.value = '页面获取失败';
      }
      clearContainer();
      empty.value = true;
      return;
    }
    injectHtml(text);
  } catch (e: any) {
    error.value = e?.message || '页面获取失败';
    clearContainer();
    empty.value = true;
  } finally {
    loading.value = false;
  }
}

function reloadHtml() { loadHtml(); }

async function stopGame() {
  stopping.value = true;
  stopError.value = '';
  try {
    const res = await fetch('/api/games/stop-current', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data?.message || '停止游戏失败');
    }
    // 停止成功，跳转回游戏列表
    router.push({ name: 'gamelist' });
  } catch (e: any) {
    stopError.value = e?.message || '停止游戏失败';
  } finally {
    stopping.value = false;
  }
}

function clearContainer() {
  const container = containerRef.value;
  if (container) container.innerHTML = '';
}

function cleanup() {
  // 关闭可能的 SSE 连接并清理注入的样式与脚本
  try { cleanupRunner(); } catch {}
  cleanupRunner = () => {};
  appendedStyles.forEach(s => { try { s.remove(); } catch {} });
  appendedStyles = [];
  appendedScripts.forEach(s => { try { s.remove(); } catch {} });
  appendedScripts = [];
  clearContainer();
}

function injectHtml(html: string) {
  cleanup();
  const container = containerRef.value;
  if (!container) return;

  // 使用 DOMParser 获取 head/body，分别处理样式与主体内容
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // 注入样式（可清理）
  appendedStyles = [];
  Array.from(doc.head.querySelectorAll('style')).forEach(styleEl => {
    const s = document.createElement('style');
    s.textContent = styleEl.textContent || '';
    document.head.appendChild(s);
    appendedStyles.push(s);
  });

  // 渲染 body 内容到容器
  container.innerHTML = '';
  Array.from(doc.body.children).forEach(node => {
    container.appendChild(node.cloneNode(true));
  });

  // 收集并执行脚本（来自 head 与 body）
  const scripts: HTMLScriptElement[] = [
    ...Array.from(doc.head.querySelectorAll('script')),
    ...Array.from(doc.body.querySelectorAll('script')),
  ];
  executeScripts(scripts);
}

function executeScripts(scripts: HTMLScriptElement[]) {
  appendedScripts = [];
  const originals: { EventSource: typeof EventSource } = { EventSource: window.EventSource };
  const esList: EventSource[] = [];

  // 包装 EventSource，用于路由离开时关闭连接，避免泄漏
  try {
    (window as any).EventSource = function(url: string | URL, config?: EventSourceInit) {
      const es = new originals.EventSource(url as any, config as any);
      try { esList.push(es); } catch {}
      return es;
    } as any;
  } catch {}

  for (const s of scripts) {
    const newScript = document.createElement('script');
    const src = s.getAttribute('src');
    if (src) {
      newScript.src = src;
      newScript.async = false;
    } else {
      newScript.textContent = s.textContent || '';
    }
    document.body.appendChild(newScript);
    appendedScripts.push(newScript);
  }

  // 还原原始 EventSource，并准备清理函数
  try { (window as any).EventSource = originals.EventSource; } catch {}
  cleanupRunner = function() {
    esList.forEach(es => { try { es.close(); } catch {} });
  };
}
</script>

<style scoped>
.game-current-page {
  padding: 16px;
}

.control-card {
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.control-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.control-buttons {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.status-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.game-content-card {
  min-height: 500px;
}

.embedded-html {
  min-height: 400px;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--el-border-radius-base);
  overflow: hidden;
  background: #f8f9fa;
}

@media (max-width: 768px) {
  .game-current-page {
    padding: 12px;
  }
  
  .control-buttons {
    flex-direction: column;
  }
  
  .control-buttons .el-button {
    width: 100%;
  }
}
</style>