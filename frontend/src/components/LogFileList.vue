<template>
  <div class="log-file-list">
    <div class="file-header">
      <h3>历史日志文件</h3>
      <button @click="refreshFiles" :disabled="loading">
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </div>

    <div v-if="loading" class="loading">
      加载中...
    </div>

    <div v-else-if="files.length === 0" class="no-files">
      暂无日志文件
    </div>

    <div v-else class="file-list">
      <div 
        v-for="file in files" 
        :key="file.filename" 
        class="file-item"
      >
        <div class="file-icon">📄</div>
        <div class="file-info">
          <div class="file-name">{{ file.filename }}</div>
          <div class="file-details">
            <span class="file-size">{{ formatFileSize(file.size) }}</span>
            <span class="file-date">{{ formatDate(file.lastModified) }}</span>
          </div>
        </div>
        <div class="file-actions">
          <button @click="downloadFile(file.filename)" class="download-btn">
            下载
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

interface LogFile {
  filename: string
  size: number
  date: string
  lastModified: string
}

const files = ref<LogFile[]>([])
const loading = ref(false)

const fetchFiles = async () => {
  loading.value = true
  try {
    const response = await fetch('http://localhost:3000/api/logs/files')
    const data = await response.json()
    files.value = data.files || []
  } catch (error) {
    console.error('获取日志文件列表失败:', error)
  } finally {
    loading.value = false
  }
}

const refreshFiles = () => {
  fetchFiles()
}

const downloadFile = (filename: string) => {
  const url = `http://localhost:3000/api/logs/download/${filename}`
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleString()
}

onMounted(() => {
  fetchFiles()
})
</script>

<style scoped>
.log-file-list {
  height: 100%;
}

.file-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
  padding-bottom: 10px;
  border-bottom: 1px solid #eee;
}

.file-header button {
  padding: 5px 15px;
  border: 1px solid #ddd;
  background: #f5f5f5;
  cursor: pointer;
  border-radius: 4px;
}

.file-header button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.loading, .no-files {
  text-align: center;
  color: #6c757d;
  padding: 40px 20px;
}

.file-list {
  border: 1px solid #ddd;
  border-radius: 4px;
  overflow: hidden;
}

.file-item {
  display: flex;
  align-items: center;
  padding: 15px;
  border-bottom: 1px solid #eee;
  transition: background-color 0.2s;
}

.file-item:last-child {
  border-bottom: none;
}

.file-item:hover {
  background-color: #f8f9fa;
}

.file-icon {
  font-size: 24px;
  margin-right: 15px;
}

.file-info {
  flex: 1;
}

.file-name {
  font-weight: 500;
  color: #212529;
  margin-bottom: 5px;
}

.file-details {
  display: flex;
  gap: 15px;
  font-size: 12px;
  color: #6c757d;
}

.file-actions {
  margin-left: 15px;
}

.download-btn {
  padding: 5px 15px;
  border: 1px solid #007bff;
  background: #007bff;
  color: white;
  cursor: pointer;
  border-radius: 4px;
  font-size: 12px;
}

.download-btn:hover {
  background: #0056b3;
  border-color: #0056b3;
}
</style>