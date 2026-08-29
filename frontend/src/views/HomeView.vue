<template>
  <div class="home-page">
    <!-- Hero：大标题 + 青色标签 + 蓝色径向辉光（参考 shop.undersilicon.cn 首屏） -->
    <section class="hero">
      <p class="section-label">{{ t('home.label') }}</p>
      <h1 class="hero-title">{{ t('home.title') }}</h1>
      <p class="hero-desc">{{ t('home.desc') }}</p>
    </section>

    <div class="stats-strip">
      <div class="stat">
        <span class="stat-value mono">{{ onlineCount }}</span>
        <span class="stat-label">{{ t('home.onlineDevices') }}</span>
      </div>
      <div class="stat">
        <span class="stat-value mono">v{{ frontendVersion }}</span>
        <span class="stat-label">{{ t('home.currentVersion') }}</span>
      </div>
      <div class="stat">
        <span class="stat-value mono" :class="{ 'accent-text': updateChannel === 'test' }">{{ updateChannelText }}</span>
        <span class="stat-label">{{ t('home.updateChannel') }}</span>
      </div>
    </div>

    <el-row :gutter="16" class="feature-cards">
      <el-col :xs="24" :sm="12" :md="6">
        <div class="feature-card" @click="$router.push('/devices')">
          <div class="feature-num mono">01</div>
          <el-icon class="feature-icon"><Monitor /></el-icon>
          <h3>{{ t('home.devicesTitle') }}</h3>
          <p>{{ t('home.devicesDesc') }}</p>
        </div>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <div class="feature-card" @click="$router.push('/plays')">
          <div class="feature-num mono">02</div>
          <el-icon class="feature-icon"><VideoPlay /></el-icon>
          <h3>{{ t('home.playsTitle') }}</h3>
          <p>{{ t('home.playsDesc') }}</p>
        </div>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <div class="feature-card" @click="$router.push('/network')">
          <div class="feature-num mono">03</div>
          <el-icon class="feature-icon"><Connection /></el-icon>
          <h3>{{ t('home.networkTitle') }}</h3>
          <p>{{ t('home.networkDesc') }}</p>
        </div>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <div class="feature-card" @click="$router.push('/support')">
          <div class="feature-num mono">04</div>
          <el-icon class="feature-icon"><Service /></el-icon>
          <h3>{{ t('home.supportTitle') }}</h3>
          <p>{{ t('home.supportDesc') }}</p>
        </div>
      </el-col>
    </el-row>

    <el-card shadow="never" class="info-card">
      <template #header>
        <div class="info-header">
          <el-icon><InfoFilled /></el-icon>
          <span>{{ t('home.systemInfo') }}</span>
        </div>
      </template>
      <el-descriptions :column="2" border class="info-list" :size="'default'">
        <el-descriptions-item :label="t('home.onlineDevices')">
          <el-tag type="info" effect="plain">{{ t('common.countDevices', { n: onlineCount }) }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item :label="t('home.currentVersion')">
          <el-tag type="success" effect="plain">v{{ frontendVersion }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item :label="t('home.updateChannel')">
          <div class="update-channel">
            <el-tag :type="updateChannelTagType" effect="plain">{{ updateChannelText }}</el-tag>
            <el-switch
              v-model="receiveTestUpdates"
              :loading="updateSettingsLoading"
              :disabled="!hasUpdateApi"
              :active-text="t('home.channelTest')"
              :inactive-text="t('home.channelStable')"
              inline-prompt
              @change="saveUpdateSettings"
            />
          </div>
        </el-descriptions-item>
        <el-descriptions-item :label="t('home.appUpdate')">
          <div class="update-actions">
            <el-button
              size="small"
              :loading="checkingUpdates"
              :disabled="!hasUpdateApi"
              @click="checkForUpdates"
            >
              {{ t('home.checkUpdate') }}
            </el-button>
            <span v-if="updateMessage" :class="updateMessageClass">{{ updateMessage }}</span>
          </div>
        </el-descriptions-item>
        <el-descriptions-item :label="t('home.taobao')">
          <a href="http://guijizhixia.taobao.com/" target="_blank" class="link-text">guijizhixia.taobao.com</a>
        </el-descriptions-item>
        <el-descriptions-item :label="t('home.docs')">
          <a href="https://docs.undersilicon.cn" target="_blank" class="link-text">docs.undersilicon.cn</a>
        </el-descriptions-item>
        <el-descriptions-item :label="t('home.qqGroup')" :span="2">
          <span class="info-text">970326066</span>
          <el-tag size="small" type="warning" effect="plain" style="margin-left: 8px">{{ t('home.qqVerify') }}</el-tag>
        </el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { Monitor, VideoPlay, Connection, InfoFilled, Service } from '@element-plus/icons-vue'
import packageInfo from '../../package.json'

const { t } = useI18n()

const frontendVersion = packageInfo.version
const onlineCount = ref(0)
const receiveTestUpdates = ref(false)
const updateChannel = ref<UpdateChannel>('stable')
const updateSettingsLoading = ref(false)
const checkingUpdates = ref(false)
const updateMessage = ref('')
const updateMessageType = ref<'info' | 'success' | 'error'>('info')

const hasUpdateApi = computed(() => !!window.updateApi)
const updateChannelText = computed(() => updateChannel.value === 'test' ? t('home.channelTest') : t('home.channelStable'))
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
    updateMessage.value = error?.message || t('home.loadSettingsFailed')
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
    updateMessage.value = t('home.switchedTo', { channel: updateChannelText.value })
  } catch (error: any) {
    receiveTestUpdates.value = !receiveTestUpdates.value
    updateMessageType.value = 'error'
    updateMessage.value = error?.message || t('home.saveSettingsFailed')
    ElMessage.error(updateMessage.value)
  } finally {
    updateSettingsLoading.value = false
  }
}

