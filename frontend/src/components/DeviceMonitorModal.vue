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

      <div v-if="attitudeEnabled" class="attitude-dashboard" data-testid="dan01-attitude-dashboard">
        <section class="attitude-scene">
          <div class="section-heading">
            <h4>{{ t('monitor.attitude') }}</h4>
            <span>{{ t('monitor.quaternion') }}</span>
          </div>
          <AttitudeViewer :quaternion="attitudeData.quaternion" :live="connected" />
        </section>

        <div class="telemetry-panel">
          <section class="telemetry-section">
            <h4>{{ t('monitor.eulerAngles') }}</h4>
            <dl class="telemetry-grid">
              <div><dt>Roll</dt><dd>{{ formatScalar(attitudeData.euler?.roll) }}°</dd></div>
              <div><dt>Pitch</dt><dd>{{ formatScalar(attitudeData.euler?.pitch) }}°</dd></div>
              <div><dt>Yaw</dt><dd>{{ formatScalar(attitudeData.euler?.yaw) }}°</dd></div>
            </dl>
          </section>

          <section class="telemetry-section">
            <h4>{{ t('monitor.acceleration') }} <span>m/s²</span></h4>
            <dl class="telemetry-grid">
              <div><dt>X</dt><dd>{{ formatVector(attitudeData.accel, 0, 3) }}</dd></div>
              <div><dt>Y</dt><dd>{{ formatVector(attitudeData.accel, 1, 3) }}</dd></div>
              <div><dt>Z</dt><dd>{{ formatVector(attitudeData.accel, 2, 3) }}</dd></div>
            </dl>
          </section>

          <section class="telemetry-section">
            <h4>{{ t('monitor.angularVelocity') }} <span>°/s</span></h4>
            <dl class="telemetry-grid">
              <div><dt>X</dt><dd>{{ formatVector(attitudeData.gyro, 0, 2) }}</dd></div>
              <div><dt>Y</dt><dd>{{ formatVector(attitudeData.gyro, 1, 2) }}</dd></div>
              <div><dt>Z</dt><dd>{{ formatVector(attitudeData.gyro, 2, 2) }}</dd></div>
            </dl>
          </section>

          <section class="telemetry-section">
            <h4>{{ t('monitor.magneticField') }} <span>μT</span></h4>
            <dl class="telemetry-grid">
              <div><dt>X</dt><dd>{{ formatVector(attitudeData.mag, 0, 2) }}</dd></div>
              <div><dt>Y</dt><dd>{{ formatVector(attitudeData.mag, 1, 2) }}</dd></div>
              <div><dt>Z</dt><dd>{{ formatVector(attitudeData.mag, 2, 2) }}</dd></div>
            </dl>
          </section>

          <dl class="status-grid">
            <div><dt>{{ t('monitor.temperature') }}</dt><dd>{{ formatScalar(currentData.temperature) }} ℃</dd></div>
            <div><dt>{{ t('monitor.height') }}</dt><dd>{{ formatScalar(currentData.height, 3) }} m</dd></div>
            <div><dt>{{ t('monitor.button') }}</dt><dd>{{ Number(currentData.button0) === 1 ? t('monitor.pressed') : t('monitor.released') }}</dd></div>
            <div><dt>{{ t('monitor.magAccuracy') }}</dt><dd>{{ formatMagAccuracy(currentData.mag_accuracy) }}</dd></div>
          </dl>
        </div>
      </div>
      
      <div v-if="Object.keys(chartConfigs).length > 0" class="charts-container">
        <div 
          v-for="(config, key) in chartConfigs"
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
      
      <div v-if="Object.keys(chartConfigs).length === 0 && !attitudeEnabled" class="no-charts">
        <el-empty :description="t('monitor.noConfig')" />
      </div>
    </div>
    
    <template #footer>
      <el-button @click="$emit('close')">{{ t('common.close') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, defineAsyncComponent, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import SimpleChart from './SimpleChart.vue'
import { decodeDan01Telemetry } from '../utils/dan01Attitude'

const { t } = useI18n()
const AttitudeViewer = defineAsyncComponent(() => import('./AttitudeViewer.vue'))

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

const hasMonitorData = computed(() => {
  return Object.keys(monitorConfig.value).length > 0
})

const attitudeEnabled = computed(() => {
  return Object.values(monitorConfig.value).some(config => config?.visualization === 'attitude')
})

const attitudeData = computed(() => decodeDan01Telemetry(currentData.value))

const chartConfigs = computed(() => Object.fromEntries(
  Object.entries(monitorConfig.value).filter(([, config]) => config?.chart !== false)
))

function formatValue(value, unit) {
  if (value === undefined || value === null) return '--'
  return `${value}${unit ? ' ' + unit : ''}`
}

function formatScalar(value, digits = 2) {
  const number = Number(value)
  return Number.isFinite(number) ? number.toFixed(digits) : '--'
}

function formatVector(values, index, digits) {
  return Array.isArray(values) ? formatScalar(values[index], digits) : '--'
}

function formatMagAccuracy(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 && number <= 3 ? `${number} / 3` : '--'
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
        unit: item.unit,
        chart: item.chart,
        visualization: item.visualization
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
  const updates = data.data
  currentData.value = { ...currentData.value, ...updates }
  lastUpdateTime.value = new Date(timestamp).toLocaleString()
  const chartTime = new Date(timestamp).toLocaleTimeString()

  for (const [key, value] of Object.entries(updates)) {
    if (monitorConfig.value[key] && typeof value === 'number') {
      if (!chartData.value[key]) {
        chartData.value[key] = []
      }

      chartData.value[key].push({ time: chartTime, value })
      if (chartData.value[key].length > 50) chartData.value[key].shift()
    }
  }
}

function closeConnection() {
  if (eventSource.value) {
    eventSource.value.close()
    eventSource.value = null
  }
  
  connected.value = false
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

.attitude-dashboard {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(330px, 0.85fr);
  gap: 22px;
  margin-bottom: 22px;
}

.attitude-scene,
.telemetry-panel {
  min-width: 0;
}

.section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.section-heading h4,
.telemetry-section h4 {
  margin: 0;
  color: var(--text-primary);
  font-size: 14px;
}

.section-heading span,
.telemetry-section h4 span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 400;
}

.telemetry-panel {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.telemetry-section {
  padding: 2px 0 12px;
  border-bottom: 1px solid var(--border-color);
}

.telemetry-section + .telemetry-section {
  padding-top: 12px;
}

.telemetry-grid,
.status-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 9px 0 0;
}

.telemetry-grid div,
.status-grid div {
  min-width: 0;
}

.telemetry-grid dt,
.status-grid dt {
  color: var(--text-muted);
  font-size: 11px;
}

.telemetry-grid dd,
.status-grid dd {
  margin: 3px 0 0;
  overflow-wrap: anywhere;
  color: var(--text-primary);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.status-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding-top: 14px;
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

  .monitor-content {
    padding: 8px 0;
  }

  .monitor-status {
    align-items: flex-start;
    gap: 8px;
  }

  .attitude-dashboard {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }

  .charts-container {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
