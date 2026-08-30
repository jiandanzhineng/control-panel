<template>
  <el-dialog
    :model-value="visible"
    :title="t('monitor.title', { name: deviceInfo?.name || deviceInfo?.id || t('monitor.unknownDevice') })"
    width="80%"
    @close="$emit('close')"
    destroy-on-close
  >
    <div v-if="loading" v-loading="loading" class="loading-container">
      <p>{{ t('monitor.loading') }}</p>
    </div>
    
    <div v-else-if="error" class="error-container">
      <el-alert :title="error" type="error" show-icon />
    </div>
    
    <div v-else-if="!hasMonitorData" class="no-data-container">
      <el-empty :description="t('monitor.unsupported')" />
    </div>
    
    <div v-else class="monitor-content">
      <div class="monitor-status">
        <el-tag :type="connected ? 'success' : 'danger'" size="small">
          {{ connected ? t('monitor.live') : t('monitor.disconnected') }}
        </el-tag>
        <span class="last-update">
          {{ t('monitor.lastUpdate', { time: lastUpdateTime || t('monitor.noData') }) }}
        </span>
      </div>
      
      <div class="charts-container">
        <div 
          v-for="(config, key) in monitorConfig" 
          :key="key" 
          class="chart-item"
        >
          <div class="chart-header">
            <h4>{{ config.name }} ({{ config.unit || '' }})</h4>
            <span class="current-value">
              {{ t('monitor.current', { value: formatValue(currentData[key], config.unit) }) }}
            </span>
          </div>
          <div class="chart-wrapper">
            <SimpleChart 
              :data="chartData[key] || []"
              :unit="config.unit"
              :height="200"
            />
          </div>
        </div>
      </div>
      
      <div v-if="Object.keys(monitorConfig).length === 0" class="no-charts">
        <el-empty :description="t('monitor.noConfig')" />
      </div>
    </div>
    
    <template #footer>
      <el-button @click="$emit('close')">{{ t('common.close') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import SimpleChart from './SimpleChart.vue'

const { t } = useI18n()

const props = defineProps({
  visible: Boolean,
  deviceInfo: Object
})

const emit = defineEmits(['close'])

const loading = ref(false)
const error = ref('')
const connected = ref(false)
const eventSource = ref(null)
const monitorConfig = ref({})
const currentData = ref({})
const lastUpdateTime = ref('')
const chartData = ref({})
const updateTimer = ref(null)
const pendingUpdates = ref({})

const hasMonitorData = computed(() => {
  return Object.keys(monitorConfig.value).length > 0
})

function formatValue(value, unit) {
  if (value === undefined || value === null) return '--'
  return `${value}${unit ? ' ' + unit : ''}`
}

async function loadMonitorData() {
  if (!props.deviceInfo) return
  
  loading.value = true
  error.value = ''
  
  try {
    const configResponse = await fetch(`/api/device-types/${props.deviceInfo.type}/config`)
    if (!configResponse.ok) {
      throw new Error(t('monitor.typeFailed'))
    }
    
    const configData = await configResponse.json()
    const monitorDataArray = configData.monitorData || []
    
    monitorConfig.value = {}
    chartData.value = {}
    
    monitorDataArray.forEach(item => {
      monitorConfig.value[item.key] = {
        name: item.name,
        unit: item.unit
      }
      chartData.value[item.key] = []
    })
    
    const dataResponse = await fetch(`/api/devices/${props.deviceInfo.id}/monitor-data`)
    if (dataResponse.ok) {
      const data = await dataResponse.json()
      currentData.value = data.data || {}
      lastUpdateTime.value = data.timestamp ? new Date(data.timestamp).toLocaleString() : ''
    }
    
    setupSSEConnection()
    
  } catch (err) {
    error.value = err.message
    ElMessage.error(err.message)
  } finally {
    loading.value = false
  }
}

function setupSSEConnection() {
  if (!props.deviceInfo) {
    console.error('setupSSEConnection: deviceInfo为空')
    return
  }
  
  console.log('设置SSE连接，设备信息:', props.deviceInfo)
  
  closeConnection()
  
  const url = `/api/devices/${props.deviceInfo.id}/monitor-stream`
  
  try {
    eventSource.value = new EventSource(url)
    
    eventSource.value.onopen = () => {
      connected.value = true
    }
    
    eventSource.value.addEventListener('history', (event) => {
      try {
        const data = JSON.parse(event.data)
        handleRealtimeData(data)
      } catch (err) {
        console.error('解析history数据失败:', err)
      }
    })

    eventSource.value.addEventListener('update', (event) => {
      try {
        const data = JSON.parse(event.data)
        handleRealtimeData(data)
      } catch (err) {
        console.error('解析update数据失败:', err)
      }
    })

    eventSource.value.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        handleRealtimeData(data)
      } catch (err) {
        console.error('解析默认消息数据失败:', err)
      }
    }
    
    eventSource.value.onerror = () => {
      connected.value = false
      ElMessage.warning(t('monitor.sseLost'))
    }
    
  } catch (error) {
    console.error('创建EventSource失败:', error)
  }
}

