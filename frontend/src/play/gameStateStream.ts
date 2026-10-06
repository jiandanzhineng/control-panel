// 画面同步（客户端侧）：后端 SSE 推的是「状态文档 + 增量 ops」。
// 文档约定（见 docs/architecture/split-game-contract.md）：
//   { type: 'snapshot', rev, state }                     全量，rev 单调递增
//   { type: 'patch', rev, baseRev, ops }                 增量，ops 由后端 diff 生成
// 本地 rev 与 patch.baseRev 对不上（丢包 / 乱序 / 重连）时必须补一次全量，不能猜。

export interface StateEvent {
  type?: string
  rev?: number
  baseRev?: number
  ops?: StateOp[] | null
  state?: unknown
}

export interface StateOp {
  op?: string
  path?: string
  value?: unknown
  items?: unknown[]
}

export interface StreamState {
  state: unknown
  rev: number
}

// 结果里的 resync=true 表示这一帧不能应用，调用方要重新拉一次全量快照
export interface ReduceResult extends StreamState {
  changed: boolean
  resync: boolean
}

export function createStreamState(state: unknown = null, rev = 0): StreamState {
  return { state, rev: Number.isFinite(rev) ? Number(rev) : 0 }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function segmentList(path: string): string[] | null {
  if (typeof path !== 'string') return null
  if (!path) return []
  const parts = path.split('.')
  return parts.length && parts.every((part) => part.length > 0) ? parts : null
}

// 只克隆被 ops 触及的路径，其余节点保持引用（与后端 apply 的结构共享一致）
function setAt(node: any, parts: string[], value: unknown): any {
  if (!parts.length) return value
  const head = String(parts[0])
  const rest = parts.slice(1)
  const isIndex = /^\d+$/.test(head)
  const base = Array.isArray(node) ? node.slice() : (isPlainObject(node) ? { ...node } : (isIndex ? [] : {}))
  base[head] = setAt(base[head], rest, value)
  return base
}

function deleteAt(node: any, parts: string[]): any {
  if (!parts.length || node == null) return node
  const head = String(parts[0])
  const rest = parts.slice(1)
  if (Array.isArray(node)) {
    if (!/^\d+$/.test(head)) return node
    const copy = node.slice()
    if (rest.length) copy[Number(head)] = deleteAt(copy[Number(head)], rest)
    else copy.splice(Number(head), 1)
    return copy
  }
  if (!isPlainObject(node) || !(head in node)) return node
  const copy = { ...node }
  if (rest.length) copy[head] = deleteAt(copy[head], rest)
  else delete copy[head]
  return copy
}

function applyOp(node: any, op: StateOp): any {
  const parts = segmentList(op.path ?? '')
  if (!parts) return undefined
  if (op.op === 'set') {
    // 后端 diff 用 del 表达删除；set 缺 value 视为坏帧，宁可补全量也不写进 undefined
    if (!('value' in op)) return undefined
    return setAt(node, parts, op.value)
  }
  if (op.op === 'del') return deleteAt(node, parts)
  if (op.op === 'append' || op.op === 'prepend') {
    if (!Array.isArray(op.items)) return undefined
    const current = parts.length ? readAt(node, parts) : node
    if (!Array.isArray(current)) return undefined
    const merged = op.op === 'append' ? current.concat(op.items) : (op.items as unknown[]).concat(current)
    return setAt(node, parts, merged)
  }
  return undefined
}

function readAt(node: any, parts: string[]): any {
  let current = node
  for (const part of parts) {
    if (current == null) return undefined
    current = current[part]
  }
  return current
}

// 应用一帧事件：全量直接替换，增量必须 baseRev 命中本地 rev，否则要求补全量
export function reduceStateEvent(current: StreamState, event: StateEvent | null | undefined): ReduceResult {
  const base = current || createStreamState()
  if (!event || (event.type !== 'snapshot' && event.type !== 'patch')) {
    return { ...base, changed: false, resync: false }
  }
  const rev = Number(event.rev)
  if (!Number.isFinite(rev)) return { ...base, changed: false, resync: false }
  if (event.type === 'snapshot') {
    // 旧的（乱序到达的）全量不覆盖新状态，但也不要求补全量
    if (rev <= base.rev) return { ...base, changed: false, resync: false }
    return { state: event.state ?? null, rev, changed: true, resync: false }
  }
  const ops = Array.isArray(event.ops) ? event.ops : []
  if (Number(event.baseRev) !== base.rev) return { ...base, changed: false, resync: true }
  let next = base.state
  for (const op of ops) {
    const applied = applyOp(next, op || {})
    if (applied === undefined) return { ...base, changed: false, resync: true }
    next = applied
  }
  return { state: next, rev, changed: true, resync: false }
}
