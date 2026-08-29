export const SUPPORTED_LOCALES = ['zh', 'en'] as const
export type AppLocale = (typeof SUPPORTED_LOCALES)[number]
export type LocalePreference = AppLocale | 'system'

export const LOCALE_STORAGE_KEY = 'app-locale'
export const DEFAULT_LOCALE: AppLocale = 'zh'

export function isAppLocale(value: unknown): value is AppLocale {
  return value === 'zh' || value === 'en'
}

export function detectSystemLocale(language = typeof navigator === 'undefined' ? '' : navigator.language): AppLocale {
  return String(language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function resolveLocale(pref: LocalePreference | null | undefined, language?: string): AppLocale {
  if (isAppLocale(pref)) return pref
  return detectSystemLocale(language)
}

export function localeTag(locale: AppLocale): string {
  return locale === 'en' ? 'en-US' : 'zh-CN'
}

export function readStoredLocalePref(): LocalePreference {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (raw === 'system' || isAppLocale(raw)) return raw
  } catch {
    /* ignore */
  }
  return 'system'
}

export function writeStoredLocalePref(pref: LocalePreference) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, pref)
  } catch {
    /* ignore */
  }
}
