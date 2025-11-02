<template>
  <div class="page">
    <h1>游戏列表</h1>

    <section class="card">
      <div class="row space-between">
        <div class="row" style="flex-wrap: wrap; gap: 8px 12px;">
          <input
            v-model="search"
            type="text"
            class="input"
            placeholder="搜索玩法名称..."
            aria-label="搜索玩法"
          />
          <button @click="refresh" :disabled="busy.refresh">
            {{ busy.refresh ? '刷新中...' : '刷新' }}
          </button>
          <button @click="triggerUpload" :disabled="busy.upload">{{ busy.upload ? '上传中...' : '加载外部玩法' }}</button>
          <button @click="stopCurrent" :disabled="busy.stop">{{ busy.stop ? '停止中...' : '停止当前运行的游戏' }}</button>
          <input ref="fileInput" type="file" accept=".js" style="display:none" @change="onFileSelected" />
        </div>
        <div class="status">
          <span v-if="updated.reload" class="ok">已刷新</span>
          <span v-if="updated.upload" class="ok">已加载</span>
          <span v-if="error" class="error">{{ error }}</span>
        </div>
      </div>
    </section>

    <section class="card">
      <div v-if="filteredGames.length === 0" class="empty">
        <p class="muted">暂无数据或无匹配结果</p>
      </div>
      <div class="grid">
        <div v-for="g in filteredGames" :key="g.id" class="game-card">
          <div class="game-main">
            <h3 class="title">{{ g.name }}</h3>
            <p v-if="g.description" class="desc">{{ g.description }}</p>
            <div class="meta">
              <span>状态：<strong>{{ statusText(g.status) }}</strong></span>
              <span v-if="g.arguments">参数：<code>{{ g.arguments }}</code></span>
              <span>最后游玩：{{ formatLastPlayed(g.lastPlayed) }}</span>
            </div>
            <div v-if="g.requiredDevices && g.requiredDevices.length" class="devices">
              <span class="muted">设备需求：</span>
              <span v-for="d in g.requiredDevices" :key="d.logicalId || d.name" class="device-tag">
                {{ d.required ? '●' : '○' }} {{ d.name || d.logicalId || '设备' }}
              </span>
            </div>
          </div>
          <div class="game-actions">
            <button @click="gotoConfig(g)" class="primary">启动</button>
            <button @click="deleteGame(g)" class="danger">删除</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';

interface RequiredDevice { logicalId?: string; required?: boolean; name?: string }
interface GameItem {
  id: string;
  name: string;
  description?: string;
  status?: 'stopped' | 'running' | 'finished' | 'idle' | 'error';
  arguments?: string;
  configPath?: string;
  requiredDevices?: RequiredDevice[];
  version?: string;
  author?: string;
  createdAt?: number;
  lastPlayed?: number | null;
}

const games = ref<GameItem[]>([]);
const search = ref('');
const error = ref('');
const busy = ref({ refresh: false, upload: false, stop: false });
const updated = ref({ reload: false, upload: false });
const fileInput = ref<HTMLInputElement | null>(null);

const filteredGames = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return games.value;
  return games.value.filter(g => (g.name || '').toLowerCase().includes(q));
});

onMounted(async () => {
  await loadGames();
});

async function loadGames() {
  error.value = '';
  try {
    const res = await fetch('/api/games');
    if (!res.ok) throw new Error('游戏列表获取失败');
    const arr = await res.json();
    games.value = Array.isArray(arr) ? arr : [];
  } catch (e: any) {
    error.value = e?.message || '游戏列表获取失败';
  }
}

async function refresh() {
  busy.value.refresh = true;
  updated.value.reload = false;
  error.value = '';
  try {
    const res = await fetch('/api/games/reload', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data?.message || '刷新失败');
    updated.value.reload = true;
    await loadGames();
  } catch (e: any) {
    error.value = e?.message || '刷新失败';
  } finally {
    busy.value.refresh = false;
    setTimeout(() => (updated.value.reload = false), 1500);
  }
}

function triggerUpload() {
  fileInput.value?.click();
}

async function onFileSelected(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0] || null;
  input.value = '';
  if (!file) return; // 用户取消选择
  busy.value.upload = true;
  updated.value.upload = false;
  error.value = '';
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/games/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data?.message || '上传失败');
    updated.value.upload = true;
    await loadGames();
  } catch (e: any) {
    error.value = e?.message || '上传失败';
  } finally {
    busy.value.upload = false;
    setTimeout(() => (updated.value.upload = false), 1500);
  }
}

const router = useRouter();
function gotoConfig(g: GameItem) {
  router.push({ name: 'game_config', params: { id: g.id } });
}

