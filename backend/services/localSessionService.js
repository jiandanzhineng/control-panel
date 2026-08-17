// 本机登录会话保管箱：面板前端登录后把 JWT 寄存在后端，
// 本机数字人再来取，用来打 mimo-relay。token 不进 Git。
const fs = require('fs');
const path = require('path');

const DEFAULT_RELAY = 'https://mqtt.undersilicon.cn:8790/v1';

let memory = undefined;

function filePath() {
  if (process.env.LOCAL_SESSION_PATH) {
    return path.resolve(process.env.LOCAL_SESSION_PATH);
  }
  if (process.env.BACKEND_DATA_DIR) {
    return path.join(path.resolve(process.env.BACKEND_DATA_DIR), 'local-session.json');
  }
  return path.join(path.resolve(__dirname, '..'), 'data', 'local-session.json');
}

function load() {
  if (memory !== undefined) return memory;
  try {
    memory = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    memory = null;
  }
  return memory;
}

function persist(session) {
  memory = session;
  const dest = filePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (session) {
    fs.writeFileSync(dest, JSON.stringify(session, null, 2) + '\n', 'utf8');
    return;
  }
  try { fs.unlinkSync(dest); } catch { /* 没有文件也算清掉 */ }
}

function deposit(token, user) {
  persist({
    token,
    user: { id: user?.id || null, email: user?.email || null },
    depositedAt: Date.now(),
  });
  return memory;
}

function get() { return load(); }
function clear() { persist(null); }

function getRelayUrl() {
  return String(process.env.MIMO_RELAY_URL || DEFAULT_RELAY).replace(/\/+$/, '');
}

function isLoopback(req) {
  const ip = req.socket?.remoteAddress || req.ip || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === ':ffff:127.0.0.1'
    || ip === '::ffff:127.0.0.1';
}

function _resetForTests() { memory = undefined; }

module.exports = {
  deposit, get, clear, getRelayUrl, isLoopback, _resetForTests, DEFAULT_RELAY,
};
