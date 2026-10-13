// 同一 http server 上多个 noServer WebSocketServer 的统一 upgrade 分发入口。
//
// 背景：/bridge 与 /voice-trigger 各自 noServer（带 path 的两个 WebSocketServer 会互相
// abortHandshake(400)），于是两边都往 server 挂 'upgrade' 监听、各自只认自己的路径。
// 谁都不认领的路径（拼错、旧客户端、爬虫探测）就没人应答，socket 一直挂着。
//
// 这里改成单一入口：各端点注册「认领判定 + 处理函数」，本模块只挂一个 'upgrade' 监听
// 遍历分发；没有任何路由认领时回 400 并销毁 socket，行为与 ws 自带 WebSocketServer
// 对未知路径的处理一致（见 ws/lib/websocket-server.js 的 abortHandshake）。
//
// 路由按 name 幂等注册（重复 init 同一端点不会产生重复路由）；各端点路径不同，
// 同时存在时不会互相误杀。
const logService = require('./logService');

const routes = new Map(); // name -> { match, handle }
let attached = false; // 进程内只挂一次（后端只有一个 http server）

/** 注册一个端点的 upgrade 处理；同 name 覆盖，避免重复 init 累积。 */
function register(name, match, handle) {
  routes.set(String(name), { match, handle });
}

/** 生成一个「忽略 query 的精确路径」判定函数。 */
function pathMatches(pathname) {
  const target = String(pathname || '');
  return (url) => {
    const raw = String(url || '');
    const index = raw.indexOf('?');
    const path = index === -1 ? raw : raw.slice(0, index);
    return path === target;
  };
}

/** 无人认领的 upgrade：回 400 并销毁 socket（与 ws 的 abortHandshake 一致）。 */
function rejectUpgrade(socket) {
  const message = 'Bad Request';
  try {
    if (!socket || socket.destroyed || socket.writableEnded) {
      socket?.destroy?.();
      return;
    }
    socket.once('finish', () => socket.destroy());
    socket.end(
      'HTTP/1.1 400 Bad Request\r\n'
      + 'Connection: close\r\n'
      + 'Content-Type: text/plain\r\n'
      + `Content-Length: ${Buffer.byteLength(message)}\r\n`
      + '\r\n'
      + message,
    );
  } catch (error) {
    logService.warn('WsUpgrade', `拒绝未知 upgrade 失败：${error?.message || error}`);
    try { socket?.destroy?.(); } catch (_) {}
  }
}

function dispatch(req, socket, head) {
  for (const route of routes.values()) {
    if (route.match(req.url)) {
      route.handle(req, socket, head);
      return;
    }
  }
  rejectUpgrade(socket);
}

/**
 * 给 server 挂上分发器。只挂一次：单测里每个用例都会 init 一遍各端点，
 * 若每次 init 都挂监听，同一个 upgrade 会被处理多次（第一次就把 socket 写掉了）。
 */
function attach(server) {
  if (!server || typeof server.on !== 'function') return false;
  if (attached) return false;
  attached = true;
  server.on('upgrade', dispatch);
  return true;
}

/** 供测试重置路由表与挂载状态。 */
function resetForTest() {
  routes.clear();
  attached = false;
}

module.exports = {
  register,
  pathMatches,
  rejectUpgrade,
  attach,
  dispatch,
  resetForTest,
};
