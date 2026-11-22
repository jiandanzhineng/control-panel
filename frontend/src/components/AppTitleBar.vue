<template>
  <header class="app-titlebar" :class="{ 'has-native-controls': customTitleBar }">
    <button
      type="button"
      class="tb-icon-btn"
      :title="collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')"
      :aria-label="collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')"
      @click="emit('toggle-sidebar')"
    >
      <el-icon :size="15">
        <component :is="collapsed ? Expand : Fold" />
      </el-icon>
    </button>

    <div class="tb-brand">
      <!-- 应用图标（assets/icon-small.svg 渲染的 32px 版），与任务栏图标一致 -->
      <img class="tb-logo" src="/brand-mark.png" width="18" height="18" alt="" aria-hidden="true" />
      <span class="tb-brand-name">{{ t('app.name') }}</span>
    </div>

    <span class="tb-divider" aria-hidden="true" />

    <nav class="tb-breadcrumb" :aria-label="t('shell.breadcrumb')">
      <a
        href="#"
        class="tb-crumb"
        :class="{ 'is-current': route.path === '/home' }"
        @click.prevent="goHome"
      >{{ t('nav.home') }}</a>
      <template v-if="routeTitle && route.path !== '/home'">
        <span class="tb-sep" aria-hidden="true">/</span>
        <span class="tb-crumb is-current">{{ routeTitle }}</span>
      </template>
    </nav>

    <el-tooltip v-if="agentLease" placement="bottom" :show-after="150">
      <template #content>
        <div class="agent-lease-tip">
          <div class="agent-lease-tip__title">{{ t('agentLease.title') }}</div>
          <div class="agent-lease-tip__row">{{ t('agentLease.defaultLimit') }}: {{ agentLease.limits.default }}%</div>
          <div v-for="[key, pct] in agentCapabilityRows" :key="key" class="agent-lease-tip__row">
            {{ capabilityLabel(key) }}: {{ pct }}%
          </div>
        </div>
      </template>
      <div class="tb-agent-badge" role="status">
        <span class="tb-agent-dot" aria-hidden="true" />
        <span>{{ t('agentLease.active', { limit: agentLease.limits.default }) }}</span>
      </div>
    </el-tooltip>

    <div class="tb-drag-space" aria-hidden="true" />
  </header>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { Expand, Fold } from '@element-plus/icons-vue'
import { useTheme } from '../composables/useTheme'
import { useAgentLease } from '../composables/useAgentLease'
import { router } from '../router'

defineProps<{ collapsed: boolean }>()
const emit = defineEmits<{ (e: 'toggle-sidebar'): void }>()

const { t } = useI18n()
const route = useRoute()
const { resolved } = useTheme()
const { lease: agentLease } = useAgentLease()

const CAPABILITY_ORDER = ['strength', 'shock', 'vibration', 'suction', 'estim', 'motors', 'pump']
const agentCapabilityRows = computed(() => {
  const caps = agentLease.value?.limits.capabilities || {}
  return CAPABILITY_ORDER
    .filter((key) => caps[key] !== undefined)
    .map((key) => [key, caps[key]] as const)
})

function capabilityLabel(key: string) {
  return t(`agentLease.capabilities.${key}`)
}

// Electron Windows 壳：右上角原生按钮区需要前端让出空间
const customTitleBar = !!(window as any).windowApi?.customTitleBar

const routeTitle = computed(() => {
  const key = String(route.meta.titleKey || '')
  return key ? t(key) : ''
})

function goHome() {
  if (route.path !== '/home') router.push('/home')
}

function readCssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// 把当前主题的标题栏配色同步给 Electron 原生按钮区（非 Electron 环境静默跳过）
function syncTitleBarTheme() {
  const api = (window as any).windowApi
  if (!api || typeof api.setTitleBarTheme !== 'function') return
  const color = readCssVar('--bg-app')
  const symbolColor = readCssVar('--text-muted')
  if (!color) return
  Promise.resolve(api.setTitleBarTheme({ color, symbolColor })).catch(() => {})
}

onMounted(() => {
  nextTick(syncTitleBarTheme)
})

watch(resolved, () => {
  nextTick(syncTitleBarTheme)
})
</script>

<style scoped>
.app-titlebar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  background: var(--bg-app);
  border-bottom: 1px solid var(--border-subtle);
  z-index: 1100;
  -webkit-app-region: drag;
  user-select: none;
}

/* 给原生最小化/最大化/关闭按钮留出位置 */
.app-titlebar.has-native-controls {
  padding-right: 140px;
}

.tb-icon-btn {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
  -webkit-app-region: no-drag;
}

.tb-icon-btn:hover {
  background: var(--hover-overlay);
  color: var(--text-primary);
}

.tb-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.tb-logo {
  display: block;
  flex: 0 0 auto;
}

.tb-brand-name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--text-primary);
  white-space: nowrap;
}

.tb-divider {
  width: 1px;
  height: 14px;
  flex: 0 0 auto;
  margin: 0 12px;
  background: var(--border-subtle);
}

.tb-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text-muted);
  white-space: nowrap;
  -webkit-app-region: no-drag;
}

.tb-crumb {
  color: var(--text-muted);
  text-decoration: none;
}

a.tb-crumb {
  cursor: pointer;
  transition: color 0.15s ease;
}

a.tb-crumb:hover {
  color: var(--accent);
}

.tb-crumb.is-current {
  color: var(--text-primary);
}

.tb-sep {
  color: var(--text-faint);
}

.tb-drag-space {
  flex: 1 1 auto;
  min-width: 12px;
  height: 100%;
}

.tb-agent-badge {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 9px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
  -webkit-app-region: no-drag;
  cursor: default;
}

.tb-agent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent);
  animation: agent-dot-pulse 2s ease-out infinite;
}

@keyframes agent-dot-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); }
  70% { box-shadow: 0 0 0 5px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

.agent-lease-tip {
  min-width: 132px;
  line-height: 1.6;
  font-size: 12px;
}

.agent-lease-tip__title {
  font-weight: 600;
  margin-bottom: 2px;
}

.agent-lease-tip__row {
  opacity: 0.9;
}

@media (prefers-reduced-motion: reduce) {
  .tb-agent-dot { animation: none; }
}

/* 窄窗口：面包屑可收缩省略，不滑进系统按钮区 */
.tb-breadcrumb {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .app-titlebar {
    padding: 0 10px;
    gap: 6px;
  }

  .tb-divider {
    margin: 0 8px;
  }
}
</style>