function showUpdateResult(type: 'info' | 'success' | 'error', message: string) {
  updateMessageType.value = type
  updateMessage.value = message
  if (type === 'error') ElMessage.error(message)
  else if (type === 'success') ElMessage.success(message)
  else ElMessage.info(message)
}

async function checkForUpdates() {
  if (!window.updateApi) return
  checkingUpdates.value = true
  updateMessage.value = ''
  try {
    const status = await window.updateApi.checkForUpdates()
    applyUpdateStatus(status)
    if (status.error) {
      showUpdateResult('error', status.error)
      return
    }
    if (status.skipped) {
      showUpdateResult('info', t('home.skipDev'))
      return
    }
    if (status.available) {
      const versionText = status.latestVersion ? ` v${status.latestVersion}` : ''
      showUpdateResult('success', t('home.foundVersion', { version: versionText }))
      return
    }
    showUpdateResult('success', t('home.alreadyLatest'))
  } catch (error: any) {
    showUpdateResult('error', error?.message || t('home.checkFailed'))
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
  margin: 0 auto;
  box-sizing: border-box;
}

/* Hero：左侧蓝色径向辉光 + 大字号标题，贴参考站首屏气质 */
.hero {
  position: relative;
  padding: 56px 0 32px;
  margin-bottom: 8px;
}

.hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 78% 22%, var(--blue-glow), transparent 42%);
  pointer-events: none;
}

.hero > * {
  position: relative;
}

.hero-title {
  font-size: 40px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.01em;
  color: var(--text-primary);
  margin: 12px 0 0 0;
}

.hero-desc {
  margin: 14px 0 0 0;
  max-width: 560px;
  font-size: 15px;
  line-height: 1.7;
  color: var(--text-muted);
}

/* 等宽数字统计条 */
.stats-strip {
  display: flex;
  gap: 40px;
  padding: 18px 0;
  margin-bottom: 24px;
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
}

.stat-value.accent-text {
  color: var(--accent);
}

.stat-label {
  font-size: 12px;
  color: var(--text-faint);
  letter-spacing: 0.04em;
}

.feature-cards {
  margin-bottom: 24px;
}

.feature-cards .el-col {
  margin-bottom: 16px;
}

/* 编号式入口卡片：黑玻璃 + 青色编号 + hover 边框提亮 */
.feature-card {
  position: relative;
  cursor: pointer;
  height: 100%;
  padding: 28px 22px 24px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  transition: border-color 0.25s ease, background-color 0.25s ease, transform 0.25s ease;
}

.feature-card:hover {
  border-color: var(--border-strong);
  background: var(--bg-elevated);
  transform: translateY(-2px);
}

.feature-num {
  position: absolute;
  top: 18px;
  right: 20px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: var(--tracking-label);
  color: var(--accent);
  opacity: 0.85;
}

.feature-icon {
  font-size: 30px;
  color: var(--text-secondary);
  margin-bottom: 16px;
  transition: color 0.25s ease;
}

.feature-card:hover .feature-icon {
  color: var(--accent);
}

.feature-card h3 {
  margin: 0 0 8px 0;
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 600;
}

.feature-card p {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.6;
}

.info-card {
  margin-bottom: 20px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}

.info-card :deep(.el-card__header) {
  border-bottom: 1px solid var(--border-subtle);
}

.info-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--text-primary);
}

.link-text {
  color: var(--accent);
  text-decoration: none;
}

.link-text:hover {
  color: var(--accent-strong);
  text-decoration: underline;
}

.info-text {
  font-weight: 600;
  color: var(--text-primary);
  font-family: var(--font-mono);
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
  color: var(--text-muted);
}

.update-message-success {
  color: var(--el-color-success);
}

.update-message-error {
  color: var(--el-color-error);
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
  }

  .hero {
    padding: 36px 0 24px;
  }

  .hero-title {
    font-size: 28px;
  }

  .stats-strip {
    gap: 24px;
  }

  .stat-value {
    font-size: 18px;
  }

  .feature-cards .el-col {
    margin-bottom: 12px;
  }

  .feature-card {
    padding: 20px 16px 18px;
  }

  .feature-icon {
    font-size: 26px;
  }

  .info-list :deep(.el-descriptions__label) {
    width: 80px;
  }
}
</style>
