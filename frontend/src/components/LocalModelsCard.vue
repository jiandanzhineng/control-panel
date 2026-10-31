<template>
  <el-card shadow="never" class="settings-card local-models-card">
    <template #header>
      <div class="lm-header">
        <div class="lm-title">
          <el-icon><Cpu /></el-icon>
          <span>{{ t('models.title') }}</span>
        </div>
        <el-button size="small" :icon="Refresh" :loading="refreshing" @click="refreshDevices">
          {{ t('models.refresh') }}
        </el-button>
      </div>
    </template>

    <p class="lm-desc">{{ t('models.desc') }}</p>

    <div class="lm-section-title">{{ t('models.devices') }}</div>
    <div class="lm-devices">
      <div v-for="device in devices" :key="device.id" class="lm-device" :class="{ 'is-on': device.available }">
        <span class="lm-dot" />
        <span class="lm-device-name">{{ device.name }}</span>
        <el-tag size="small" effect="plain" :type="device.available ? 'success' : 'info'">
          {{ device.available ? t('models.available') : reasonText(device) }}
        </el-tag>
        <span v-if="device.id === last.provider" class="lm-current">{{ t('models.current') }}</span>
      </div>
    </div>

    <el-divider />

    <div class="lm-task-head">
      <span class="lm-section-title">{{ t('models.taskAsr') }}</span>
      <el-switch v-model="localEnabled" :disabled="!hasUsableModel" @change="saveAsr" />
    </div>
    <p class="lm-hint">{{ t('models.localEnabledHint') }}</p>
    <div class="lm-selects">
      <div class="lm-field">
        <label>{{ t('models.preferredModel') }}</label>
        <el-select v-model="modelId" :disabled="!localEnabled" style="width: 100%" @change="saveAsr">
          <el-option :label="t('models.auto')" value="__auto__" />
          <el-option v-for="model in readyModels" :key="model.id" :label="modelTitle(model)" :value="model.id" />
        </el-select>
      </div>
      <div class="lm-field">
        <label>{{ t('models.provider') }}</label>
        <el-select v-model="provider" :disabled="!localEnabled" style="width: 100%" @change="saveAsr">
          <el-option :label="t('models.providerAuto')" value="auto" />
          <el-option
            v-for="device in devices"
            :key="device.id"
            :label="device.name"
            :value="device.id"
            :disabled="!device.available"
          />
        </el-select>
      </div>
    </div>
    <p v-if="providerFallback" class="lm-hint lm-fallback">{{ t('models.fallbackHint') }}</p>

    <el-divider />

    <div class="lm-section-title">{{ t('models.models') }}</div>
    <div v-for="model in models" :key="model.id" class="lm-model-block">
      <div class="lm-model">
        <div class="lm-model-info">
          <div class="lm-model-title">{{ modelTitle(model) }}</div>
          <div class="lm-meta">
            <span>{{ formatSize(model.total) }}</span>
            <span v-if="model.languages?.length">· {{ model.languages.join(' / ') }}</span>
            <span>· {{ model.license?.name }}</span>
            <a v-if="model.license?.url" :href="model.license.url" target="_blank" rel="noopener">↗</a>
          </div>
        </div>
        <div class="lm-model-actions">
          <el-tag size="small" :type="stateType(model.state)">{{ stateText(model) }}</el-tag>
          <el-button v-if="model.state === 'absent'" size="small" type="primary" @click="download(model)">
            {{ t('models.download') }}
          </el-button>
          <el-button v-else-if="model.state === 'downloading' || model.state === 'verifying'" size="small" @click="cancel(model)">
            {{ t('models.cancel') }}
          </el-button>
          <template v-else-if="model.state === 'ready'">
            <el-button size="small" @click="redownload(model)">{{ t('models.redownload') }}</el-button>
            <el-button size="small" type="danger" plain @click="remove(model)">{{ t('models.remove') }}</el-button>
          </template>
          <el-button v-else size="small" type="primary" @click="download(model)">{{ t('models.retry') }}</el-button>
        </div>
      </div>
      <div v-if="isActive(model)" class="lm-progress">
        <el-progress :percentage="percent(model)" :stroke-width="8" />
        <span class="lm-progress-text">
          {{ t('models.progress', { received: formatSize(model.received), total: formatSize(model.total) }) }}
        </span>
      </div>
      <p v-if="model.state === 'error'" class="lm-error">{{ model.error }}</p>
    </div>

    <div class="lm-perf">
      <span>{{ t('models.benchmark') }}: <b>{{ benchmarkText }}</b></span>
      <span>{{ t('models.lastInference') }}: <b>{{ lastText }}</b></span>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Cpu, Refresh } from '@element-plus/icons-vue'
