// 冒烟用的假 mobile 账号服务：三个固定 Bearer token。
// 用法：node tools/fake-identity.js [port]
'use strict';

const http = require('http');

const PORT = Number(process.argv[2] || 8791);
const USERS = {
  'author-token': { id: 'mobile-author', email: 'author@example.com', provider: 'email', isAdmin: false },
  'author2-token': { id: 'mobile-author2', email: 'author2@example.com', provider: 'email', isAdmin: false },
  'admin-token': { id: 'mobile-admin', email: 'admin@example.com', provider: 'email', isAdmin: true },
};

http.createServer((req, res) => {
  if (req.url !== '/me') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/, '');
  const user = USERS[token];
  res.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(user ? { user } : { error: { message: 'unauthorized' } }));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`fake identity listening on http://127.0.0.1:${PORT}`);
});
