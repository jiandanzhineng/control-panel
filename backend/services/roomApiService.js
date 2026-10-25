const ROOM_API_URL = (process.env.ROOM_API_URL
  || process.env.ACCOUNT_API_URL
  || 'https://api.undersilicon.cn').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = 8000;

class RoomApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', token, body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${ROOM_API_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const message = error?.name === 'AbortError' ? '房间服务请求超时' : '无法连接房间服务';
    throw new RoomApiError(502, 'ROOM_API_UNREACHABLE', message);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 204) return null;
  let data = null;
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) {
    const detail = data?.error || {};
    throw new RoomApiError(
      response.status,
      detail.code || 'ROOM_API_ERROR',
      detail.message || `房间服务返回 ${response.status}`,
    );
  }
  return data;
}

function createRoom(token, capacity = 8, options = {}) {
  return request('/rooms', {
    method: 'POST',
    token,
    body: {
      gameId: options.gameId || 'remote-device-projection',
      gameVersion: options.gameVersion || '1.0.0',
      capacity,
    },
  });
}

function joinRoom(token, joinCode) {
  return request(`/rooms/join/${encodeURIComponent(joinCode)}`, { method: 'POST', token });
}

function activateRoom(token, roomId) {
  return request(`/rooms/${encodeURIComponent(roomId)}/activate`, { method: 'POST', token });
}

function heartbeat(token, roomId) {
  return request(`/rooms/${encodeURIComponent(roomId)}/heartbeat`, { method: 'POST', token });
}

function getMqttCredential(token, roomId, clientId) {
  return request(`/rooms/${encodeURIComponent(roomId)}/mqtt-token`, {
    method: 'POST',
    token,
    body: clientId ? { clientId } : {},
  });
}

function leaveRoom(token, roomId) {
  return request(`/rooms/${encodeURIComponent(roomId)}/leave`, { method: 'POST', token });
}

function closeRoom(token, roomId) {
  return request(`/rooms/${encodeURIComponent(roomId)}/close`, { method: 'POST', token });
}

// 读取房间详情（成员列表含 userId/role/status）。房主与成员都可调用。
function getRoom(token, roomId) {
  return request(`/rooms/${encodeURIComponent(roomId)}`, { token });
}

// 房主把成员移出房间（服务端 204）。服务端踢线尚未接线，
// 调用方必须同时在本地拒绝该 userId（见 remoteProjectionService）。
function kickMember(token, roomId, userId) {
  return request(`/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    token,
  });
}

module.exports = {
  RoomApiError,
  getBaseUrl: () => ROOM_API_URL,
  createRoom,
  joinRoom,
  activateRoom,
  heartbeat,
  getMqttCredential,
  leaveRoom,
  closeRoom,
  getRoom,
  kickMember,
};
