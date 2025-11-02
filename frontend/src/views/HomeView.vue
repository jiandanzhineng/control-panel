<template>
  <div class="home-page">
    <el-card shadow="never" class="welcome-card">
      <template #header>
        <div class="card-header">
          <el-icon class="header-icon"><Monitor /></el-icon>
          <span>智能控制系统</span>
        </div>
      </template>
      <div class="welcome-content">
        <h2>欢迎使用智能控制系统</h2>
        <p>这是一个简单而强大的设备管理和游戏控制平台</p>
      </div>
    </el-card>

    <el-row :gutter="20" class="feature-cards">
      <el-col :xs="24" :sm="12" :md="8">
        <el-card shadow="hover" class="feature-card" @click="$router.push('/')">
          <div class="feature-content">
            <el-icon class="feature-icon"><Monitor /></el-icon>
            <h3>设备管理</h3>
            <p>管理和监控所有连接的设备</p>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="8">
        <el-card shadow="hover" class="feature-card" @click="$router.push('/games')">
          <div class="feature-content">
            <el-icon class="feature-icon"><VideoPlay /></el-icon>
            <h3>游戏管理</h3>
            <p>启动和管理各种游戏模式</p>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="8">
        <el-card shadow="hover" class="feature-card" @click="$router.push('/network')">
          <div class="feature-content">
            <el-icon class="feature-icon"><Connection /></el-icon>
            <h3>网络设置</h3>
            <p>配置网络连接和通信设置</p>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="info-card">
      <template #header>
        <span>系统信息</span>
      </template>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="系统版本">v1.0.0</el-descriptions-item>
        <el-descriptions-item label="运行状态">
          <el-tag type="success">正常运行</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="最后更新">{{ new Date().toLocaleDateString() }}</el-descriptions-item>
        <el-descriptions-item label="在线设备">
          <el-tag type="info">0 台</el-tag>
        </el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { Monitor, VideoPlay, Connection } from '@element-plus/icons-vue'
</script>

<style scoped>
.home-page {
  padding: 0;
}

.welcome-card {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 600;
}

.header-icon {
  font-size: 20px;
  color: #409eff;
}

.welcome-content {
  text-align: center;
  padding: 20px 0;
}

.welcome-content h2 {
  margin: 0 0 10px 0;
  color: #303133;
  font-size: 24px;
}

.welcome-content p {
  margin: 0;
  color: #606266;
  font-size: 16px;
}

.feature-cards {
  margin-bottom: 20px;
}

.feature-card {
  cursor: pointer;
  transition: transform 0.2s ease;
  height: 100%;
}

.feature-card:hover {
  transform: translateY(-2px);
}

.feature-content {
  text-align: center;
  padding: 20px 10px;
}

.feature-icon {
  font-size: 32px;
  color: #409eff;
  margin-bottom: 12px;
}

.feature-content h3 {
  margin: 0 0 8px 0;
  color: #303133;
  font-size: 18px;
}

.feature-content p {
  margin: 0;
  color: #606266;
  font-size: 14px;
}

.info-card {
  margin-bottom: 20px;
}

/* 响应式设计 */
@media (max-width: 768px) {
  .home-page {
    padding: 0;
  }
  
  .welcome-card {
    margin-bottom: 16px;
  }
  
  .feature-cards {
    margin-bottom: 16px;
  }
  
  .feature-cards .el-col {
    margin-bottom: 12px;
  }
  
  .feature-content {
    padding: 20px 12px;
  }
  
  .feature-icon {
    font-size: 28px;
    margin-bottom: 10px;
  }
  
  .feature-content h3 {
    font-size: 16px;
    margin-bottom: 6px;
  }
  
  .feature-content p {
    font-size: 13px;
    line-height: 1.4;
  }
  
  .welcome-content {
    padding: 16px 0;
  }
  
  .welcome-content h2 {
    font-size: 20px;
    margin-bottom: 8px;
  }
  
  .welcome-content p {
    font-size: 14px;
  }
  
  .card-header {
    font-size: 16px;
  }
  
  .header-icon {
    font-size: 18px;
  }
  
  .info-card {
    margin-bottom: 16px;
  }
}

@media (max-width: 480px) {
  .welcome-card {
    margin-bottom: 12px;
  }
  
  .feature-cards {
    margin-bottom: 12px;
  }
  
  .feature-cards .el-col {
    margin-bottom: 8px;
  }
  
  .feature-content {
    padding: 16px 8px;
  }
  
  .feature-icon {
    font-size: 24px;
    margin-bottom: 8px;
  }
  
  .feature-content h3 {
    font-size: 15px;
    margin-bottom: 4px;
  }
  
  .feature-content p {
    font-size: 12px;
  }
  
  .welcome-content {
    padding: 12px 0;
  }
  
  .welcome-content h2 {
    font-size: 18px;
    margin-bottom: 6px;
  }
  
  .welcome-content p {
    font-size: 13px;
  }
  
  .card-header {
    font-size: 15px;
  }
  
  .header-icon {
    font-size: 16px;
  }
}
</style>