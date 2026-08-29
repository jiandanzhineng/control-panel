import { computed, ref } from 'vue'
import { elementPlusLocales, persistLocalePref } from './index'
import {
  type LocalePreference,
  readStoredLocalePref,
  resolveLocale,
} from './locale'

const preference = ref<LocalePreference>(readStoredLocalePref())

export function useLocale() {
  const appLocale = computed(() => resolveLocale(preference.value))
  const elementLocale = computed(() => elementPlusLocales[appLocale.value])

  async function setPreference(next: LocalePreference) {
    preference.value = next
    persistLocalePref(next)
    if (!window.windowApi) return
    const settings = await window.windowApi.getSettings()
    await window.windowApi.setSettings({ ...settings, locale: next })
  }

  async function initFromDesktop() {
    if (!window.windowApi) return
    try {
      const settings = await window.windowApi.getSettings()
      const next = settings.locale || readStoredLocalePref()
      preference.value = next
      persistLocalePref(next)
    } catch {
      /* ignore */
    }
  }

  return { preference, appLocale, elementLocale, setPreference, initFromDesktop }
}
