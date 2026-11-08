// manifest 参数显隐：hidden / visibleWhen 的纯函数实现，配置页与运行面板共用。

export interface VisibleWhenRule {
  key?: string
  equals?: unknown | unknown[]
  gt?: number
}

export interface ParamSchemaLike {
  key?: string
  hidden?: boolean
  visibleWhen?: VisibleWhenRule
  default?: unknown
  [field: string]: unknown
}

function equalsValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((item) => equalsValue(actual, item))
  if (Object.is(actual, expected)) return true
  // 表单里的数字/枚举值可能以字符串形态出现，基础类型按字符串等价比较。
  if (actual == null || expected == null) return false
  return ['string', 'number', 'boolean'].includes(typeof actual)
    && ['string', 'number', 'boolean'].includes(typeof expected)
    && String(actual) === String(expected)
}

export function matchesVisibleWhen(param: ParamSchemaLike, values: Record<string, any> | null | undefined): boolean {
  const rule = param?.visibleWhen
  if (!rule || typeof rule !== 'object') return true
  const key = String(rule.key || '')
  if (!key) return true
  const actual = values?.[key]
  if (Object.prototype.hasOwnProperty.call(rule, 'equals') && !equalsValue(actual, rule.equals)) return false
  if (Object.prototype.hasOwnProperty.call(rule, 'gt')) {
    if (actual === undefined || actual === null || actual === '') return false
    const n = Number(actual)
    if (!Number.isFinite(n) || n <= Number(rule.gt)) return false
  }
  return true
}

// hidden 参数永远不显示；visibleWhen 不满足时只影响显示，不修改参数值。
export function isParamVisible(param: ParamSchemaLike, values: Record<string, any> | null | undefined): boolean {
  if (param?.hidden === true) return false
  return matchesVisibleWhen(param, values)
}

export function visibleParams<T extends ParamSchemaLike>(
  params: T[] | null | undefined,
  values: Record<string, any> | null | undefined,
): T[] {
  return (Array.isArray(params) ? params : []).filter((param) => isParamVisible(param, values))
}

// 启动时 hidden 参数一律回落到 manifest 默认值（忽略保存过的旧值）。
export function hiddenDefaultOverrides(
  params: ParamSchemaLike[] | null | undefined,
  values: Record<string, any> | null | undefined,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {}
  for (const param of Array.isArray(params) ? params : []) {
    if (!param || param.hidden !== true || !param.key) continue
    if (Object.prototype.hasOwnProperty.call(param, 'default')) overrides[param.key] = param.default
    else if (values && Object.prototype.hasOwnProperty.call(values, param.key)) overrides[param.key] = values[param.key]
  }
  return overrides
}

export function withHiddenDefaults<T extends Record<string, any>>(
  params: ParamSchemaLike[] | null | undefined,
  values: T,
): T {
  return { ...values, ...hiddenDefaultOverrides(params, values) } as T
}
