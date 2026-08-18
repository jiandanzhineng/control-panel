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
          :default-active="menuActive"
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

          <el-menu-item index="/plays">
            <el-icon><VideoPlay /></el-icon>
            <template #title>本地游戏</template>
          </el-menu-item>

          <el-menu-item index="/browser">
            <el-icon><Compass /></el-icon>
            <template #title>在线游戏</template>
          </el-menu-item>

          <el-menu-item index="/network">
            <el-icon><Connection /></el-icon>
            <template #title>网络设置</template>
          </el-menu-item>

          <el-menu-item index="/account">
            <el-icon><User /></el-icon>
            <template #title>账号</template>
          </el-menu-item>
          
          <el-menu-item index="/logs">
            <el-icon><Document /></el-icon>
            <template #title>日志管理</template>
          </el-menu-item>
        </el-menu>

        <!-- 左下角：客服入口 + 主题切换 -->
        <div class="sidebar-footer" :class="{ 'is-collapsed': isCollapsed }">
          <div class="support-entry" @click="router.push('/support')">
            <el-icon><Service /></el-icon>
            <span v-if="!isCollapsed" class="support-entry__label">客服</span>
          </div>
          <ThemeSwitch :compact="isCollapsed" />
        </div>
      </div>

      <!-- 主内容区域 -->
      <div class="main-container" :style="isMobile ? { marginLeft: 0 } : { marginLeft: isCollapsed ? '64px' : '200px', width: 'calc(100% - ' + (isCollapsed ? '64px' : '200px') + ')' }">
        <!-- 顶部工具栏：沉浸式页面（如在线游戏 webview）隐藏面包屑，避免与载体自带工具栏叠成多层 -->
        <div v-if="!hideHeader" class="main-header">
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
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { Monitor, VideoPlay, Connection, Expand, Fold, HomeFilled, Menu, Document, Compass, User, Service } from '@element-plus/icons-vue'
import { useAuth } from './composables/useAuth'
import { useTheme } from './composables/useTheme'
import { clearActivePlay } from './composables/useActivePlay'
import { router } from './router'
import ThemeSwitch from './components/ThemeSwitch.vue'

const { checkSession } = useAuth()
const { init: initTheme, dispose: disposeTheme } = useTheme()

const route = useRoute()
const isCollapsed = ref(false)
const isMobile = ref(false)

// GameHost 启动导航：Electron 主进程在 window.GameHost.launch 时通过 IPC 通知，
// 前端跳转到原生配置页（source=remote）。非 Electron 环境下 gameHostNav 不存在。
let disposeGameHostNav: (() => void) | null = null
let disposeLocalAppWindow: (() => void) | null = null

// 本地游戏相关页面（/plays、配置、运行）统一高亮「本地游戏」入口
const menuActive = computed(() => (route.path.startsWith('/plays') ? '/plays' : route.path))

// 沉浸式页面隐藏全局顶栏（面包屑），避免与页面自带工具栏叠加
const hideHeader = computed(() => route.path === '/browser' || route.path.startsWith('/plays/game/current'))

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
  // 主题：读取持久化选择 + 监听系统深浅色
  initTheme()
  // 启动时校验一次账号登录态（fire-and-forget，不阻塞页面）
  checkSession()
  // 监听 GameHost 启动导航（仅 Electron 壳注入）
  const nav = (window as any).gameHostNav
  if (nav && typeof nav.onNavigate === 'function') {
    disposeGameHostNav = nav.onNavigate((data: { path?: string }) => {
      if (data && typeof data.path === 'string' && data.path) {
        router.push(data.path)
      }
    })
  }
  if (window.localAppWindowApi) {
    disposeLocalAppWindow = window.localAppWindowApi.onClosed(() => {
      clearActivePlay()
    })
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile)
  disposeTheme()
  if (disposeGameHostNav) {
    disposeGameHostNav()
    disposeGameHostNav = null
  }
  if (disposeLocalAppWindow) {
    disposeLocalAppWindow()
    disposeLocalAppWindow = null
  }
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
  background-color: var(--bg-app);
  border-right: 1px solid var(--border-subtle);
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
  border-bottom: 1px solid var(--border-subtle);
}

.logo {
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
}

.toggle-btn {
  color: var(--text-muted) !important;
  padding: 8px !important;
  min-height: auto !important;
}

.toggle-btn:hover {
  color: var(--text-primary) !important;
  background-color: rgba(255, 255, 255, 0.06) !important;
}

.sidebar-menu {
  border: none;
  background-color: transparent;
  --el-menu-bg-color: transparent;
  --el-menu-text-color: var(--text-muted);
  --el-menu-hover-bg-color: rgba(255, 255, 255, 0.05);
  --el-menu-hover-text-color: var(--text-primary);
  --el-menu-active-color: var(--accent);
}

.sidebar-menu .el-menu-item {
  color: var(--text-muted);
  margin: 2px 8px;
  border-radius: var(--radius-md);
  position: relative;
}

.sidebar-menu .el-menu-item:hover {
  background-color: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}

/* 激活态：青色高亮 + 左侧点缀条 */
.sidebar-menu .el-menu-item.is-active {
  background-color: var(--accent-glow);
  color: var(--accent);
}

.sidebar-menu .el-menu-item.is-active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: 2px;
  background-color: var(--accent);
}

/* 折叠时菜单项去掉水平边距，保持图标居中 */
.sidebar-collapsed .sidebar-menu .el-menu-item {
  margin: 2px 4px;
}

/* 侧边栏吸底：菜单滚它的，底部固定主题切换 */
.sidebar {
  display: flex;
  flex-direction: column;
}
.sidebar-menu {
  flex: 1;
}

.sidebar-footer {
  padding: 10px 12px calc(10px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.support-entry {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.2s ease, background-color 0.2s ease;
}

.support-entry:hover {
  color: var(--accent);
  background-color: var(--accent-glow);
}

.support-entry__label {
  white-space: nowrap;
}

.sidebar-footer.is-collapsed .support-entry {
  padding: 8px 0;
}

.sidebar-footer.is-collapsed :deep(.theme-switch__label) {
  display: none;
}

.main-container {
  width: 100%;
  height: 100vh;
  background-color: var(--bg-app);
  transition: margin-left 0.3s ease;
  display: flex;
  flex-direction: column;
}

.main-header {
  background-color: var(--header-bg);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border-subtle);
  padding: 0 16px;
  height: 60px;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin: 0;
}

.main-header :deep(.el-breadcrumb__inner) {
  color: var(--text-muted);
}

.main-header :deep(.el-breadcrumb__inner.is-link:hover) {
  color: var(--accent);
}

.main-header :deep(.el-breadcrumb__item:last-child .el-breadcrumb__inner) {
  color: var(--text-primary);
}

.header-content {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
}

.mobile-menu-btn {
  color: var(--text-muted) !important;
  padding: 8px !important;
  min-height: auto !important;
}

.mobile-menu-btn:hover {
  color: var(--text-primary) !important;
  background-color: rgba(255, 255, 255, 0.06) !important;
}

.main-content {
  padding: 16px;
  background-color: var(--bg-app);
  flex: 1;
  overflow-y: auto;
  margin: 0;
  /* 作为绝对定位子元素（如 PlayCarrierShell 的 browser 壳 inset:0）的定位基准，
     使其相对内容区铺满而非盖到左侧 fixed 侧边栏下方 */
  position: relative;
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
