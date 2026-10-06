// 冒烟用的假 OpenPanel：按月份返回预置的 game_stop / game_exit 事件。
// 用法：node tools/fake-openpanel.js [port]
'use strict';

const http = require('http');

const PORT = Number(process.argv[2] || 8790);

// 2026-09 的两场游戏：game-a 25 次有效游玩，game-b 8 次（低于默认入围门槛）。
function rows() {
  const out = [];
  const push = (id, gameID, index, when, extra) => {
    out.push({
      id: `${id}-${index}`,
      name: 'game_stop',
      createdAt: when,
      profileId: `profile-${index}`,
      properties: Object.assign({
        game_id: gameID,
        source: 'community',
        duration_ms: 600000,
        device_count: 1,
        device_macs: `AA:BB:CC:00:00:${String(index).padStart(2, '0')}`,
      }, extra || {}),
    });
  };
  for (let index = 0; index < 25; index++) {
    push('a', 'smoke-game-a', index, '2026-09-10T12:00:00Z');
  }
  for (let index = 0; index < 8; index++) {
    push('b', 'smoke-game-b', index, '2026-09-11T12:00:00Z');
  }
  // 官方游戏（没有社区 release）与时长不足的事件都不该计入。
  push('official', 'smoke-official', 1, '2026-09-12T12:00:00Z');
  push('short', 'smoke-game-a', 90, '2026-09-12T12:00:00Z', { duration_ms: 30000 });
  return out;
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== '/api/export/events') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  const offset = Number(url.searchParams.get('offset') || 0);
  const all = rows();
  const page = all.slice(offset, offset + Number(url.searchParams.get('limit') || 1000));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: page }));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`fake openpanel listening on http://127.0.0.1:${PORT}/api`);
});
