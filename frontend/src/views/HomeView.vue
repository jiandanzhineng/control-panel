<template>
  <div class="home-page">
    <div class="welcome-section">
      <h2 class="welcome-title">控制面板</h2>
      <p class="welcome-desc">硅基之下 · 设备管理与控制中心</p>
    </div>

    <el-row :gutter="16" class="feature-cards">
      <el-col :xs="24" :sm="8">
        <el-card shadow="hover" class="feature-card" @click="$router.push('/devices')">
          <div class="feature-content">
            <el-icon class="feature-icon" color="#409eff"><Monitor /></el-icon>
            <h3>设备管理</h3>
            <p>管理和监控所有连接的设备</p>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="8">
        <el-card shadow="hover" class="feature-card" @click="$router.push('/plays')">
          <div class="feature-content">
            <el-icon class="feature-icon" color="#67c23a"><VideoPlay /></el-icon>
            <h3>玩法</h3>
            <p>启动和管理游戏与插件玩法</p>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="8">
        <el-card shadow="hover" class="feature-card" @click="$router.push('/network')">
          <div class="feature-content">
            <el-icon class="feature-icon" color="#e6a23c"><Connection /></el-icon>
            <h3>网络设置</h3>
            <p>配置网络连接和通信设置</p>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="info-card">
      <template #header>
        <div class="info-header">
          <el-icon><InfoFilled /></el-icon>
          <span>系统信息</span>
        </div>
      </template>
      <el-descriptions :column="2" border class="info-list" :size="'default'">
        <el-descriptions-item label="在线设备">
          <el-tag type="info" effect="plain">{{ onlineCount }} 台</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="当前版本">
          <el-tag type="success" effect="plain">v{{ frontendVersion }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="更新渠道">
          <div class="update-channel">
            <el-tag :type="updateChannelTagType" effect="plain">{{ updateChannelText }}</el-tag>
            <el-switch
              v-model="receiveTestUpdates"
              :loading="updateSettingsLoading"
              :disabled="!hasUpdateApi"
              active-text="测试版"
              inactive-text="正式版"
              inline-prompt
              @change="saveUpdateSettings"
            />
          </div>
        </el-descriptions-item>
        <el-descriptions-item label="应用更新">
          <div class="update-actions">
            <el-button
              size="small"
              :loading="checkingUpdates"
              :disabled="!hasUpdateApi"
              @click="checkForUpdates"
            >
              检查更新
            </el-button>
            <span v-if="updateMessage" :class="updateMessageClass">{{ updateMessage }}</span>
          </div>
        </el-descriptions-item>
        <el-descriptions-item label="淘宝店">
          <a href="http://guijizhixia.taobao.com/" target="_blank" class="link-text">guijizhixia.taobao.com</a>
        </el-descriptions-item>
        <el-descriptions-item label="文档地址">
          <a href="https://docs.undersilicon.cn" target="_blank" class="link-text">docs.undersilicon.cn</a>
        </el-descriptions-item>
        <el-descriptions-item label="交流QQ群" :span="2">
          <span class="info-text">970326066</span>
          <el-tag size="small" type="warning" effect="plain" style="margin-left: 8px">验证：硅基之下</el-tag>
        </el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Monitor, VideoPlay, Connection, InfoFilled } from '@element-plus/icons-vue'
import packageInfo from '../../package.json'

const frontendVersion = packageInfo.version
const onlineCount = ref(0)
const receiveTestUpdates = ref(false)
const updateChannel = ref<UpdateChannel>('stable')
const updateSettingsLoading = ref(false)
const checkingUpdates = ref(false)
const updateMessage = ref('')
const updateMessageType = ref<'info' | 'success' | 'error'>('info')

const hasUpdateApi = computed(() => !!window.updateApi)
const updateChannelText = computed(() => updateChannel.value === 'test' ? '测试版' : '正式版')
const updateChannelTagType = computed(() => updateChannel.value === 'test' ? 'warning' : 'success')
const updateMessageClass = computed(() => ({
  'update-message': true,
  'update-message-error': updateMessageType.value === 'error',
  'update-message-success': updateMessageType.value === 'success',
}))

function applyUpdateStatus(status: UpdateStatus) {
  receiveTestUpdates.value = !!status.settings.receiveTestUpdates
  updateChannel.value = status.channel
}