function handleRealtimeData(data) {
  if (!data || !data.data) return
  
  const timestamp = data.timestamp || new Date().toISOString()
  
  // 累积待更新的数据
  Object.assign(pendingUpdates.value, data.data)
  
  // 防抖处理，200ms 内只执行最后一次更新
  if (updateTimer.value) {
    clearTimeout(updateTimer.value)
  }
  
  updateTimer.value = setTimeout(() => {
    // 批量更新当前数据
    currentData.value = { ...currentData.value, ...pendingUpdates.value }
    lastUpdateTime.value = new Date(timestamp).toLocaleString()
    
    // 批量更新图表数据
    for (const [key, value] of Object.entries(pendingUpdates.value)) {
      if (monitorConfig.value[key] && typeof value === 'number') {
        if (!chartData.value[key]) {
          chartData.value[key] = []
        }
        
        chartData.value[key].push({
          time: new Date(timestamp).toLocaleTimeString(),
          value: value
        })
        
        // 保持最多50个数据点
        if (chartData.value[key].length > 50) {
          chartData.value[key].shift()
        }
      }
    }
    
    // 清空待更新数据
    pendingUpdates.value = {}
    updateTimer.value = null
  }, 200)
}

function closeConnection() {
  if (eventSource.value) {
    eventSource.value.close()
    eventSource.value = null
  }
  
  if (updateTimer.value) {
    clearTimeout(updateTimer.value)
    updateTimer.value = null
  }
  
  connected.value = false
  pendingUpdates.value = {}
}

watch(() => props.visible, (newVisible) => {
  if (newVisible && props.deviceInfo) {
    loadMonitorData()
  } else {
    closeConnection()
  }
})

onUnmounted(() => {
  closeConnection()
})
</script>

<style scoped>
.loading-container {
  text-align: center;
  padding: 40px;
  min-height: 200px;
}

.error-container {
  padding: 20px;
}

.no-data-container {
  padding: 40px;
  text-align: center;
}

.monitor-content {
  padding: 20px;
}

.monitor-status {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding: 10px;
  background-color: var(--bg-app);
  border-radius: 4px;
}

.last-update {
  font-size: 12px;
  color: var(--text-muted);
}

.charts-container {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 20px;
}

.chart-item {
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  padding: 15px;
  background-color: var(--bg-surface);
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.chart-header h4 {
  margin: 0;
  font-size: 14px;
  color: var(--text-primary);
}

.current-value {
  font-size: 12px;
  color: var(--accent);
  font-weight: bold;
}

.chart-wrapper {
  height: 200px;
  position: relative;
}

.no-charts {
  text-align: center;
  padding: 40px;
}

@media (max-width: 768px) {
  :deep(.el-dialog) {
    width: 95% !important;
  }
}
</style>