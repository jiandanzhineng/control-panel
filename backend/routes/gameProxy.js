const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const allowlist = require('../services/gameProxyAllowlist');

// 前缀式按需反向代理：/games/proxy/<host>/<path...>
// 收到前台请求时还原目标 URL，转发到第三方并原样返回。
// 轻量版：处理同域相对资源即可，不改写绝对 URL / cookie。
//
// 安全（审查报告 §2.4）：host 必须在白名单内（注册表源站 / 已保存的外部游戏 /
// 环境变量追加 / 开发态回环），否则 403；非白名单站点不代理，也不改响应头。
router.use('/', async (req, res) => {
  // req.path 形如 /<proto>/example.com/path/file.js 或（旧格式）/example.com/path/file.js
  const rest = req.path.replace(/^\/+/, '');
  const segs = rest.split('/');
  // 首段是协议则取出，否则默认 https（向后兼容旧格式）
  let proto = 'https';
  if (segs[0] === 'http' || segs[0] === 'https') {
    proto = segs.shift();
  }
  const host = segs.shift() || '';
  const pathPart = segs.length ? '/' + segs.join('/') : '/';
  if (!host) {
    res.status(400).send('Bad proxy target');
    return;
  }
  if (!allowlist.isAllowedHost(host)) {
    logger.warn('Game proxy host rejected', { host });
    res.status(403).send('Proxy host not allowed');
    return;
  }

  // 还原查询串，但剔除注入用的 deviceMap/params（仅供 Bridge 脚本用，不应转发给第三方）
  const incoming = new URLSearchParams(req.query);
  incoming.delete('deviceMap');
  incoming.delete('params');
  const qs = incoming.toString();
  const target = `${proto}://${host}${pathPart}${qs ? '?' + qs : ''}`;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      redirect: 'follow',
      headers: { 'user-agent': req.get('user-agent') || 'control-panel-proxy' },
    });

    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('content-type', ct);
    // 默认原样保留上游的嵌框限制；只有白名单里「需要被面板 iframe 嵌入」的站点
    // （注册表源站 / 已保存的外部游戏 / 开发态回环）才剥掉这两个头。
    for (const header of ['x-frame-options', 'content-security-policy']) {
      const value = upstream.headers.get(header);
      if (value) res.set(header, value);
    }
    if (allowlist.isEmbeddableHost(host)) {
      res.removeHeader('x-frame-options');
      res.removeHeader('content-security-policy');
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    logger.warn('Game proxy failed', { target, err: e?.message });
    res.status(502).send('Proxy fetch failed');
  }
});

module.exports = router;
