<template>
  <div class="settings-page">
    <section class="settings-hero">
      <p class="section-label">应用偏好</p>
      <h1 class="settings-title">设置</h1>
      <p class="settings-desc">窗口行为和本机语音渠道。语音配置一次，数字人和其他游戏共用。</p>
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

    <el-card shadow="never" class="settings-card">
      <template #header>
        <div class="settings-header">语音服务</div>
      </template>
      <div class="settings-copy">
        <div class="settings-name">MiMo 通路</div>
        <p class="settings-hint">
          {{ voice.hint || '官方渠道可能比较慢，建议使用个人 API key。' }}
          Token Plan
          <a :href="voice.tokenplan_url || 'https://platform.xiaomimimo.com/token-plan'" target="_blank" rel="noopener">注册</a>
          ，邀请码 <b>{{ voice.invite_code || '8SNDXF' }}</b>
          <a :href="voice.invite_url || 'https://platform.xiaomimimo.com?ref=8SNDXF'" target="_blank" rel="noopener">带邀请打开</a>。
        </p>
      </div>
      <el-radio-group v-model="voiceRoute" class="voice-routes" :disabled="voiceBusy">
        <el-radio-button value="panel">官方渠道</el-radio-button>
        <el-radio-button value="own_key">自备 MiMo key</el-radio-button>
      </el-radio-group>
      <div class="voice-key-row">
        <el-input v-model="voiceKey" type="password" show-password
          placeholder="个人 API key，留空则不改已保存的" autocomplete="off" />
        <el-button type="primary" :loading="voiceBusy" @click="saveVoice">保存</el-button>
        <el-button :disabled="voiceBusy || !voice.has_key" @click="clearVoiceKey">清除 key</el-button>
      </div>
      <p class="settings-note">{{ voiceStatusText }}</p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getVoiceStatus, saveVoiceSettings, type VoiceStatus } from '../api/voice'

const closeToTray = ref<boolean | null>(null)
const loading = ref(false)
const message = ref('')
const hasWindowApi = computed(() => !!window.windowApi)
const voice = ref<Partial<VoiceStatus>>({})
const voiceRoute = ref<'own_key' | 'panel'>('panel')
const voiceKey = ref('')
const voiceBusy = ref(false)

const voiceStatusText = computed(() => {
  const v = voice.value
  if (!v.route) return '正在读取语音设置…'
  const bits = [v.ready ? (v.mode === 'direct' ? '当前可用：直连' : '当前可用：官方中转') : '当前不可用']
  if (v.key_masked) bits.push(`已存 key ${v.key_masked}`)
  if (v.panel_email) bits.push(`面板 ${v.panel_email}`)
  else if (v.route === 'panel') bits.push('请先在账号页登录')
  if (v.route === 'own_key' && !v.has_key) bits.push('请填写个人 API key')
  return bits.join(' · ')
})

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

function applyVoice(next: VoiceStatus) {
  voice.value = next
  voiceRoute.value = next.route === 'own_key' ? 'own_key' : 'panel'
}

async function loadVoice() {
  try {
    applyVoice(await getVoiceStatus())
  } catch (error: any) {
    ElMessage.error(error?.message || '语音设置读取失败')
  }
}

async function saveVoice() {
  voiceBusy.value = true
  try {
    const body: { route: 'own_key' | 'panel'; api_key?: string } = { route: voiceRoute.value }
    if (voiceKey.value.trim()) body.api_key = voiceKey.value.trim()
    applyVoice(await saveVoiceSettings(body))
    voiceKey.value = ''
    ElMessage.success('语音设置已保存')
  } catch (error: any) {
    ElMessage.error(error?.message || '语音设置保存失败')
  } finally {
    voiceBusy.value = false
  }
}

async function clearVoiceKey() {
  voiceBusy.value = true
  try {
    applyVoice(await saveVoiceSettings({ api_key: '' }))
    voiceKey.value = ''
    ElMessage.success('已清除个人 key')
  } catch (error: any) {
    ElMessage.error(error?.message || '清除失败')
  } finally {
    voiceBusy.value = false
  }
}

onMounted(() => {
  void loadSettings()
  void loadVoice()
})
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

.voice-routes {
  display: block;
  margin: 16px 0 12px;
}

.voice-key-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
