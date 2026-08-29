import { createI18n } from 'vue-i18n'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import en from 'element-plus/es/locale/lang/en'
import type { Language } from 'element-plus/es/locale'
import zh from './locales/zh'
import enMessages from './locales/en'
import {
  DEFAULT_LOCALE,
  type AppLocale,
  type LocalePreference,
  readStoredLocalePref,
  resolveLocale,
  writeStoredLocalePref,
} from './locale'

export const elementPlusLocales: Record<AppLocale, Language> = {
  zh: zhCn,
  en,
}

const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  missingWarn: false,
  fallbackWarn: false,
  messages: {
    zh,
    en: enMessages,
  },
})

export function getI18n() {
  return i18n
}

export function currentLocale(): AppLocale {
  const locale = String(i18n.global.locale.value)
  return locale === 'en' ? 'en' : 'zh'
}

export function applyLocale(locale: AppLocale) {
  i18n.global.locale.value = locale
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN'
  }
}

export function persistLocalePref(pref: LocalePreference) {
  writeStoredLocalePref(pref)
  applyLocale(resolveLocale(pref))
}

export function bootstrapLocale(pref?: LocalePreference | null) {
  const resolved = resolveLocale(pref ?? readStoredLocalePref())
  applyLocale(resolved)
  return resolved
}

export default i18n
