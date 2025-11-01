<template>
  <div class="page">
    <section class="card">
      <div class="row space-between">
        <div class="row" style="flex-wrap: wrap; gap: 8px 12px;">
          <button @click="reloadHtml" :disabled="loading">{{ loading ? '加载中...' : '刷新页面' }}</button>
          <button @click="stopGame" :disabled="stopping" class="danger">{{ stopping ? '停止中...' : '停止游戏' }}</button>
        </div>
        <div class="status">
          <span v-if="error" class="error">{{ error }}</span>
          <span v-if="stopError" class="error">{{ stopError }}</span>
        </div>
      </div>
    </section>

    <section class="card">
      <div ref="containerRef" class="embedded-html"></div>
      <p v-if="!loading && !error && empty" class="muted">暂无运行中的玩法，请先在“游戏列表”启动。</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';

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
.page { max-width: 960px; margin: 40px auto; padding: 0 24px; text-align: left; }
.card { margin-top: 24px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fafafa; }
.row { display: flex; gap: 12px; align-items: center; }
.space-between { justify-content: space-between; }
.status { display: flex; gap: 12px; align-items: center; }
.error { color: #e11d48; }
.muted { color: #6b7280; }
button { padding: 6px 12px; border: 1px solid #0ea5e9; background: #0ea5e9; color: white; border-radius: 6px; cursor: pointer; }
button.danger { border-color: #e11d48; background: #e11d48; }
button:disabled { opacity: 0.6; cursor: not-allowed; }
.embedded-html { min-height: 240px; border: 1px dashed #e5e7eb; border-radius: 8px; padding: 8px; background: #fff; }
</style>