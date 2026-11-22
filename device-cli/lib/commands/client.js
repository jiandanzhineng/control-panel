'use strict';

const fs = require('fs');
const path = require('path');
const { UsageError } = require('../errors');
const { timestamp } = require('../util');

const WINDOW_ACTIONS = ['show', 'hide', 'focus', 'minimize', 'maximize', 'restore'];

async function windowAction(ctx) {
  const { api, out, json, baseUrl, parsed } = ctx;
  const action = parsed.positionals[0];
  if (!action || !WINDOW_ACTIONS.includes(action)) {
    throw new UsageError(
      `用法: undersilicon window <${WINDOW_ACTIONS.join('|')}>`,
      'window'
    );
  }
  const result = await api.post('/client/window', { action });
  const payload = { ok: true, command: 'window', baseUrl, action, result };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.kv({
    动作: action,
    窗口: JSON.stringify(result?.window ?? null),
    路由: result?.route ?? ''
  });
}

async function routes(ctx) {
  const { api, out, json, baseUrl } = ctx;
  const list = await api.get('/client/routes');
  const rows = Array.isArray(list) ? list : [];
  const payload = { ok: true, command: 'routes', baseUrl, routes: rows, count: rows.length };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.result(payload, {
    title: `可导航页面（${rows.length} 个）`,
    rows: rows.map((route) => ({ path: route.path, name: route.name, title: route.title })),
    headers: ['path', 'name', 'title']
  });
}

// Git Bash（MSYS）会把 `/plays` 改写成 `C:/Program Files/Git/plays`。
// 遇到 Windows 绝对路径时，按页面清单做后缀匹配还原成路由。
async function resolveRoutePath(api, input) {
  const raw = String(input).trim();
  if (!/^[A-Za-z]:[\\/]/.test(raw)) return raw.startsWith('/') ? raw : `/${raw}`;
  const mangled = raw.replace(/\\/g, '/');
  const [pathPart, query = ''] = mangled.split('?');
  const routes = await api.get('/client/routes');
  const match = (Array.isArray(routes) ? routes : [])
    .map((route) => route.path)
    .filter((path) => typeof path === 'string' && pathPart.toLowerCase().endsWith(path.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (!match) {
    throw new UsageError(`页面路径被终端改写成了 ${raw}，请改写成不带斜杠的形式，例如 undersilicon open plays`, 'open');
  }
  return query ? `${match}?${query}` : match;
}

async function open(ctx) {
  const { api, out, json, baseUrl, parsed } = ctx;
  const input = parsed.positionals[0];
  if (!input) throw new UsageError('缺少页面路径，用法: undersilicon open <path> [--no-show]', 'open');
  const show = parsed.values['no-show'] !== true;
  const target = await resolveRoutePath(api, input);
  const result = await api.post('/client/navigate', { path: target, show });
  const payload = { ok: true, command: 'open', baseUrl, path: target, show, result };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.kv({
    路径: target,
    窗口: JSON.stringify(result?.window ?? null),
    显示窗口: show
  });
}

async function screenshot(ctx) {
  const { api, out, json, baseUrl, parsed } = ctx;
  const jpeg = parsed.values.jpeg === true;
  const format = jpeg ? 'jpeg' : 'png';
  const maxRaw = parsed.values['max-width'];
  const maxWidth = maxRaw === undefined || maxRaw === true ? undefined : Number(maxRaw);
  if (maxWidth !== undefined && (!Number.isInteger(maxWidth) || maxWidth <= 0)) {
    throw new UsageError(`--max-width 需要正整数，收到: ${maxRaw}`, 'screenshot');
  }
  const result = await api.post('/client/screenshot', { format, maxWidth }, { timeoutMs: 30000 });
  const data = String(result?.data || '');
  if (!data) throw new UsageError('截图接口没有返回图像数据', 'screenshot');
  const defaultName = `undersilicon-${timestamp()}.${jpeg ? 'jpg' : 'png'}`;
  const file = path.resolve(parsed.positionals[0] || defaultName);
  const buffer = Buffer.from(data, 'base64');
  fs.writeFileSync(file, buffer);
  const payload = {
    ok: true, command: 'screenshot', baseUrl, file,
    mime: result?.mime || (jpeg ? 'image/jpeg' : 'image/png'),
    width: result?.width ?? null,
    height: result?.height ?? null,
    bytes: buffer.length
  };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.kv({
    文件: file,
    尺寸: `${payload.width}x${payload.height}`,
    格式: payload.mime,
    大小: `${buffer.length} 字节`
  });
}

module.exports = [
  {
    name: 'window',
    description: '控制客户端窗口（显示/隐藏/聚焦/最小化/最大化/还原）',
    usage: `undersilicon window <${WINDOW_ACTIONS.join('|')}>`,
    examples: ['undersilicon window show', 'undersilicon window hide'],
    write: false,
    run: windowAction
  },
  {
    name: 'routes',
    description: '列出可导航页面',
    usage: 'undersilicon routes [--json]',
    examples: ['undersilicon routes'],
    write: false,
    run: routes
  },
  {
    name: 'open',
    description: '在客户端打开页面',
    usage: 'undersilicon open <path> [--no-show]',
    examples: ['undersilicon open /devices', 'undersilicon open /games --no-show'],
    write: false,
    run: open
  },
  {
    name: 'screenshot',
    description: '截取客户端窗口（base64 落盘）',
    usage: 'undersilicon screenshot [文件] [--max-width N] [--jpeg]',
    examples: ['undersilicon screenshot', 'undersilicon screenshot shot.jpg --jpeg --max-width 1280'],
    write: false,
    run: screenshot
  }
];
