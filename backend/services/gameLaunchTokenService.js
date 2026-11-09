// 页面游戏启动令牌：宿主在 /api/games/:id/start 时按游戏 id 签发，
// 前端拼进 iframe URL，device-api-bridge.js 在 bridge init 时回传。
// 云存档只认令牌对应的游戏 id，页面传入的任何 gameId 都不使用。
const crypto = require('crypto');

const GAME_ID_RE = /^[a-z0-9-]{1,64}$/;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 200;

let tokens = new Map();

function prune(now = Date.now()) {
  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(token);
  }
}

/** 按游戏 id 签发一次令牌；id 不合法（如外部游戏的稳定 id）返回 null。 */
function issue(gameId, { agentClientId = null } = {}) {
  const id = typeof gameId === 'string' ? gameId : '';
  if (!GAME_ID_RE.test(id)) return null;
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  prune(now);
  tokens.set(token, {
    gameId: id,
    agentClientId: typeof agentClientId === 'string' && agentClientId ? agentClientId : null,
    expiresAt: now + TOKEN_TTL_MS,
  });
  return token;
}

/** 令牌 → 完整条目（含签发时的 agent 来源）；未知或过期返回 null。 */
function resolveEntry(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return null;
  const entry = tokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    tokens.delete(token);
    return null;
  }
  return entry;
}

/** 令牌 → 游戏 id；未知或过期返回 null。 */
function resolve(token) {
  return resolveEntry(token)?.gameId || null;
}

function _resetForTests() {
  tokens = new Map();
}

module.exports = {
  issue,
  resolve,
  resolveEntry,
  _resetForTests,
  GAME_ID_RE,
  TOKEN_TTL_MS,
};
