import { reactive, readonly } from 'vue';
import type { AuthUser } from '../api/auth';
import * as authApi from '../api/auth';

/**
 * 账号登录态（会话级前端态，token 持久在 localStorage）。
 *
 * 与移动端 auth_provider.dart 同一语义：
 *  - 启动 checkSession：无 token → guest；有 token → /me 校验，
 *    401 清 token 回 guest；网络错误保留 token 置 unknown（下次启动再验）。
 *  - 登录/注册成功持久化 token；登出/删号后清本地态回 guest。
 *  - 本地功能不依赖登录态（登录仅用于云端同步），所以 guest 不阻塞任何页面。
 */
export type AuthStatus = 'unknown' | 'guest' | 'authed';

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  token: string | null;
}

const state = reactive<AuthState>({
  status: 'unknown',
  user: null,
  token: authApi.getToken(),
});

function persistSession(token: string, user: AuthUser): void {
  authApi.setToken(token);
  state.token = token;
  state.user = user;
  state.status = 'authed';
  void authApi.depositLocalSession(token).catch(() => { /* 不挡登录 */ });
}

function clearSession(): void {
  authApi.clearToken();
  state.token = null;
  state.user = null;
  state.status = 'guest';
  void authApi.clearLocalSession().catch(() => { /* 后端没开也照清本地 */ });
}

async function checkSession(): Promise<void> {
  if (!state.token) {
    state.status = 'guest';
    return;
  }
  try {
    const { user } = await authApi.fetchMe(state.token);
    state.user = user;
    state.status = 'authed';
    void authApi.depositLocalSession(state.token).catch(() => { /* 不挡启动 */ });
  } catch (e) {
    if (e instanceof authApi.ApiError && e.status === 401) {
      clearSession();
    } else {
      // 网络/服务不可用：保留 token，下次启动再验
      state.status = 'unknown';
    }
  }
}

async function login(email: string, password: string): Promise<void> {
  const { token, user } = await authApi.login(email, password);
  persistSession(token, user);
}

async function register(email: string, password: string): Promise<void> {
  const { token, user } = await authApi.register(email, password);
  persistSession(token, user);
}

async function logout(): Promise<void> {
  const token = state.token;
  if (token) {
    try {
      await authApi.logout(token);
    } catch {
      /* 远端撤销失败也照常清本地态 */
    }
  }
  clearSession();
}

async function deleteAccount(): Promise<void> {
  const token = state.token;
  if (!token) return;
  await authApi.deleteAccount(token);
  clearSession();
}

async function recover(email: string): Promise<void> {
  await authApi.recover(email);
}

export function useAuth() {
  return {
    authState: readonly(state),
    checkSession,
    login,
    register,
    logout,
    deleteAccount,
    recover,
  };
}