import {
  cancelModelDownload,
  deleteModel,
  downloadModel,
  getModels,
  refreshAccelerators,
  saveModelSettings,
  type Accelerator,
  type ModelEntry,
  type ModelsSnapshot,
} from '../api/models'

const { t, locale } = useI18n()
const snapshot = ref<ModelsSnapshot | null>(null)
const refreshing = ref(false)
const localEnabled = ref(false)
const modelId = ref('')
const provider = ref('auto')
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false

const models = computed<ModelEntry[]>(() => snapshot.value?.models || [])
// 没检测到的硬件（CPU 除外）不展示；后端仍返回完整列表供诊断。
const devices = computed<Accelerator[]>(() => (snapshot.value?.accelerators || [])
  .filter((device) => device.present || device.id === 'cpu'))
const last = computed(() => snapshot.value?.last || { provider: null, latencyMs: null })
const asr = computed(() => snapshot.value?.settings?.asr || { localEnabled: false, model: null, provider: 'auto' })
const readyModels = computed(() => models.value.filter((model) => model.state === 'ready'))
const hasUsableModel = computed(() => readyModels.value.length > 0)
const providerFallback = computed(() => {
  if (!localEnabled.value || provider.value === 'auto') return false
  const device = devices.value.find((item) => item.id === provider.value)
  return !device || !device.available
})
const activeModels = computed(() => models.value.filter((m) => isActive(m)))
function isActive(model: ModelEntry) {
  return model.state === 'downloading' || model.state === 'verifying'
}

watch(asr, (value) => {
  localEnabled.value = value.localEnabled === true
  modelId.value = value.model || '__auto__'
  provider.value = value.provider || 'auto'
}, { immediate: true })

function modelTitle(model: ModelEntry) {
  return locale.value === 'en' ? model.title.en : model.title.zh
}

