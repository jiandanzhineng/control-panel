// 只允许回环来源访问本机远控接口。
//
// 审查报告 §2.4：后端原绑 0.0.0.0，局域网内任何机器都能直达
// /api/remote-game/*、/api/remote-projection/*（authorize/revoke 无凭据）。
// 现在后端只绑 127.0.0.1（electron/main.js、backend/index.js），这里再加一道
// 纵深防御：即使有人显式把 BACKEND_HOST 设成 0.0.0.0，远控路由也只服务本机。
//
// 只挂远控路由，不加到全局 /api，避免影响既有的本机浏览器/开发态放行逻辑。
const { sendError } = require('../utils/http');

const LOOPBACK_ADDRESSES = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  '::ffff:0.0.0.0',
]);

function isLoopbackAddress(address) {
  const value = String(address || '').trim();
  if (!value) return false;
  if (LOOPBACK_ADDRESSES.has(value)) return true;
  // 127.0.0.0/8 全段
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true;
  // IPv6 映射的 127.x.x.x
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(value)) return true;
  return false;
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress || req.ip);
}

function loopbackOnly(req, res, next) {
  if (isLoopbackRequest(req)) return next();
  return sendError(res, 'REMOTE_LOCAL_ONLY', '远程控制接口只允许本机访问', 403);
}

module.exports = { loopbackOnly, isLoopbackRequest, isLoopbackAddress };
