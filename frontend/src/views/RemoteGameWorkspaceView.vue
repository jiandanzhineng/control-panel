<template>
  <div class="remote-workspace-page">
    <header class="workspace-header">
      <div>
        <span class="eyebrow">CONTROL PANEL / REMOTE WORKSPACE</span>
        <h1>{{ t('remoteGame.title') }}</h1>
        <p>{{ t('remoteGame.desc') }}</p>
      </div>
      <el-button @click="router.push('/devices')">{{ t('common.back') }}</el-button>
    </header>
    <RemoteGamePanel standalone />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import RemoteGamePanel from '../components/RemoteGamePanel.vue'

const { t } = useI18n()
const router = useRouter()
</script>

<style scoped>
.remote-workspace-page { min-height: 100%; padding: 24px 20px 40px; background: #f8fafc; box-sizing: border-box; }
.workspace-header { width: min(100%, 960px); margin: 0 auto 16px; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.eyebrow { display: block; color: #64748b; font-size: 11px; letter-spacing: .08em; }
.workspace-header h1 { margin: 4px 0; color: #0f172a; font-size: 24px; }
.workspace-header p { margin: 0; color: #64748b; }
@media (max-width: 600px) {
  .remote-workspace-page { padding: 12px 10px 28px; }
  .workspace-header { align-items: stretch; flex-direction: column; }
  .workspace-header .el-button { align-self: flex-start; }
}
</style>
