import type { AppLocale } from './locale'

type PlayI18nPack = {
  title?: string
  description?: string
  howTo?: string
  devices?: Record<string, string>
  params?: Record<string, string>
  enumLabels?: Record<string, Record<string, string>>
  paramDescriptions?: Record<string, string>
  paramUnits?: Record<string, string>
}

export type PlayLike = {
  title?: string
  name?: string
  description?: string
  howTo?: string
  devices?: Array<{ id?: string; label?: string; [key: string]: unknown }>
  params?: Array<{ key?: string; label?: string; [key: string]: unknown }>
  i18n?: Record<string, PlayI18nPack | undefined>
  [key: string]: unknown
}

export function localizePlay<T extends PlayLike>(play: T, locale: AppLocale): T {
  const pack = play.i18n?.[locale]
  if (!pack) return play
  const title = pack.title || play.title || play.name
  const devices = Array.isArray(play.devices)
    ? play.devices.map((device) => {
        const id = String(device.id || '')
        const label = id && pack.devices?.[id]
        return label ? { ...device, label } : device
      })
    : play.devices
  const params = Array.isArray(play.params)
    ? play.params.map((param) => {
        const key = String(param.key || '')
        const label = key && pack.params?.[key]
        const enumLabels = key && pack.enumLabels?.[key]
        const description = key && pack.paramDescriptions?.[key]
        const unit = key && pack.paramUnits?.[key]
        if (!label && !enumLabels && !description && !unit) return param
        return {
          ...param,
          ...(label ? { label } : {}),
          ...(enumLabels ? { enumLabels } : {}),
          ...(description ? { description } : {}),
          ...(unit ? { unit } : {}),
        }
      })
    : play.params
  return {
    ...play,
    title,
    name: title,
    description: pack.description ?? play.description,
    howTo: pack.howTo ?? play.howTo,
    devices,
    params,
  }
}