function formatSize(bytes: number) {
  const mb = Number(bytes || 0) / (1024 * 1024)
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`
}

function percent(model: ModelEntry) {
  if (!model.total) return 0
  return Math.max(0, Math.min(100, Math.floor((model.received / model.total) * 100)))
}

function stateText(model: ModelEntry) {
  const key = `models.state${model.state.charAt(0).toUpperCase()}${model.state.slice(1)}`
  return t(key)
}

function stateType(state: ModelEntry['state']) {
  if (state === 'ready') return 'success'
  if (state === 'error') return 'danger'
  if (state === 'downloading' || state === 'verifying') return 'warning'
  return 'info'
}

function reasonText(device: Accelerator) {
  const map: Record<string, string> = {
    'engine-unsupported': t('models.reasonEngine'),
    'hardware-missing': t('models.reasonHardware'),
    untested: t('models.reasonUntested'),
    'failed-twice': t('models.reasonFailed'),
    'model-unsupported': t('models.reasonModel'),
  }
  return map[device.reason || ''] || t('models.unavailable')
}

const benchmarkText = computed(() => {
  const all = snapshot.value?.benchmarks || {}
  const parts: string[] = []
  for (const [modelIdKey, providers] of Object.entries(all)) {
    const model = models.value.find((m) => m.id === modelIdKey)
    for (const [id, value] of Object.entries(providers || {})) {
      const name = devices.value.find((d) => d.id === id)?.name || id
      parts.push(`${model ? modelTitle(model) : modelIdKey} · ${name}: ${value.ms} ms`)
    }
  }
  return parts.join(' / ') || '—'
})

const lastText = computed(() => {
  if (!last.value.latencyMs) return '—'
  const name = devices.value.find((d) => d.id === last.value.provider)?.name || last.value.provider || '—'
  return `${name} · ${last.value.latencyMs} ms`
})

async function load() {
  if (disposed) return
  try {
    const next = await getModels()
    if (disposed) return
    snapshot.value = next
  } catch (_) {
    // 后端暂时不可用时保持上一次状态
  }
  schedule()
}

function schedule() {
  if (disposed) return
  if (timer) clearTimeout(timer)
  const busy = activeModels.value.length > 0
  timer = setTimeout(load, busy ? 1000 : 5000)
}

async function refreshDevices() {
  refreshing.value = true
  try {
    await refreshAccelerators()
    await load()
  } catch (error: any) {
    ElMessage.error(error?.message || t('models.failed'))
  } finally {
    refreshing.value = false
  }
}

async function saveAsr() {
  try {
    await saveModelSettings({
      asr: {
        localEnabled: localEnabled.value,
        model: modelId.value === '__auto__' ? null : modelId.value,
        provider: provider.value,
      },
    })
    await load()
    ElMessage.success(t('models.saved'))
  } catch (error: any) {
    ElMessage.error(error?.message || t('models.saveFailed'))
  }
}

async function confirmDownload(model: ModelEntry, redownload = false) {
  try {
    await ElMessageBox.confirm(
      t(redownload ? 'models.redownloadConfirm' : 'models.downloadConfirm', { size: formatSize(model.total) }),
      t(redownload ? 'models.redownload' : 'models.download'),
      { type: 'info', confirmButtonText: t('models.download'), cancelButtonText: t('common.cancel') },
    )
    return true
  } catch (_) {
    return false
  }
}

async function download(model: ModelEntry) {
  if (!(await confirmDownload(model))) return
  try {
    await downloadModel(model.id)
    await load()
  } catch (error: any) {
    ElMessage.error(error?.message || t('models.failed'))
  }
}

async function cancel(model: ModelEntry) {
  try {
    await cancelModelDownload(model.id)
    await load()
  } catch (error: any) {
    ElMessage.error(error?.message || t('models.failed'))
  }
}

async function remove(model: ModelEntry) {
  try {
    await ElMessageBox.confirm(t('models.removeConfirm'), t('models.remove'), {
      type: 'warning', confirmButtonText: t('models.remove'), cancelButtonText: t('common.cancel'),
    })
  } catch (_) {
    return
  }
  try {
    await deleteModel(model.id)
    await load()
    ElMessage.success(t('models.removed'))
  } catch (error: any) {
    ElMessage.error(error?.message || t('models.failed'))
  }
}

async function redownload(model: ModelEntry) {
  if (!(await confirmDownload(model, true))) return
  try {
    await deleteModel(model.id)
    await downloadModel(model.id)
    await load()
  } catch (error: any) {
    ElMessage.error(error?.message || t('models.failed'))
  }
}

onMounted(load)
onBeforeUnmount(() => { disposed = true; if (timer) clearTimeout(timer) })
</script>

<style scoped>
.local-models-card {
  margin-bottom: 24px;
}

.lm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.lm-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--text-primary);
}

.lm-desc,
.lm-hint {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-muted);
}

.lm-fallback {
  margin-top: 10px;
  color: var(--el-color-warning);
}

.lm-section-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-primary);
}

.lm-devices {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 12px 0 4px;
}

.lm-device {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-lighter);
  font-size: 13px;
}

.lm-device.is-on {
  border-color: var(--el-color-success-light-5);
  background: var(--el-color-success-light-9);
}

.lm-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-color-info);
  flex: none;
}

.lm-device.is-on .lm-dot {
  background: var(--el-color-success);
  box-shadow: 0 0 0 3px var(--el-color-success-light-8);
}

.lm-device-name {
  color: var(--text-primary);
}

.lm-current {
  font-size: 12px;
  color: var(--el-color-success);
}

.lm-task-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.lm-selects {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

.lm-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-muted);
}

.lm-model-block {
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.lm-model-block:last-of-type {
  border-bottom: none;
}

.lm-model {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 0;
}

.lm-model-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.lm-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.lm-meta a {
  color: var(--el-color-primary);
  text-decoration: none;
}

.lm-model-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.lm-progress {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 6px 0 10px;
}

.lm-progress .el-progress {
  flex: 1;
}

.lm-progress-text {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}

.lm-error {
  margin: 4px 0 10px;
  font-size: 12px;
  color: var(--el-color-danger);
}

.lm-perf {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--el-border-color-lighter);
  font-size: 12px;
  color: var(--text-muted);
}

.lm-perf b {
  font-weight: 600;
  color: var(--text-primary);
}

@media (max-width: 640px) {
  .lm-model {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
