<template>
  <div class="log-management">
    <div class="tabs">
      <button 
        :class="{ active: activeTab === 'realtime' }" 
        @click="activeTab = 'realtime'"
      >
        {{ t('logs.realtime') }}
      </button>
      <button 
        :class="{ active: activeTab === 'files' }" 
        @click="activeTab = 'files'"
      >
        {{ t('logs.files') }}
      </button>
      <button class="upload-btn" :disabled="uploading" @click="uploadDiagnostics">
{{ uploading ? t('logs.uploading') : t('logs.upload') }}
      </button>
    </div>
    <p v-if="uploadHint" class="upload-hint">{{ uploadHint }}</p>

    <div class="tab-content" :class="{ realtime: activeTab === 'realtime' }">
      <RealTimeLog v-if="activeTab === 'realtime'" />
      <LogFileList v-if="activeTab === 'files'" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import RealTimeLog from '../components/RealTimeLog.vue'
import LogFileList from '../components/LogFileList.vue'

const { t } = useI18n()
const activeTab = ref('realtime')
const uploading = ref(false)
const uploadHint = ref('')

async function uploadDiagnostics() {
  if (uploading.value) return
  uploading.value = true
  uploadHint.value = ''
  try {
    const res = await fetch('/api/logs/upload-diagnostics', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const code = data?.error?.code || ''
      if (res.status === 429 || code === 'TOO_MANY_REQUESTS') {
        throw new Error(t('logs.tooFrequent'))
      }
      throw new Error(data?.error?.message || t('logs.uploadFailed'))
    }
    const shortId = String(data.id || '').slice(0, 8)
    uploadHint.value = shortId ? t('logs.uploadedId', { id: shortId }) : t('logs.uploaded')
  } catch (error: any) {
    uploadHint.value = error?.message || t('logs.uploadFailed')
  } finally {
    uploading.value = false
  }
}
</script>

<style scoped>
.log-management {
  padding: 20px;
}

.tabs {
  display: flex;
  gap: 12px;
  justify-content: flex-start;
  margin-bottom: 16px;
}

.tabs button {
  padding: 10px 20px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
}

.tabs button.active {
  background: var(--accent);
  color: #062026;
  border-color: var(--accent);
  font-weight: 600;
}

.tabs .upload-btn {
  margin-left: auto;
  border-color: var(--accent);
  color: var(--accent);
}

.tabs .upload-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.upload-hint {
  margin: 0 0 12px;
  color: var(--text-secondary);
}

.tab-content {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 20px;
  min-height: 500px;
}

.tab-content.realtime {
  max-width: 1000px;
}

@media (max-width: 768px) {
  .tabs {
    flex-wrap: wrap;
    gap: 10px;
  }
}
</style>
