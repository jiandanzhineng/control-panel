// 本机共用语音渠道：通路和自备 key 只存在面板，给数字人等游戏用。
const fs = require('fs');
const path = require('path');
const localSession = require('./localSessionService');

const ROUTES = ['own_key', 'panel'];
const DIRECT_BASE = 'https://api.xiaomimimo.com/v1';
const TOKENPLAN_URL = 'https://platform.xiaomimimo.com/token-plan';
const INVITE_CODE = '8SNDXF';
const INVITE_URL = 'https://platform.xiaomimimo.com?ref=8SNDXF';
const OFFICIAL_HINT = '官方渠道可能比较慢，建议使用个人 API key。';

let memory;

function filePath() {
  if (process.env.VOICE_SETTINGS_PATH) {
    return path.resolve(process.env.VOICE_SETTINGS_PATH);
  }
  const root = process.env.BACKEND_DATA_DIR
    ? path.resolve(process.env.BACKEND_DATA_DIR)
    : path.join(__dirname, '..', 'data');
  return path.join(root, 'voice-settings.json');
}

function empty() {
  return { route: 'panel', api_key: '', route_chosen: false };
}

function load() {
  if (memory !== undefined) return memory;
  try {
    const saved = JSON.parse(fs.readFileSync(filePath(), 'utf8')) || {};
    memory = empty();
    if (saved.route_chosen === true && ROUTES.includes(saved.route)) {
      memory.route = saved.route;
      memory.route_chosen = true;
    }
    if (typeof saved.api_key === 'string') memory.api_key = saved.api_key.trim();
  } catch {
    memory = empty();
  }
  return memory;
}

function persist() {
  const dest = filePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const cur = load();
  fs.writeFileSync(dest, JSON.stringify({
    route: cur.route, api_key: cur.api_key, route_chosen: cur.route_chosen,
  }, null, 2) + '\n', 'utf8');
}

function maskKey(key) {
  const text = (key || '').trim();
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}…`;
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function update({ route, api_key } = {}) {
  const cur = load();
  if (ROUTES.includes(route)) {
    cur.route = route;
    cur.route_chosen = true;
  }
  if (api_key !== undefined) cur.api_key = String(api_key || '').trim();
  persist();
  return status();
}

function effectiveRoute() {
  return load().route_chosen ? load().route : 'panel';
}

function resolve() {
  const route = effectiveRoute();
  if (route === 'own_key') {
    const key = load().api_key;
    if (!key) {
      const err = new Error('未填写个人 MiMo API key');
      err.code = 'NO_OWN_KEY';
      throw err;
    }
    return { name: 'direct', base: DIRECT_BASE, headers: { 'api-key': key } };
  }
  const session = localSession.get();
  const token = session && session.token;
  if (!token) {
    const err = new Error('未拿到控制面板登录，请先在 UnderSilicon 登录');
    err.code = 'NOT_SIGNED_IN';
    throw err;
  }
  let url = localSession.getRelayUrl();
  if (url && !url.endsWith('/v1')) url = `${url}/v1`;
  return { name: 'relay', base: url, headers: { Authorization: `Bearer ${token}` } };
}

function status() {
  const cur = load();
  const session = localSession.get() || {};
  let ready = false;
  let mode = 'none';
  try {
    mode = resolve().name;
    ready = true;
  } catch (_) {}
  return {
    route: effectiveRoute(),
    route_chosen: cur.route_chosen === true,
    mode,
    ready,
    has_key: Boolean(cur.api_key),
    key_masked: maskKey(cur.api_key),
    panel_email: session.user && session.user.email || null,
    panel_ok: Boolean(session.token),
    hint: OFFICIAL_HINT,
    tokenplan_url: TOKENPLAN_URL,
    invite_code: INVITE_CODE,
    invite_url: INVITE_URL,
  };
}

function _resetForTests() { memory = undefined; }

module.exports = {
  ROUTES, DIRECT_BASE, update, status, resolve, effectiveRoute,
  _resetForTests, maskKey,
};
