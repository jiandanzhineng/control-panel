import { getToken } from './auth';

export type ProjectionRole = 'owner' | 'operator';

export interface ProjectionDevice {
  id?: string;
  deviceId?: string;
  type?: string;
  deviceType?: string;
  name?: string;
  nickname?: string;
  connected?: boolean;
  connectionType?: string;
}

export interface ProjectionStatus {
  active: boolean;
  role?: ProjectionRole;
  roomId?: string;
  joinCode?: string | null;
  connected?: boolean;
  expired?: boolean;
  controlTtlSec?: number;
  controlExpiresAt?: string;
  limits?: { voltage: number; power: number };
  devices?: ProjectionDevice[];
  operatorCount?: number;
  lastError?: string | null;
  apiBaseUrl?: string | null;
}

export class ProjectionApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request(path: string, options: { method?: string; body?: unknown } = {}): Promise<ProjectionStatus> {
  const token = getToken();
  const response = await fetch(`/api/remote-projection${path}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let data: any = null;
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) {
    const error = data?.error || {};
    throw new ProjectionApiError(response.status, error.code || 'UNKNOWN', error.message || '远程投影操作失败');
  }
  return data as ProjectionStatus;
}

export const getProjectionStatus = () => request('/status');

export const createProjection = (input: {
  controlTtlSec: number;
  limits: { voltage: number; power: number };
}) => request('/create', { method: 'POST', body: input });

export const joinProjection = (joinCode: string) => (
  request('/join', { method: 'POST', body: { joinCode } })
);

export const stopProjection = () => request('/stop', { method: 'POST' });
