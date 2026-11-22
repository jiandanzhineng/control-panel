// 本地模型运行时 API。
export type ModelState = 'absent' | 'downloading' | 'verifying' | 'ready' | 'error';
export type ProviderId = 'auto' | 'cuda' | 'directml' | 'npu' | 'cpu' | string;

export interface ModelFileInfo {
  name: string;
  bytes: number;
  sha256: string;
  urls: string[];
}

export interface ModelEntry {
  id: string;
  task: string;
  title: { zh: string; en: string };
  languages?: string[];
  engine: string;
  engineConfig: Record<string, unknown>;
  files: ModelFileInfo[];
  providers: string[];
  license: { name: string; author?: string; url?: string; attribution?: string };
  recommended: boolean;
  state: ModelState;
  received: number;
  total: number;
  error: string | null;
}

export interface Accelerator {
  id: string;
  name: string;
  available: boolean;
  supported: boolean;
  present: boolean;
  reason: string | null;
  failures?: number;
}

export interface TaskSettings {
  localEnabled: boolean;
  model: string | null;
  provider: ProviderId;
  configured?: boolean;
}

export interface ModelsSnapshot {
  models: ModelEntry[];
  settings: Record<string, TaskSettings>;
  accelerators: Accelerator[];
  benchmarks: Record<string, Record<string, { ms: number; at: number }>>;
  last: { provider: string | null; latencyMs: number | null };
  workers: Array<{ key: string; ready: boolean; busy: boolean; queued: number }>;
}

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.message || res.statusText);
  return data as T;
}

export function getModels() {
  return fetch('/api/models').then(parse<ModelsSnapshot>);
}

export function downloadModel(id: string) {
  return fetch(`/api/models/${encodeURIComponent(id)}/download`, { method: 'POST' }).then(parse);
}

export function cancelModelDownload(id: string) {
  return fetch(`/api/models/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).then(parse);
}

export function deleteModel(id: string) {
  return fetch(`/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(parse);
}

export function refreshAccelerators() {
  return fetch('/api/models/accelerators/refresh', { method: 'POST' }).then(parse<{ devices: Accelerator[] }>);
}

export function saveModelSettings(tasks: Record<string, Partial<TaskSettings>>) {
  return fetch('/api/models/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks }),
  }).then(parse<{ settings: Record<string, TaskSettings> }>);
}
