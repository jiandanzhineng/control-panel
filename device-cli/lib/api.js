'use strict';

const { ApiError } = require('./errors');

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH',
  'ENETUNREACH', 'ECONNABORTED', 'EADDRNOTAVAIL', 'EPIPE'
]);

function networkCode(error) {
  let current = error;
  const seen = new Set();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === 'string' && NETWORK_CODES.has(current.code)) return current.code;
    if (current.name === 'AbortError') return 'ABORTED';
    current = current.cause;
  }
  return null;
}

function buildQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function createApi({ baseUrl, clientId = null, fetchImpl = globalThis.fetch } = {}) {
  let agentHeader = false;
  const api = {
    baseUrl,
    get clientId() {
      return agentHeader ? clientId : null;
    },
    setClientId(value) {
      clientId = value;
      agentHeader = true;
    },
    clearClientId() {
      agentHeader = false;
    },
    async request(method, path, { body, query, headers = {}, timeoutMs = 15000, raw = false } = {}) {
      const url = `${baseUrl}${path}${buildQuery(query)}`;
      const finalHeaders = { accept: 'application/json, text/plain, */*', ...headers };
      if (body !== undefined) finalHeaders['content-type'] = 'application/json';
      if (agentHeader && clientId) finalHeaders['x-agent-client'] = clientId;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: finalHeaders,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal
        });
      } catch (error) {
        const code = networkCode(error);
        if (code === 'ABORTED') {
          throw new ApiError(`请求超时（${method} ${path}）`, { code: 'TIMEOUT', path, url });
        }
        throw new ApiError(
          `连不上硅基之下控制中心（${baseUrl}），请先打开客户端`,
          { code: code || 'NETWORK_ERROR', path, url }
        );
      } finally {
        clearTimeout(timer);
      }
      if (raw) return { response, url };
      const text = await response.text();
      const type = response.headers.get('content-type') || '';
      let data = text;
      if (type.includes('application/json')) {
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      }
      if (!response.ok) {
        // 后端标准错误是 {error:{code,message}}，也兼容平铺的 {code,message} / {error:'文本'}。
        const nested = data && typeof data.error === 'object' && data.error ? data.error : null;
        const message = typeof data === 'string'
          ? data || response.statusText
          : nested?.message || data?.message ||
            (typeof data?.error === 'string' ? data.error : '') || response.statusText;
        throw new ApiError(message || `请求失败 (${response.status})`, {
          code: nested?.code || data?.code || `HTTP_${response.status}`,
          status: response.status,
          data,
          path,
          url
        });
      }
      return data;
    },
    get(path, options) { return this.request('GET', path, options); },
    post(path, body, options = {}) { return this.request('POST', path, { ...options, body }); },
    patch(path, body, options = {}) { return this.request('PATCH', path, { ...options, body }); },
    delete(path, options) { return this.request('DELETE', path, options); }
  };
  return api;
}

const AGENT_PREFIXES = ['/client', '/events', '/agent-control'];

function isAgentEndpoint(path) {
  return AGENT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`));
}

function describeError(error, baseUrl) {
  if (!error) return { code: 'ERROR', message: String(error), status: 0 };
  if (error.name === 'ApiError' || error.code === 'NETWORK_ERROR') {
    if (error.code === 'NETWORK_ERROR' || NETWORK_CODES.has(error.code)) {
      return {
        code: error.code,
        message: `连不上硅基之下控制中心（${baseUrl}），请先打开客户端`,
        status: 0
      };
    }
    if (error.code === 'AGENT_LIMIT_UNSUPPORTED') {
      return { code: error.code, message: error.message, status: error.status || 404 };
    }
    if (error.status === 404 && isAgentEndpoint(error.path)) {
      return {
        code: error.code,
        message: '当前客户端不支持该接口，请把硅基之下控制中心更新到最新版本',
        status: 404
      };
    }
    return { code: error.code || 'API_ERROR', message: error.message, status: error.status || 0 };
  }
  return { code: error.code || 'ERROR', message: error.message || String(error), status: error.status || 0 };
}

module.exports = { createApi, isAgentEndpoint, describeError };