async function loadUpdateSettings() {
  if (!window.updateApi) return
  updateSettingsLoading.value = true
  try {
    const status = await window.updateApi.getSettings()
    applyUpdateStatus(status)
  } catch (error: any) {
    updateMessageType.value = 'error'
    updateMessage.value = error?.message || '更新设置读取失败'
  } finally {
    updateSettingsLoading.value = false
  }
}

async function saveUpdateSettings() {
  if (!window.updateApi) return
  updateSettingsLoading.value = true
  updateMessage.value = ''
  try {
    const status = await window.updateApi.setSettings({
      receiveTestUpdates: receiveTestUpdates.value,
    })
    applyUpdateStatus(status)
    updateMessageType.value = 'success'
    updateMessage.value = `已切换到${updateChannelText.value}`
  } catch (error: any) {
    receiveTestUpdates.value = !receiveTestUpdates.value
    updateMessageType.value = 'error'
    updateMessage.value = error?.message || '更新设置保存失败'
    ElMessage.error(updateMessage.value)
  } finally {
    updateSettingsLoading.value = false
  }
}

async function checkForUpdates() {
  if (!window.updateApi) return
  checkingUpdates.value = true
  updateMessage.value = ''
  try {
    const status = await window.updateApi.checkForUpdates()
    applyUpdateStatus(status)
    if (status.error) {
      updateMessageType.value = 'error'
      updateMessage.value = status.error
      return
    }
    if (status.skipped) {
      updateMessageType.value = 'info'
      updateMessage.value = '开发环境不可用'
      return
    }
    updateMessageType.value = 'success'
    updateMessage.value = '已开始检查'
  } catch (error: any) {
    updateMessageType.value = 'error'
    updateMessage.value = error?.message || '检查更新失败'
  } finally {
    checkingUpdates.value = false
  }
}

onMounted(async () => {
  try {
    const res = await fetch('/api/devices')
    if (res.ok) {
      const list = await res.json()
      onlineCount.value = list.filter((d: any) => d.connected).length
    }
  } catch {}

  await loadUpdateSettings()
})
</script>

<style scoped>
.home-page {
  padding: 0 16px;
  width: 100%;
  max-width: 960px;
  margin: 20px auto;
  box-sizing: border-box;
}

.welcome-section {
  text-align: center;
  margin-bottom: 24px;
}

.welcome-title {
  font-size: 24px;
  font-weight: 600;
  color: #303133;
  margin: 0 0 8px 0;
}

.welcome-desc {
  font-size: 14px;
  color: #909399;
  margin: 0;
}

.feature-cards {
  margin-bottom: 20px;
}

.feature-card {
  cursor: pointer;
  transition: all 0.3s ease;
  height: 100%;
}

.feature-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
}

.feature-content {
  text-align: center;
  padding: 24px 10px;
}

.feature-icon {
  font-size: 36px;
  margin-bottom: 14px;
}

.feature-content h3 {
  margin: 0 0 8px 0;
  color: #303133;
  font-size: 16px;
  font-weight: 600;
}

.feature-content p {
  margin: 0;
  color: #909399;
  font-size: 13px;
}

.info-card {
  margin-bottom: 20px;
}

.info-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.link-text {
  color: #409eff;
  text-decoration: none;
}

.link-text:hover {
  text-decoration: underline;
}

.info-text {
  font-weight: 600;
  color: #303133;
}

.update-channel,
.update-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-height: 24px;
}

.update-message {
  font-size: 12px;
  color: #606266;
}

.update-message-success {
  color: #16a34a;
}

.update-message-error {
  color: #e11d48;
}

.update-channel :deep(.el-switch) {
  min-width: 88px;
}

.info-list :deep(.el-descriptions__label) {
  width: 100px;
}

@media (max-width: 768px) {
  .home-page {
    padding: 0 12px;
    margin: 12px auto;
  }

  .welcome-title {
    font-size: 20px;
  }

  .feature-cards .el-col {
    margin-bottom: 12px;
  }

  .feature-content {
    padding: 16px 8px;
  }

  .feature-icon {
    font-size: 28px;
  }

  .info-list :deep(.el-descriptions__label) {
    width: 80px;
  }
}
</style>
