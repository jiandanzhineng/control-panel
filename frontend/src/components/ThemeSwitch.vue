<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Moon, Sunny, Monitor } from '@element-plus/icons-vue'
import { useTheme, type ThemeMode } from '../composables/useTheme'

const props = defineProps<{ compact?: boolean }>()
const { t } = useI18n()

const { mode, setMode } = useTheme()

const OPTIONS = computed(() => [
  { value: 'dark' as ThemeMode, label: t('theme.dark'), icon: Moon },
  { value: 'light' as ThemeMode, label: t('theme.light'), icon: Sunny },
  { value: 'auto' as ThemeMode, label: t('theme.auto'), icon: Monitor },
])

const activeIndex = computed(() => OPTIONS.value.findIndex(o => o.value === mode.value))
</script>

<template>
  <div class="theme-switch" :class="{ 'is-compact': props.compact }" role="group" :aria-label="t('theme.switch')">
    <span class="theme-switch__thumb" :style="{ '--idx': activeIndex }" />
    <button
      v-for="opt in OPTIONS"
      :key="opt.value"
      type="button"
      class="theme-switch__btn"
      :class="{ 'is-active': mode === opt.value }"
      :aria-pressed="mode === opt.value"
      :title="opt.label"
      @click="setMode(opt.value)"
    >
      <el-icon :size="15"><component :is="opt.icon" /></el-icon>
      <span v-if="!props.compact" class="theme-switch__label">{{ opt.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.theme-switch {
  position: relative;
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  background: var(--bg-elevated);
}

.theme-switch__thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  bottom: 3px;
  width: calc((100% - 6px) / 3);
  border-radius: 999px;
  background: var(--accent-glow);
  border: 1px solid var(--accent);
  transition: transform 0.25s ease;
  pointer-events: none;
  transform: translateX(calc(var(--idx, 0) * 100%));
}

.theme-switch__btn {
  position: relative;
  z-index: 1;
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 5px 8px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  border-radius: 999px;
  transition: color 0.2s ease;
  white-space: nowrap;
}

.theme-switch__btn:hover {
  color: var(--text-primary);
  background: transparent;
  border: none;
}

.theme-switch__btn.is-active {
  color: var(--accent);
}

/* 紧凑模式：只显示图标，竖排以适配折叠侧边栏 */
.theme-switch.is-compact {
  flex-direction: column;
}

.theme-switch.is-compact .theme-switch__btn {
  width: 100%;
  padding: 5px 6px;
}

.theme-switch.is-compact .theme-switch__thumb {
  top: 3px;
  left: 3px;
  right: 3px;
  bottom: auto;
  width: calc(100% - 6px);
  height: calc((100% - 6px) / 3);
  transform: translateY(calc(var(--idx, 0) * 100%));
}

@media (max-width: 768px) {
  .theme-switch__label {
    display: none;
  }
}
</style>

