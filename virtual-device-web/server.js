#!/usr/bin/env node
// 静态文件服务器：只为把 index.html 和 mqtt.min.js 送进浏览器。
// 本体逻辑全在浏览器里跑，这个进程不碰 MQTT、不碰 control-panel。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;

// mqtt.min.js 从 backend 的 node_modules 借用（只读一个文件，不产生代码依赖）。
// 借不到就退到 CDN，页面里有提示。
const MQTT_CANDIDATES = [
  path.join(ROOT, 'vendor', 'mqtt.min.js'),
  path.join(ROOT, '..', 'backend', 'node_modules', 'mqtt', 'dist', 'mqtt.min.js'),
  path.join(ROOT, '..', 'node_modules', 'mqtt', 'dist', 'mqtt.min.js'),
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function findMqttBundle() {
  for (const p of MQTT_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/vendor/mqtt.min.js') {
    const p = findMqttBundle();
    if (!p) return send(res, 404, 'mqtt.min.js not found');
    return send(res, 200, fs.readFileSync(p), MIME['.js']);
  }

  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  // 防目录穿越
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'not found');
  }
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`虚拟设备网页: http://${HOST}:${PORT}`);
    console.log(`mqtt 库: ${findMqttBundle() || '未找到（页面会提示）'}`);
  });
}

module.exports = { server, findMqttBundle, PORT, HOST };
