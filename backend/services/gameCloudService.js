// 页面游戏云存档：把 DeviceAPI.cloud 的请求转发到账号后端
// GET/PUT {ACCOUNT_API_URL}/me/game-data/:gameId（契约见 docs/plans/vocab-game.md §4）。
// gameId 只由 bridge 会话决定，这里不接受页面传入的值。
// 日志只记动作、gameId、状态码和耗时；token 与存档内容一律不落日志。
const localSession = require('./localSessionService');
const accountService = require('./accountService');
const logService = require('./logService');

const GAME_ID_RE = /^[a-z0-9-]{1,64}$/;
const MAX_DATA_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15000;

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.cloud = true;
  return error;
}

function currentSession() {
  const session = localSession.get();
  return session && typeof session.token === 'string' && session.token ? session : null;
}

/** 只读本地会话，不请求网络。 */
function status() {
  const session = currentSession();
  if (!session) return { signedIn: false };
  const user = session.user && typeof session.user === 'object' ? session.user : {};
  return {
    signedIn: true,
    user: {
      id: user.id == null ? null : String(user.id),
      nickname: typeof user.nickname === 'string' && user.nickname ? user.nickname : null,
    },
  };
}

function assertGameId(gameId) {
  const id = typeof gameId === 'string' ? gameId : '';
  if (!GAME_ID_RE.test(id)) throw makeError('BAD_GAME', '当前游戏不能使用云存档');
  return id;
}

function serializeData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw makeError('BAD_DATA', '存档内容必须是对象');
  }
  let text;
  try { text = JSON.stringify(data); } catch (_) {
    throw makeError('BAD_DATA', '存档内容无法序列化');
  }
  if (typeof text !== 'string') throw makeError('BAD_DATA', '存档内容必须是对象');
  if (Buffer.byteLength(text, 'utf8') > MAX_DATA_BYTES) {
    throw makeError('TOO_LARGE', '存档超过 1MB');
  }
  return text;
}

function upstreamDetail(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const detail = payload.message || payload.error?.message || payload.error;
  return typeof detail === 'string' && detail ? `：${detail}` : '';
}

function mapUpstreamError(statusCode, payload) {
  if (statusCode === 401) {
    return makeError('NOT_SIGNED_IN', '登录已失效，请在客户端重新登录账号');
  }
  if (statusCode === 409) {
    const error = makeError('VERSION_CONFLICT', '云端存档已被其他设备修改');
    error.remote = {
      data: payload && payload.data !== undefined ? payload.data : null,
      version: payload && Number.isInteger(payload.version) ? payload.version : 0,
    };
    return error;
  }
  if (statusCode === 413) return makeError('TOO_LARGE', '存档超过服务端 1MB 限制');
  return makeError(`UPSTREAM_${statusCode}`, `云存档服务返回 ${statusCode}${upstreamDetail(payload)}`);
}

async function callUpstream({ action, gameId, method, body }) {
  const session = currentSession();
  if (!session) throw makeError('NOT_SIGNED_IN', '未登录控制面板，请先登录账号');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  let statusCode = 0;
  try {
    const resp = await fetch(`${accountService.getBaseUrl()}/me/game-data/${gameId}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.token}`,
      },
      body,
      signal: controller.signal,
    });
    statusCode = resp.status;
    let payload = null;
    try { payload = await resp.json(); } catch (_) { /* 非 JSON 响应 */ }
    if (!resp.ok) throw mapUpstreamError(resp.status, payload);
    if (!payload || typeof payload !== 'object') {
      throw makeError(`UPSTREAM_${resp.status}`, `云存档服务返回异常（HTTP ${resp.status}）`);
    }
    return payload;
  } catch (error) {
    // 已映射的云存档错误原样抛出；其余（超时、断网、DNS）统一按 NETWORK 处理。
    if (error && error.cloud) throw error;
    throw makeError('NETWORK', '云存档服务不可用，请检查网络后重试');
  } finally {
    clearTimeout(timer);
    logService.info('GameCloud', `action=${action} gameId=${gameId} status=${statusCode} ms=${Date.now() - startedAt}`);
  }
}

async function get(gameId) {
  const id = assertGameId(gameId);
  const payload = await callUpstream({ action: 'cloudGet', gameId: id, method: 'GET' });
  return {
    data: payload.data === undefined ? null : payload.data,
    version: Number.isInteger(payload.version) ? payload.version : 0,
    updatedAt: payload.updatedAt === undefined ? null : payload.updatedAt,
  };
}

async function put(gameId, data, baseVersion) {
  const id = assertGameId(gameId);
  const text = serializeData(data);
  const version = Number(baseVersion);
  if (!Number.isInteger(version) || version < 0) {
    throw makeError('BAD_DATA', 'baseVersion 必须是非负整数');
  }
  const body = `{"data":${text},"baseVersion":${version}}`;
  const payload = await callUpstream({ action: 'cloudPut', gameId: id, method: 'PUT', body });
  if (!Number.isInteger(payload.version)) {
    throw makeError('UPSTREAM_200', '云存档服务未返回版本号');
  }
  return {
    version: payload.version,
    updatedAt: payload.updatedAt === undefined ? null : payload.updatedAt,
  };
}

module.exports = {
  status,
  get,
  put,
  GAME_ID_RE,
  MAX_DATA_BYTES,
  TIMEOUT_MS,
};
