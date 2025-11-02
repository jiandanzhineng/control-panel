<template>
  <div class="real-time-log">
    <div v-if="!compact" class="log-header">
      <h3>实时日志</h3>
      <div class="controls">
        <button @click="clearLogs">清空</button>
      </div>
    </div>
    
    <div class="log-container" ref="logContainer" :style="{ maxHeight: height }">
      <div 
        v-for="log in filteredLogs" 
        :key="log.id" 
        :class="['log-entry', `level-${log.level.toLowerCase()}`, { compact: compact }]"
      >
        <span class="timestamp">{{ formatTime(log.timestamp) }}</span>
        <span class="level">{{ formatLevel(log.level) }}</span>
        <span class="module">{{ formatModule(log.module) }}</span>
        <span class="message">{{ log.message }}</span>
      </div>
      <div v-if="filteredLogs.length === 0" class="no-logs">
        暂无日志数据
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, computed } from 'vue'

interface LogEntry {
  id: number
  timestamp: string
  level: string
  module: string
  message: string
}

interface Props {
  moduleFilter?: string[]
  height?: string
  compact?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  moduleFilter: () => [],
  height: '400px',
  compact: false
})

const logs = ref<LogEntry[]>([])
const eventSource = ref<EventSource | null>(null)
const logContainer = ref<HTMLElement>()
let logIdCounter = 0

const filteredLogs = computed(() => {
  if (!props.moduleFilter || props.moduleFilter.length === 0) {
    return logs.value
  }
  
  return logs.value.filter(log => {
    const moduleText = log.module.toLowerCase()
    return props.moduleFilter.some(filter => 
      moduleText.includes(filter.toLowerCase())
    )
  })
})

const connectToLogStream = () => {
  if (eventSource.value) {
    eventSource.value.close()
  }

  eventSource.value = new EventSource('http://localhost:3000/api/logs/current')
  
  eventSource.value.onmessage = (event) => {
    const logData = JSON.parse(event.data)
    logs.value.push({
      id: ++logIdCounter,
      ...logData
    })
    
    if (logs.value.length > 1000) {
      logs.value = logs.value.slice(-500)
    }
    
    nextTick(() => {
      scrollToBottom()
    })
  }
}

const disconnectFromLogStream = () => {
  if (eventSource.value) {
    eventSource.value.close()
    eventSource.value = null
  }
}

const clearLogs = () => {
  logs.value = []
}

const scrollToBottom = () => {
  if (logContainer.value) {
    logContainer.value.scrollTop = logContainer.value.scrollHeight
  }
}

const formatTime = (timestamp: string) => {
  const date = new Date(timestamp)
  if (props.compact) {
    // 紧凑模式：只显示时:分:秒
    return date.toLocaleTimeString('zh-CN', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    })
  }
  return date.toLocaleTimeString()
}

const formatLevel = (level: string) => {
  if (props.compact) {
    // 紧凑模式：使用单字符标识符
    const levelMap: { [key: string]: string } = {
      'INFO': 'I',
      'WARN': 'W', 
      'ERROR': 'E',
      'DEBUG': 'D',
      'TRACE': 'T'
    }
    return levelMap[level.toUpperCase()] || level.charAt(0)
  }
  return level
}

const formatModule = (module: string) => {
  if (props.compact) {
    // 紧凑模式：缩短模块名
    if (module.length > 8) {
      return module.substring(0, 6) + '..'
    }
    return module
  }
  return module
}

onMounted(() => {
  connectToLogStream()
})

onUnmounted(() => {
  disconnectFromLogStream()
})
</script>

<style scoped>
.real-time-log {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
  padding-bottom: 10px;
  border-bottom: 1px solid #eee;
}

.controls {
  display: flex;
  gap: 10px;
}

.controls button {
  padding: 5px 15px;
  border: 1px solid #ddd;
  background: #f5f5f5;
  cursor: pointer;
  border-radius: 4px;
}

.log-container {
  flex: 1;
  overflow-y: auto;
  border: 1px solid #ddd;
  border-radius: 4px;
  padding: 10px;
  background: #f8f9fa;
  font-family: 'Courier New', monospace;
  font-size: 12px;
  max-height: 400px;
}

.log-entry {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 2px 0;
  border-bottom: 1px solid #eee;
}

.log-entry:last-child {
  border-bottom: none;
}

.log-entry.compact {
  padding: 2px 8px;
  gap: 6px;
  font-size: 11px;
}

.timestamp {
  color: #666;
  min-width: 80px;
  text-align: left;
}

.log-entry.compact .timestamp {
  min-width: 50px;
  font-size: 10px;
  flex-shrink: 0;
}

.log-entry.compact .level {
  min-width: 12px;
  font-size: 10px;
  font-weight: bold;
  flex-shrink: 0;
}

.log-entry.compact .module {
  min-width: 50px;
  max-width: 60px;
  font-size: 10px;
  color: #6c757d;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-entry.compact .message {
  flex: 1;
  font-size: 11px;
  line-height: 1.2;
  word-break: break-word;
}

.level {
  min-width: 60px;
  font-weight: bold;
  text-align: left;
}

.level-error {
  color: #dc3545;
}

.level-warn {
  color: #ffc107;
}

.level-info {
  color: #17a2b8;
}

.level-debug {
  color: #6c757d;
}

.module {
  min-width: 120px;
  color: #495057;
  text-align: left;
}

.message {
  flex: 1;
  color: #212529;
  text-align: left;
}

.no-logs {
  text-align: left;
  color: #6c757d;
  padding: 20px;
}
</style>