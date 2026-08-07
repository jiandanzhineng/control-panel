<script setup lang="ts">
import { computed } from 'vue'
import { Moon, Sunny, Monitor } from '@element-plus/icons-vue'
import { useTheme, type ThemeMode } from '../composables/useTheme'

const props = defineProps<{ compact?: boolean }>()

const { mode, setMode } = useTheme()

const OPTIONS: Array<{ value: ThemeMode; label: string; icon: any }> = [
  { value: 'dark', label: '黑夜', icon: Moon },
  { value: 'light', label: '白天', icon: Sunny },
  { value: 'auto', label: '自动', icon: Monitor },
]

const activeIndex = computed(() => OPTIONS.findIndex(o => o.value === mode.value))
</script>

<template>
  <div class="theme-switch" :class="{ 'is-compact': props.compact }" role="group" aria-label="主题切换">
    <span class="theme-switch__thumb" :style="{ transform: `translateX(${activeIndex * 100}%)` }" />
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

/* 紧凑模式：只显示图标，按钮等宽 */
.theme-switch.is-compact .theme-switch__btn {
  padding: 5px 6px;
}

@media (max-width: 768px) {
  .theme-switch__label {
    display: none;
  }
}
</style>

