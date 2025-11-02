<template>
  <div id="app">
    <div class="app-container">
      <!-- 左侧导航栏 -->
      <div 
        class="sidebar"
        :class="{ 'sidebar-collapsed': isCollapsed }"
        :style="{ width: isCollapsed ? '64px' : '200px' }"
      >
        <div class="sidebar-header">
          <div v-if="!isCollapsed" class="logo">
            <span>控制面板</span>
          </div>
          <el-button 
            :icon="isCollapsed ? Expand : Fold" 
            @click="toggleSidebar"
            class="toggle-btn"
            text
          />
        </div>
        
        <el-menu
          :default-active="$route.path"
          class="sidebar-menu"
          :collapse="isCollapsed"
          :collapse-transition="false"
          router
        >
          <el-menu-item index="/home">
            <el-icon><HomeFilled /></el-icon>
            <template #title>首页</template>
          </el-menu-item>
          
          <el-menu-item index="/devices">
            <el-icon><Monitor /></el-icon>
            <template #title>设备管理</template>
          </el-menu-item>
          
          <el-menu-item index="/games">
            <el-icon><VideoPlay /></el-icon>
            <template #title>游戏管理</template>
          </el-menu-item>
          
          <el-menu-item index="/games/current">
            <el-icon><Present /></el-icon>
            <template #title>当前游戏</template>
          </el-menu-item>
          
          <el-menu-item index="/network">
            <el-icon><Connection /></el-icon>
            <template #title>网络设置</template>
          </el-menu-item>
          
          <el-menu-item index="/logs">
            <el-icon><Document /></el-icon>
            <template #title>日志管理</template>
          </el-menu-item>
        </el-menu>
      </div>

      <!-- 主内容区域 -->
      <div class="main-container" :style="{ marginLeft: isCollapsed ? '64px' : '200px' }">
        <!-- 顶部工具栏 -->
        <div class="main-header">
          <div class="header-content">
            <!-- 移动端菜单按钮 -->
            <el-button 
              v-if="isMobile"
              :icon="Menu" 
              @click="toggleSidebar"
              class="mobile-menu-btn"
              text
            />
            <el-breadcrumb separator="/">
              <el-breadcrumb-item :to="{ path: '/home' }">首页</el-breadcrumb-item>
              <el-breadcrumb-item v-if="$route.meta.title && $route.path !== '/home'">{{ $route.meta.title }}</el-breadcrumb-item>
            </el-breadcrumb>
          </div>
        </div>

        <!-- 主要内容 -->
        <div class="main-content">
          <router-view />
        </div>
      </div>
    </div>

    <!-- 移动端遮罩层 -->
    <div 
      v-if="isMobile && !isCollapsed" 
      class="mobile-overlay"
      @click="toggleSidebar"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { Monitor, VideoPlay, Connection, Expand, Fold, HomeFilled, Present, Menu, Document } from '@element-plus/icons-vue'

const isCollapsed = ref(false)
const isMobile = ref(false)

const checkMobile = () => {
  isMobile.value = window.innerWidth <= 768
  if (isMobile.value) {
    isCollapsed.value = true
  }
}

const toggleSidebar = () => {
  isCollapsed.value = !isCollapsed.value
}

onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
})

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile)
})
</script>

<style>
/* 全局样式重置 */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body {
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
}

#app {
  height: 100vh;
  margin: 0;
  padding: 0;
}
</style>

<style scoped>
.app-container {
  height: 100vh;
  position: relative;
  margin: 0;
  padding: 0;
}

.sidebar {
  background-color: #304156;
  transition: width 0.3s ease;
  height: 100vh;
  overflow-y: auto;
  position: fixed;
  top: 0;
  left: 0;
  z-index: 1000;
}

.sidebar-collapsed {
  width: 64px !important;
}

.sidebar-header {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid #434a50;
}

.logo {
  color: #fff;
  font-size: 18px;
  font-weight: bold;
  white-space: nowrap;
  overflow: hidden;
}

.toggle-btn {
  color: #fff !important;
  padding: 8px !important;
  min-height: auto !important;
}

.toggle-btn:hover {
  background-color: rgba(255, 255, 255, 0.1) !important;
}

.sidebar-menu {
  border: none;
  background-color: transparent;
}

.sidebar-menu .el-menu-item {
  color: #bfcbd9;
  border-bottom: 1px solid #434a50;
}

.sidebar-menu .el-menu-item:hover {
  background-color: #434a50;
  color: #fff;
}

.sidebar-menu .el-menu-item.is-active {
  background-color: #409eff;
  color: #fff;
}

.main-container {
  width: 100%;
  height: 100vh;
  background-color: #f0f2f5;
  transition: margin-left 0.3s ease;
  display: flex;
  flex-direction: column;
}

.main-header {
  background-color: #fff;
  border-bottom: 1px solid #e6e6e6;
  padding: 0 16px;
  height: 60px;
  display: flex;
  align-items: center;
  box-shadow: 0 1px 4px rgba(0, 21, 41, 0.08);
  flex-shrink: 0;
  margin: 0;
}

.header-content {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
}

.mobile-menu-btn {
  color: #606266 !important;
  padding: 8px !important;
  min-height: auto !important;
}

.mobile-menu-btn:hover {
  background-color: rgba(0, 0, 0, 0.05) !important;
}

.main-content {
  padding: 16px;
  background-color: #f0f2f5;
  flex: 1;
  overflow-y: auto;
  margin: 0;
}

.mobile-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  z-index: 999;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .sidebar {
    transition: transform 0.3s ease, width 0.3s ease;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.15);
    width: 240px !important;
  }
  
  .sidebar.sidebar-collapsed {
    transform: translateX(-100%);
  }
  
  .sidebar:not(.sidebar-collapsed) {
    transform: translateX(0);
  }
  
  .main-container {
    margin-left: 0 !important;
  }
  
  .main-header {
    padding: 0 12px;
    height: 56px;
  }
  
  .main-content {
    padding: 0;
    margin: 0;
  }
  
  .sidebar-header {
    height: 56px;
    padding: 0 12px;
  }
  
  .logo {
    font-size: 16px;
  }
  
  .toggle-btn {
    padding: 12px !important;
  }
  
  .sidebar-menu .el-menu-item {
    height: 48px;
    line-height: 48px;
    font-size: 14px;
  }
}

@media (max-width: 480px) {
  .main-content {
    padding: 0;
    margin: 0;
  }
  
  .main-header {
    padding: 0 8px;
    height: 52px;
  }
  
  .sidebar:not(.sidebar-collapsed) {
    width: 220px !important;
  }
  
  .sidebar-header {
    padding: 0 8px;
    height: 52px;
  }
  
  .sidebar-menu .el-menu-item {
    height: 44px;
    line-height: 44px;
    font-size: 13px;
    padding-left: 16px !important;
  }
  
  .logo {
    font-size: 15px;
  }
}
</style>