async function stopCurrent() {
  busy.value.stop = true;
  error.value = '';
  try {
    const res = await fetch('/api/games/stop-current', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 501) {
      alert((data?.error?.message) || '停止接口待实现');
      return;
    }
    if (!res.ok || data.error) throw new Error(data?.message || '停止失败');
    await loadGames();
  } catch (e: any) {
    error.value = e?.message || '停止失败';
  } finally {
    busy.value.stop = false;
  }
}

async function deleteGame(g: GameItem) {
  const sure = confirm('确定删除该玩法？仅移除列表，不删除文件。');
  if (!sure) return;
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(g.id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data?.message || '删除失败');
    games.value = games.value.filter(x => x.id !== g.id);
  } catch (e: any) {
    alert(e?.message || '删除失败');
  }
}

function formatLastPlayed(ts: number | null | undefined) {
  if (!ts) return '从未游玩';
  try {
    return new Date(ts).toLocaleString('zh-CN');
  } catch {
    return String(ts);
  }
}

function statusText(s: GameItem['status']) {
  switch (s) {
    case 'running': return '运行中';
    case 'stopped': return '已停止';
    case 'finished': return '已完成';
    case 'idle': return '空闲';
    case 'error': return '错误';
    default: return '未知';
  }
}
</script>

<style scoped>
.page { max-width: 960px; margin: 40px auto; padding: 0 24px; text-align: left; }
.row { display: flex; gap: 12px; align-items: center; }
.space-between { justify-content: space-between; }
.card { margin-top: 24px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fafafa; }
.status { display: flex; gap: 12px; align-items: center; }
.error { color: #e11d48; }
.ok { color: #16a34a; }
.muted { color: #6b7280; }
.input { padding: 6px 10px; border: 1px solid #e5e7eb; border-radius: 6px; min-width: 240px; }
button { padding: 6px 12px; border: 1px solid #0ea5e9; background: #0ea5e9; color: white; border-radius: 6px; cursor: pointer; }
button.primary { border-color: #0ea5e9; background: #0ea5e9; }
button.danger { border-color: #e11d48; background: #e11d48; }
button:disabled { opacity: 0.6; cursor: not-allowed; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.game-card { display: flex; justify-content: space-between; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; background: #fff; }
.game-main { max-width: calc(100% - 160px); }
.title { margin: 0 0 6px; font-size: 18px; }
.desc { margin: 0 0 8px; color: #374151; }
.meta { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #6b7280; }
.devices { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; }
.device-tag { padding: 2px 8px; background: #f3f4f6; border-radius: 12px; border: 1px solid #e5e7eb; }
.game-actions { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.empty { text-align: center; padding: 24px 0; }

/* 移动端适配 */
@media (max-width: 768px) {
  .page { 
    margin: 20px auto; 
    padding: 0 16px; 
  }
  
  .card { 
    margin-top: 16px; 
    padding: 12px; 
  }
  
  .row { 
    flex-direction: column; 
    align-items: stretch; 
    gap: 8px; 
  }
  
  .space-between { 
    flex-direction: column; 
    align-items: stretch; 
  }
  
  .input { 
    min-width: auto; 
    width: 100%; 
  }
  
  button { 
    width: 100%; 
    padding: 10px 12px; 
  }
  
  .grid { 
    grid-template-columns: 1fr; 
    gap: 12px; 
  }
  
  .game-card { 
    flex-direction: column; 
    gap: 12px; 
  }
  
  .game-main { 
    max-width: 100%; 
  }
  
  .game-actions { 
    flex-direction: row; 
    justify-content: space-between; 
    align-items: center; 
  }
  
  .game-actions button { 
    width: auto; 
    flex: 1; 
    margin: 0 4px; 
  }
  
  .title { 
    font-size: 16px; 
  }
  
  .status { 
    flex-direction: column; 
    align-items: stretch; 
    gap: 8px; 
  }
}

@media (max-width: 480px) {
  .page { 
    margin: 16px auto; 
    padding: 0 12px; 
  }
  
  .card { 
    margin-top: 12px; 
    padding: 8px; 
  }
  
  .game-card { 
    padding: 8px; 
  }
  
  .title { 
    font-size: 15px; 
  }
  
  .desc { 
    font-size: 13px; 
  }
  
  .meta { 
    font-size: 12px; 
  }
  
  .devices { 
    font-size: 11px; 
  }
  
  .device-tag { 
    padding: 1px 6px; 
  }
  
  button { 
    padding: 8px 10px; 
    font-size: 13px; 
  }
}
</style>