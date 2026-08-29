<template>
  <div class="settings-page">
    <section class="settings-hero">
      <p class="section-label">{{ t('settings.label') }}</p>
      <h1 class="settings-title">{{ t('settings.title') }}</h1>
      <p class="settings-desc">{{ t('settings.desc') }}</p>
    </section>

    <el-card shadow="never" class="settings-card">
      <template #header>
        <div class="settings-header">{{ t('settings.window') }}</div>
      </template>
      <div class="settings-row">
        <div class="settings-copy">
          <div class="settings-name">{{ t('settings.closeToTray') }}</div>
          <p class="settings-hint">{{ t('settings.closeToTrayHint') }}</p>
        </div>
        <el-switch
          :model-value="closeToTray === true"
          :loading="loading"
          :disabled="!hasWindowApi"
          @change="onCloseToTrayChange"
        />
      </div>
      <p v-if="!hasWindowApi" class="settings-note">{{ t('settings.notDesktop') }}</p>
      <p v-else-if="message" class="settings-note">{{ message }}</p>
    </el-card>

    <el-card shadow="never" class="settings-card">
      <template #header>
        <div class="settings-header">{{ t('locale.language') }}</div>
      </template>
      <div class="settings-row">
        <div class="settings-copy">
          <div class="settings-name">{{ t('locale.language') }}</div>
          <p class="settings-hint">{{ t('locale.hint') }}</p>
        </div>
        <el-select
          :model-value="preference"
          style="width: 160px"
          @change="onLocaleChange"
        >
          <el-option :label="t('locale.system')" value="system" />
          <el-option :label="t('locale.zh')" value="zh" />
          <el-option :label="t('locale.en')" value="en" />
        </el-select>
      </div>
    </el-card>

    <el-card shadow="never" class="settings-card">
      <template #header>
        <div class="settings-header">{{ t('settings.voice') }}</div>
      </template>
      <div class="settings-copy">
        <div class="settings-name">{{ t('settings.voiceName') }}</div>
        <p class="settings-hint">
          {{ voice.hint || t('settings.voiceHint') }}
          Token Plan
          <a :href="voice.tokenplan_url || 'https://platform.xiaomimimo.com/token-plan'" target="_blank" rel="noopener">{{ t('settings.register') }}</a>
          ，{{ t('settings.inviteCode') }} <b>{{ voice.invite_code || '8SNDXF' }}</b>
          <a :href="voice.invite_url || 'https://platform.xiaomimimo.com?ref=8SNDXF'" target="_blank" rel="noopener">{{ t('settings.inviteOpen') }}</a>。
        </p>
      </div>
      <el-radio-group v-model="voiceRoute" class="voice-routes" :disabled="voiceBusy">
        <el-radio-button value="panel">{{ t('settings.routePanel') }}</el-radio-button>
        <el-radio-button value="own_key">{{ t('settings.routeOwnKey') }}</el-radio-button>
      </el-radio-group>
      <div class="voice-key-row">
        <el-input v-model="voiceKey" type="password" show-password
          :placeholder="t('settings.keyPlaceholder')" autocomplete="off" />
        <el-button type="primary" :loading="voiceBusy" @click="saveVoice">{{ t('common.save') }}</el-button>
        <el-button :disabled="voiceBusy || !voice.has_key" @click="clearVoiceKey">{{ t('settings.clearKey') }}</el-button>
      </div>
      <p class="settings-note">{{ voiceStatusText }}</p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { getVoiceStatus, saveVoiceSettings, type VoiceStatus } from '../api/voice'
import { useLocale } from '../i18n/useLocale'
import type { LocalePreference } from '../i18n/locale'

const { t } = useI18n()
const { preference, setPreference } = useLocale()
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
  if (!v.route) return t('settings.reading')
  const bits = [v.ready ? (v.mode === 'direct' ? t('settings.availableDirect') : t('settings.availableRelay')) : t('settings.unavailable')]
  if (v.key_masked) bits.push(t('settings.savedKey', { key: v.key_masked }))
  if (v.panel_email) bits.push(t('settings.panelUser', { email: v.panel_email }))
  else if (v.route === 'panel') bits.push(t('settings.loginFirst'))
  if (v.route === 'own_key' && !v.has_key) bits.push(t('settings.fillKey'))
  return bits.join(' · ')
})

async function loadSettings() {
  if (!window.windowApi) return
  loading.value = true
  try {
    const settings = await window.windowApi.getSettings()
    closeToTray.value = settings.closeToTray
  } catch (error: any) {
    message.value = error?.message || t('settings.loadFailed')
  } finally {
    loading.value = false
  }
}

async function onCloseToTrayChange(value: string | number | boolean) {
  if (!window.windowApi) return
  loading.value = true
  message.value = ''
  try {
    const current = await window.windowApi.getSettings()
    const settings = await window.windowApi.setSettings({ ...current, closeToTray: !!value })
    closeToTray.value = settings.closeToTray
    message.value = settings.closeToTray ? t('settings.trayOn') : t('settings.trayOff')
  } catch (error: any) {
    message.value = error?.message || t('settings.saveFailed')
    ElMessage.error(message.value)
  } finally {
    loading.value = false
  }
}

async function onLocaleChange(value: string) {
  try {
    await setPreference(value as LocalePreference)
    ElMessage.success(t('locale.saved'))
  } catch (error: any) {
    ElMessage.error(error?.message || t('locale.saveFailed'))
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
    ElMessage.error(error?.message || t('settings.voiceLoadFailed'))
  }
}

async function saveVoice() {
  voiceBusy.value = true
  try {
    const body: { route: 'own_key' | 'panel'; api_key?: string } = { route: voiceRoute.value }
    if (voiceKey.value.trim()) body.api_key = voiceKey.value.trim()
    applyVoice(await saveVoiceSettings(body))
    voiceKey.value = ''
    ElMessage.success(t('settings.voiceSaved'))
  } catch (error: any) {
    ElMessage.error(error?.message || t('settings.voiceSaveFailed'))
  } finally {
    voiceBusy.value = false
  }
}

async function clearVoiceKey() {
  voiceBusy.value = true
  try {
    applyVoice(await saveVoiceSettings({ api_key: '' }))
    voiceKey.value = ''
    ElMessage.success(t('settings.keyCleared'))
  } catch (error: any) {
    ElMessage.error(error?.message || t('settings.clearFailed'))
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
