// accountService.js — 远程账号服务（api.undersilicon.cn）的转发客户端。
//
// control-panel 不建本地用户表，账号体系复用移动端同一套后端：
// 邮箱+密码注册/登录，JWT(HS256)+session 混合会话（30 天、服务端可撤销），
// Bearer token 鉴权。本模块只做带超时的 fetch 封装与错误规整。
const logger = require('../utils/logger');

const ACCOUNT_API_URL = (process.env.ACCOUNT_API_URL || 'https://api.undersilicon.cn').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = 8000;

class UpstreamError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// 调用远程账号 API。成功返回 { status, data }；失败抛 UpstreamError。
async function callUpstream(path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  let resp;
  try {
    resp = await withTimeout(fetch(`${ACCOUNT_API_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }), FETCH_TIMEOUT_MS);
  } catch (e) {
    logger.warn('Account upstream unreachable', { path, err: e?.message });
    throw new UpstreamError(502, 'UPSTREAM_UNREACHABLE', '账号服务器不可达，请检查网络');
  }

  if (resp.status === 204) return { status: 204, data: null };

  let data = null;
  try { data = await resp.json(); } catch (_) { /* 非 JSON 响应 */ }
  if (!resp.ok) {
    const err = (data && data.error) || {};
    throw new UpstreamError(
      resp.status,
      err.code || 'UPSTREAM_ERROR',
      err.message || `账号服务器返回 ${resp.status}`,
    );
  }
  return { status: resp.status, data };
}

function getBaseUrl() {
  return ACCOUNT_API_URL;
}

function register(email, password) {
  return callUpstream('/auth/register', { method: 'POST', body: { email, password } });
}

function login(email, password) {
  return callUpstream('/auth/login', { method: 'POST', body: { email, password } });
}

function logout(token) {
  return callUpstream('/auth/logout', { method: 'POST', token });
}

function recovery(email) {
  return callUpstream('/auth/recovery', { method: 'POST', body: { email } });
}

function getMe(token) {
  return callUpstream('/me', { token });
}

function deleteMe(token) {
  return callUpstream('/me', { method: 'DELETE', token });
}

module.exports = {
  UpstreamError,
  getBaseUrl,
  register,
  login,
  logout,
  recovery,
  getMe,
  deleteMe,
};
