import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

export type ThemeMode = 'dark' | 'light' | 'auto'
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'app-theme'

const mode = ref<ThemeMode>((localStorage.getItem(STORAGE_KEY) as ThemeMode) || 'auto')
const systemDark = ref(true)

let mediaQuery: MediaQueryList | null = null
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null

function resolveTheme(): ResolvedTheme {
  if (mode.value === 'auto') return systemDark.value ? 'dark' : 'light'
  return mode.value
}

const resolved = computed<ResolvedTheme>(resolveTheme)

function applyTheme() {
  document.documentElement.dataset.theme = resolved.value
}

watch(resolved, applyTheme)

export function useTheme() {
  const init = () => {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    systemDark.value = mediaQuery.matches
    mediaListener = (e: MediaQueryListEvent) => { systemDark.value = e.matches }
    mediaQuery.addEventListener('change', mediaListener)
    applyTheme()
  }

  const dispose = () => {
    if (mediaQuery && mediaListener) {
      mediaQuery.removeEventListener('change', mediaListener)
    }
  }

  const setMode = (m: ThemeMode) => {
    mode.value = m
    localStorage.setItem(STORAGE_KEY, m)
  }

  return { mode, resolved, setMode, init, dispose }
}
