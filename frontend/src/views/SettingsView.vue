<template>
  <div class="settings-page">
    <section class="settings-hero">
      <p class="section-label">应用偏好</p>
      <h1 class="settings-title">设置</h1>
      <p class="settings-desc">调整窗口和托盘相关行为。未选择过时，第一次点关闭会询问。</p>
    </section>

    <el-card shadow="never" class="settings-card">
      <template #header>
        <div class="settings-header">窗口</div>
      </template>
      <div class="settings-row">
        <div class="settings-copy">
          <div class="settings-name">关闭时最小化到托盘</div>
          <p class="settings-hint">
            打开后，点右上角关闭只会隐藏窗口，设备连接和后台服务继续运行。
            关掉则点关闭会退出程序。第一次关闭且还没选过时会弹窗询问。
          </p>
        </div>
        <el-switch
          :model-value="closeToTray === true"
          :loading="loading"
          :disabled="!hasWindowApi"
          @change="onCloseToTrayChange"
        />
      </div>
      <p v-if="!hasWindowApi" class="settings-note">当前不是桌面客户端，此项不可用。</p>
      <p v-else-if="message" class="settings-note">{{ message }}</p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

const closeToTray = ref<boolean | null>(null)
const loading = ref(false)
const message = ref('')
const hasWindowApi = computed(() => !!window.windowApi)

async function loadSettings() {
  if (!window.windowApi) return
  loading.value = true
  try {
    const settings = await window.windowApi.getSettings()
    closeToTray.value = settings.closeToTray
  } catch (error: any) {
    message.value = error?.message || '设置读取失败'
  } finally {
    loading.value = false
  }
}

async function onCloseToTrayChange(value: string | number | boolean) {
  if (!window.windowApi) return
  loading.value = true
  message.value = ''
  try {
    const settings = await window.windowApi.setSettings({ closeToTray: !!value })
    closeToTray.value = settings.closeToTray
    message.value = settings.closeToTray ? '已开启：关闭窗口将最小化到托盘' : '已关闭：关闭窗口将退出程序'
  } catch (error: any) {
    message.value = error?.message || '设置保存失败'
    ElMessage.error(message.value)
  } finally {
    loading.value = false
  }
}

onMounted(loadSettings)
</script>

<style scoped>
.settings-page {
  padding: 0 16px;
  width: 100%;
  max-width: 960px;
  margin: 0 auto;
  box-sizing: border-box;
}

.settings-hero {
  padding: 40px 0 24px;
}

.settings-title {
  font-size: 32px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--text-primary);
  margin: 12px 0 0 0;
}

.settings-desc {
  margin: 12px 0 0 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-muted);
}

.settings-card {
  margin-bottom: 24px;
}

.settings-header {
  font-weight: 600;
}

.settings-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}

.settings-copy {
  flex: 1;
  min-width: 0;
}

.settings-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.settings-hint,
.settings-note {
  margin: 8px 0 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-muted);
}
</style>
