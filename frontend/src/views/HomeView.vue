<template>
  <div class="home-page">
    <div class="welcome-section">
      <h2 class="welcome-title">控制面板</h2>
      <p class="welcome-desc">硅基之下 · 设备管理与控制中心</p>
    </div>

    <el-row :gutter="16" class="feature-cards">
      <el-col :xs="24" :sm="8">
        <el-card shadow="hover" class="feature-card" @click="$router.push('/devices')">
          <div class="feature-content">
            <el-icon class="feature-icon" color="#409eff"><Monitor /></el-icon>
            <h3>设备管理</h3>
            <p>管理和监控所有连接的设备</p>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="8">
        <el-card shadow="hover" class="feature-card" @click="$router.push('/games')">
          <div class="feature-content">
            <el-icon class="feature-icon" color="#67c23a"><VideoPlay /></el-icon>
            <h3>游戏管理</h3>
            <p>启动和管理各种游戏模式</p>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="8">
        <el-card shadow="hover" class="feature-card" @click="$router.push('/network')">
          <div class="feature-content">
            <el-icon class="feature-icon" color="#e6a23c"><Connection /></el-icon>
            <h3>网络设置</h3>
            <p>配置网络连接和通信设置</p>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="info-card">
      <template #header>
        <div class="info-header">
          <el-icon><InfoFilled /></el-icon>
          <span>系统信息</span>
        </div>
      </template>
      <el-descriptions :column="2" border class="info-list" :size="'default'">
        <el-descriptions-item label="在线设备">
          <el-tag type="info" effect="plain">{{ onlineCount }} 台</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="当前版本">
          <el-tag type="success" effect="plain">v{{ frontendVersion }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="淘宝店">
          <a href="http://guijizhixia.taobao.com/" target="_blank" class="link-text">guijizhixia.taobao.com</a>
        </el-descriptions-item>
        <el-descriptions-item label="文档地址">
          <a href="https://docs.undersilicon.cn" target="_blank" class="link-text">docs.undersilicon.cn</a>
        </el-descriptions-item>
        <el-descriptions-item label="交流QQ群" :span="2">
          <span class="info-text">970326066</span>
          <el-tag size="small" type="warning" effect="plain" style="margin-left: 8px">验证：硅基之下</el-tag>
        </el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Monitor, VideoPlay, Connection, InfoFilled } from '@element-plus/icons-vue'
import packageInfo from '../../package.json'

const frontendVersion = packageInfo.version
const onlineCount = ref(0)

onMounted(async () => {
  try {
    const res = await fetch('/api/devices')
    if (res.ok) {
      const list = await res.json()
      onlineCount.value = list.filter((d: any) => d.connected).length
    }
  } catch {}
})
</script>

<style scoped>
.home-page {
  padding: 0 16px;
  width: 100%;
  max-width: 960px;
  margin: 20px auto;
  box-sizing: border-box;
}

.welcome-section {
  text-align: center;
  margin-bottom: 24px;
}

.welcome-title {
  font-size: 24px;
  font-weight: 600;
  color: #303133;
  margin: 0 0 8px 0;
}

.welcome-desc {
  font-size: 14px;
  color: #909399;
  margin: 0;
}

.feature-cards {
  margin-bottom: 20px;
}

.feature-card {
  cursor: pointer;
  transition: all 0.3s ease;
  height: 100%;
}

.feature-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
}

.feature-content {
  text-align: center;
  padding: 24px 10px;
}

.feature-icon {
  font-size: 36px;
  margin-bottom: 14px;
}

.feature-content h3 {
  margin: 0 0 8px 0;
  color: #303133;
  font-size: 16px;
  font-weight: 600;
}

.feature-content p {
  margin: 0;
  color: #909399;
  font-size: 13px;
}

.info-card {
  margin-bottom: 20px;
}

.info-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.link-text {
  color: #409eff;
  text-decoration: none;
}

.link-text:hover {
  text-decoration: underline;
}

.info-text {
  font-weight: 600;
  color: #303133;
}

.info-list :deep(.el-descriptions__label) {
  width: 100px;
}

@media (max-width: 768px) {
  .home-page {
    padding: 0 12px;
    margin: 12px auto;
  }

  .welcome-title {
    font-size: 20px;
  }

  .feature-cards .el-col {
    margin-bottom: 12px;
  }

  .feature-content {
    padding: 16px 8px;
  }

  .feature-icon {
    font-size: 28px;
  }

  .info-list :deep(.el-descriptions__label) {
    width: 80px;
  }
}
</style>
