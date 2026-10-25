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
  limits?: { voltage: number; power: number; intensity?: number };
  devices?: ProjectionDevice[];
  operatorCount?: number;
  authorized?: boolean;
  authorizedUserId?: string | null;
  members?: ProjectionMember[];
  lastError?: string | null;
  apiBaseUrl?: string | null;
}

export interface ProjectionMember {
  userId: string;
  role?: string;
  status?: string;
  online?: boolean;
  authorized?: boolean;
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
  limits: { voltage: number; power: number; intensity?: number };
}) => request('/create', { method: 'POST', body: input });

export const joinProjection = (joinCode: string) => (
  request('/join', { method: 'POST', body: { joinCode } })
);

export const stopProjection = () => request('/stop', { method: 'POST' });

// 房主显式授权某个成员（userId）。授权前该成员看不到设备清单也写不了。
export const authorizeProjection = (userId: string) => (
  request('/authorize', { method: 'POST', body: { userId } })
);

export const revokeProjection = () => request('/revoke', { method: 'POST' });

// 移出房间：调服务端踢人，并在本地立即拒绝该成员。
export const kickProjectionMember = (userId: string) => (
  request('/kick', { method: 'POST', body: { userId } })
);
