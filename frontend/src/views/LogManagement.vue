<template>
  <div class="log-management">
    <h1>日志管理系统</h1>
    
    <div class="tabs">
      <button 
        :class="{ active: activeTab === 'realtime' }" 
        @click="activeTab = 'realtime'"
      >
        实时日志
      </button>
      <button 
        :class="{ active: activeTab === 'files' }" 
        @click="activeTab = 'files'"
      >
        历史文件
      </button>
    </div>

    <div class="tab-content">
      <RealTimeLog v-if="activeTab === 'realtime'" />
      <LogFileList v-if="activeTab === 'files'" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import RealTimeLog from '../components/RealTimeLog.vue'
import LogFileList from '../components/LogFileList.vue'

const activeTab = ref('realtime')
</script>

<style scoped>
.log-management {
  padding: 20px;
}

.tabs {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
}

.tabs button {
  padding: 10px 20px;
  border: 1px solid #ddd;
  background: #f5f5f5;
  cursor: pointer;
  border-radius: 4px;
}

.tabs button.active {
  background: #007bff;
  color: white;
  border-color: #007bff;
}

.tab-content {
  border: 1px solid #ddd;
  border-radius: 4px;
  padding: 20px;
  min-height: 500px;
}
</style>