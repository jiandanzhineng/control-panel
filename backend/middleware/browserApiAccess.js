const { sendError } = require('../utils/http');

const DEFAULT_TRUSTED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
  'http://localhost:5277',
  'http://127.0.0.1:5277',
  'http://[::1]:5277',
];

function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.origin;
  } catch (_) {
    return '';
  }
}

function getTrustedBrowserOrigins() {
  const envOrigins = [
    process.env.VITE_DEV_SERVER_URL,
    process.env.FRONTEND_URL,
    ...(String(process.env.TRUSTED_BROWSER_API_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)),
  ];

  return new Set(
    [...DEFAULT_TRUSTED_ORIGINS, ...envOrigins]
      .map(normalizeOrigin)
      .filter(Boolean),
  );
}

function getRequestOrigin(req) {
  return normalizeOrigin(req.get('Origin'));
}

function isTrustedBrowserOrigin(origin) {
  if (!origin) return false;
  return getTrustedBrowserOrigins().has(origin);
}

function appendVaryHeader(res, value) {
  const current = String(res.getHeader('Vary') || '');
  if (!current) {
    res.setHeader('Vary', value);
    return;
  }
  const parts = current
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.includes(value)) {
    parts.push(value);
    res.setHeader('Vary', parts.join(', '));
  }
}

function browserApiCors(req, res, next) {
  const origin = getRequestOrigin(req);
  if (!origin) {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  }

  appendVaryHeader(res, 'Origin');

  if (!isTrustedBrowserOrigin(origin)) {
    return sendError(res, 'BROWSER_API_FORBIDDEN', '当前网页不能直接访问本机控制接口', 403);
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

module.exports = {
  DEFAULT_TRUSTED_ORIGINS,
  normalizeOrigin,
  getTrustedBrowserOrigins,
  getRequestOrigin,
  isTrustedBrowserOrigin,
  browserApiCors,
};
