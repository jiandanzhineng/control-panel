<template>
  <div class="page">
    <div class="header-row">
      <div>
        <h1>插件</h1>
        <p class="muted">加载真实第三方网站，并在网页行为命中时接入设备。</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="loadPlugins">刷新</el-button>
    </div>

    <el-alert
      v-if="error"
      class="alert"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    />

    <el-empty v-if="!loading && plugins.length === 0" description="暂无插件" />

    <div class="plugin-grid">
      <article v-for="plugin in plugins" :key="plugin.id" class="plugin-card">
        <div class="plugin-main">
          <div class="plugin-icon">
            <el-icon><Operation /></el-icon>
          </div>
          <div class="plugin-content">
            <h2>{{ plugin.title || plugin.name || plugin.id }}</h2>
            <p v-if="plugin.description" class="desc">{{ plugin.description }}</p>
            <div class="meta">
              <el-tag size="small" type="info">{{ hostOf(plugin.homeUrl) || '未配置目标站点' }}</el-tag>
              <el-tag size="small">v{{ plugin.version || '1.0.0' }}</el-tag>
              <el-tag v-if="plugin.source" size="small" type="success">{{ plugin.source === 'builtin' ? '内置' : '用户' }}</el-tag>
            </div>
            <div v-if="plugin.devices?.length" class="devices">
              <span v-for="device in plugin.devices" :key="device.id" class="device-tag">
                {{ device.required ? '必需' : '可选' }} {{ device.id }}
              </span>
            </div>
          </div>
        </div>
        <el-button type="primary" :icon="VideoPlay" @click="goConfig(plugin)">配置启动</el-button>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { Operation, Refresh, VideoPlay } from '@element-plus/icons-vue';

interface PluginDevice { id: string; capabilities?: string[]; required?: boolean }
interface PluginItem {
  id: string;
  title?: string;
  name?: string;
  description?: string;
  version?: string;
  homeUrl?: string;
  source?: string;
  devices?: PluginDevice[];
}

const router = useRouter();
const plugins = ref<PluginItem[]>([]);
const loading = ref(false);
const error = ref('');

onMounted(loadPlugins);

async function loadPlugins() {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/plugins');
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || '插件列表获取失败');
    plugins.value = Array.isArray(data) ? data : [];
  } catch (e: any) {
    error.value = e?.message || '插件列表获取失败';
  } finally {
    loading.value = false;
  }
}

function goConfig(plugin: PluginItem) {
  router.push({ name: 'plugin_config', params: { id: plugin.id } });
}

function hostOf(url?: string) {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
}
</script>

<style scoped>
.page {
  max-width: 1120px;
  margin: 0 auto;
  padding: 16px;
}

.header-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}

h1 {
  margin: 0 0 6px;
  font-size: 24px;
}

.muted,
.desc {
  color: var(--el-text-color-secondary);
}

.alert {
  margin-bottom: 16px;
}

.plugin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}

.plugin-card {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-bg-color);
}

.plugin-main {
  display: flex;
  min-width: 0;
  gap: 12px;
}

.plugin-icon {
  display: grid;
  place-items: center;
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: #eef5ff;
  color: var(--el-color-primary);
}

.plugin-content {
  min-width: 0;
}

.plugin-content h2 {
  margin: 0 0 8px;
  font-size: 18px;
}

.desc {
  margin: 0 0 12px;
  line-height: 1.5;
}

.meta,
.devices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.devices {
  margin-top: 10px;
}

.device-tag {
  padding: 2px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 999px;
  color: var(--el-text-color-regular);
  font-size: 12px;
  background: var(--el-fill-color-light);
}

@media (max-width: 768px) {
  .header-row,
  .plugin-card {
    flex-direction: column;
  }

  .plugin-grid {
    grid-template-columns: 1fr;
  }
}
</style>
