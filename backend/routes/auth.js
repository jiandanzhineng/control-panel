// routes/auth.js — 账号相关 API：把 /api/auth/* 转发到远程账号服务。
// token 不落本地后端，由前端持有，受保护接口从这里透传 Authorization 头。
const express = require('express');
const accountService = require('../services/accountService');
const localSession = require('../services/localSessionService');
const { sendError } = require('../utils/http');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function extractBearer(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

function validateEmailPassword(req, res, { checkPasswordLength = false } = {}) {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    sendError(res, 'INVALID_EMAIL', '邮箱格式不正确', 400);
    return null;
  }
  if (typeof password !== 'string' || !password) {
    sendError(res, 'INVALID_PASSWORD', '密码不能为空', 400);
    return null;
  }
  if (checkPasswordLength && (password.length < 8 || password.length > 128)) {
    sendError(res, 'INVALID_PASSWORD', '密码长度须为 8-128 位', 400);
    return null;
  }
  return { email, password };
}

function requireToken(req, res) {
  const token = extractBearer(req);
  if (!token) sendError(res, 'MISSING_TOKEN', '缺少 Bearer token', 401);
  return token;
}

function handleUpstreamError(res, e) {
  if (e instanceof accountService.UpstreamError) {
    sendError(res, e.code, e.message, e.status);
  } else {
    sendError(res, 'AUTH_FAILED', e?.message || '账号服务异常');
  }
}

router.post('/register', async (req, res) => {
  const input = validateEmailPassword(req, res, { checkPasswordLength: true });
  if (!input) return;
  try {
    const { status, data } = await accountService.register(input.email, input.password);
    res.status(status).json(data);
  } catch (e) {
    handleUpstreamError(res, e);
  }
});

router.post('/login', async (req, res) => {
  const input = validateEmailPassword(req, res);
  if (!input) return;
  try {
    const { status, data } = await accountService.login(input.email, input.password);
    res.status(status).json(data);
  } catch (e) {
    handleUpstreamError(res, e);
  }
});

router.post('/logout', async (req, res) => {
  const token = requireToken(req, res);
  if (!token) return;
  try {
    await accountService.logout(token);
    res.status(204).end();
  } catch (e) {
    handleUpstreamError(res, e);
  }
});

router.post('/recovery', async (req, res) => {
  const { email } = req.body || {};
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    sendError(res, 'INVALID_EMAIL', '邮箱格式不正确', 400);
    return;
  }
  try {
    await accountService.recovery(email);
    res.status(204).end();
  } catch (e) {
    handleUpstreamError(res, e);
  }
});

router.get('/me', async (req, res) => {
  const token = requireToken(req, res);
  if (!token) return;
  try {
    const { data } = await accountService.getMe(token);
    res.json(data);
  } catch (e) {
    handleUpstreamError(res, e);
  }
});

router.delete('/me', async (req, res) => {
  const token = requireToken(req, res);
  if (!token) return;
  try {
    await accountService.deleteMe(token);
    res.status(204).end();
  } catch (e) {
    handleUpstreamError(res, e);
  }
});

// 诊断用：当前配置的账号服务地址
router.get('/status', (req, res) => {
  res.json({ baseUrl: accountService.getBaseUrl() });
});

function userFromMe(data) {
  return (data && data.user) || data || {};
}

// 面板前端登录后寄存 JWT，给本机数字人走 mimo-relay。
router.post('/local-session', async (req, res) => {
  const token = requireToken(req, res);
  if (!token) return;
  try {
    const { data } = await accountService.getMe(token);
    const user = userFromMe(data);
    localSession.deposit(token, user);
    res.json({ ok: true, user: { id: user.id || null, email: user.email || null } });
  } catch (e) {
    handleUpstreamError(res, e);
  }
});

router.delete('/local-session', (_req, res) => {
  localSession.clear();
  res.status(204).end();
});

// 只许本机读取。JWT 能在公网 relay 花额度。
router.get('/relay-credential', async (req, res) => {
  if (!localSession.isLoopback(req)) {
    return sendError(res, 'LOCAL_ONLY', '仅本机可读取登录凭据', 403);
  }
  const session = localSession.get();
  if (!session || !session.token) {
    return sendError(res, 'NOT_SIGNED_IN', '控制面板未登录', 401);
  }
  try {
    const { data } = await accountService.getMe(session.token);
    const user = userFromMe(data);
    localSession.deposit(session.token, user);
    res.json({
      relay_url: localSession.getRelayUrl(),
      token: session.token,
      user: { id: user.id || session.user?.id || null,
              email: user.email || session.user?.email || null },
    });
  } catch (e) {
    if (e instanceof accountService.UpstreamError && e.status === 401) {
      localSession.clear();
    }
    handleUpstreamError(res, e);
  }
});

module.exports = router;
