<template>
  <div class="firmware-update-page">
    <el-card shadow="never" class="shell-card">
      <div class="shell-header">
        <div class="shell-title">
          <h2>固件更新</h2>
          <span>在线升级（OTA）或 USB 插线烧录</span>
        </div>
        <el-button :icon="Back" @click="$router.push('/devices')">返回设备管理</el-button>
      </div>
      <el-tabs :model-value="activeTab" class="shell-tabs" @tab-change="handleTabChange">
        <el-tab-pane label="在线升级（OTA）" name="ota" />
        <el-tab-pane label="插线烧录" name="wired" />
      </el-tabs>
    </el-card>

    <router-view />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Back } from '@element-plus/icons-vue';

const route = useRoute();
const router = useRouter();

const activeTab = computed(() => (route.path.includes('/wired') ? 'wired' : 'ota'));

function handleTabChange(name: string | number) {
  const tab = String(name);
  if (tab !== activeTab.value) {
    router.push(`/devices/firmware/${tab}`);
  }
}
</script>

<style scoped>
.firmware-update-page {
  padding: 20px;
  width: 100%;
  box-sizing: border-box;
}

.shell-card {
  margin-bottom: 12px;
  max-width: 1200px;
  margin-left: auto;
  margin-right: auto;
}

.shell-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.shell-title h2 {
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
  color: var(--text-primary);
}

.shell-title span {
  display: block;
  margin-top: 4px;
  color: var(--text-secondary);
  font-size: 13px;
}

.shell-tabs {
  margin-top: 8px;
}

.shell-tabs :deep(.el-tabs__header) {
  margin-bottom: 0;
}

@media (max-width: 768px) {
  .firmware-update-page {
    padding: 12px;
  }
}
</style>
