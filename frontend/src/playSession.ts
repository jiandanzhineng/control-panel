export type PlayCarrier = 'game' | 'plugin';

export type PlaySession = {
  carrier: PlayCarrier;
  id: string;
  version: string;
  source: string;
  device_types: string;
  roles: string;
  device_count: number;
  startedAt: number;
};

export function uniqueSorted(values: string[]): string {
  return [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))].sort().join(',');
}

export function mappedRoles(mapping: Record<string, string[]> | null | undefined): string {
  const roles: string[] = [];
  for (const [role, ids] of Object.entries(mapping || {})) {
    if (ids && ids.length) roles.push(role);
  }
  return uniqueSorted(roles);
}

export function mappedDeviceCount(mapping: Record<string, string[]> | null | undefined): number {
  const ids = new Set<string>();
  for (const list of Object.values(mapping || {})) {
    for (const id of list || []) if (id) ids.add(id);
  }
  return ids.size;
}

export function mappedDeviceTypes(
  mapping: Record<string, string[]> | null | undefined,
  devices: Array<{ id: string; type?: string }> | null | undefined,
): string {
  const byId = new Map((devices || []).map((d) => [d.id, d.type || '']));
  const types: string[] = [];
  for (const ids of Object.values(mapping || {})) {
    for (const id of ids || []) {
      const type = byId.get(id);
      if (type) types.push(type);
    }
  }
  return uniqueSorted(types);
}

export function playEventProps(
  session: Omit<PlaySession, 'startedAt'> | PlaySession,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const idKey = session.carrier === 'plugin' ? 'plugin_id' : 'game_id';
  return {
    [idKey]: session.id,
    version: session.version,
    source: session.source,
    device_types: session.device_types,
    roles: session.roles,
    device_count: session.device_count,
    ...extra,
  };
}

export function durationMs(startedAt: number, now: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.round(now - startedAt));
}
