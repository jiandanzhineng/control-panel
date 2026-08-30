// 账号 API 客户端：打本地后端 /api/auth/*，由后端转发到远程账号服务（api.undersilicon.cn）。
// token 存 localStorage，key 与移动端保持一致（undersilicon_api_token）。

export interface AuthUser {
  id: string;
  email: string | null;
  provider: string;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TOKEN_KEY = 'undersilicon_api_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  let resp: Response;
  try {
    resp = await fetch(`/api/auth${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'NETWORK_ERROR');
  }

  if (resp.status === 204) return undefined as T;

  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!resp.ok) {
    const err = data?.error || {};
    throw new ApiError(resp.status, err.code || 'UNKNOWN', err.message || `请求失败 (${resp.status})`);
  }
  return data as T;
}

export function login(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/login', { method: 'POST', body: { email, password } });
}

export function register(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/register', { method: 'POST', body: { email, password } });
}

export function logout(token: string): Promise<void> {
  return request<void>('/logout', { method: 'POST', token });
}

export function recover(email: string): Promise<void> {
  return request<void>('/recovery', { method: 'POST', body: { email } });
}

export function fetchMe(token: string): Promise<{ user: AuthUser }> {
  return request<{ user: AuthUser }>('/me', { token });
}

export function deleteAccount(token: string): Promise<void> {
  return request<void>('/me', { method: 'DELETE', token });
}

export function depositLocalSession(token: string): Promise<void> {
  return request<void>('/local-session', { method: 'POST', token });
}

export function clearLocalSession(): Promise<void> {
  return request<void>('/local-session', { method: 'DELETE' });
}
