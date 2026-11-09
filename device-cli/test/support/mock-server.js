'use strict';

const http = require('http');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function devices() {
  return [
    {
      id: 'pj-1', name: '往复电机', nickname: null, type: 'PJ01', connected: true,
      connectionType: 'mqtt', controlConnection: 'mqtt', connections: [{ type: 'mqtt' }],
      lastReport: new Date().toISOString(), data: { power: 0, report_delay_ms: 5000 }
    },
    {
      id: 'di-1', name: '电脉冲', nickname: null, type: 'DIANJI', connected: true,
      connectionType: 'mqtt', controlConnection: 'mqtt', connections: [{ type: 'mqtt' }],
      lastReport: new Date().toISOString(), data: { shock: 0, voltage: 0 }
    },
    {
      id: 'hr-1', name: '心率带', nickname: null, type: 'HR01', connected: false,
      connectionType: 'ble', controlConnection: 'ble', connections: [],
      lastReport: null, data: { heart_rate: 80 }
    }
  ];
}

function typeConfig(type) {
  const base = { type, name: type, capabilities: ['strength'], capabilityConfig: {}, monitorData: [], operations: [] };
  if (type === 'DIANJI') {
    return {
      ...base,
      capabilities: ['shock'],
      operations: [{ key: 'start', name: '启动', capability: 'shock', action: 'start', input: { voltage: 24 } }]
    };
  }
  if (type === 'HR01') return { ...base, capabilities: [] };
  return {
    ...base,
    operations: [{ key: 'start', name: '启动', capability: 'strength', action: 'set', input: { value: 255 } }]
  };
}

/**
 * 进程内 mock：覆盖 CLI 用到的全部后端接口。
 * 选项：clientAvailable（false 时 /client/* 返回 503）、remoteMode（stop-all 423）、
 * unsupportedLease（租约接口 404）、events 消息自动推送。
 */
function createMockServer(options = {}) {
  const state = {
    clientAvailable: options.clientAvailable !== false,
    remoteMode: options.remoteMode === true,
    unsupportedLease: options.unsupportedLease === true,
    failStopCurrent: options.failStopCurrent === true,
    unsupportedAgent: options.unsupportedAgent === true,
    requests: [],
    leases: new Map(),
    sse: new Set(),
    seq: 0,
    events: [],
    game: null
  };
  const server = http.createServer((req, res) => handle(state, req, res));
  return {
    state,
    start(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/api`));
      });
    },
    emit(event) {
      state.seq += 1;
      const stamped = { seq: state.seq, ts: new Date().toISOString(), ...event };
      state.events.push(stamped);
      for (const client of state.sse) {
        const match = client.types.length === 0
          || client.types.some((prefix) => String(stamped.type).startsWith(prefix));
        if (!match) continue;
        try { client.res.write(`id: ${stamped.seq}\ndata: ${JSON.stringify(stamped)}\n\n`); } catch { /* closed */ }
      }
      return stamped;
    },
    close() {
      for (const client of state.sse) { try { client.res.end(); } catch { /* ignore */ } }
      state.sse.clear();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { resolve({ raw: text }); }
    });
    req.on('error', () => resolve({}));
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function fail(res, status, code, message) {
  json(res, status, { code, message });
}

function fieldCapsFor(limits = {}) {
  const fallback = Number(limits.default ?? 0) || 0;
  const caps = limits.capabilities || {};
  const percent = (name) => Math.max(0, Math.min(100, Number(caps[name] ?? fallback) || 0));
  return {
    voltage: Math.floor(percent('shock')),
    power: Math.floor((percent('strength') / 100) * 255),
    intensity: Math.floor(Math.min(percent('shock'), percent('vibration'), percent('suction'), percent('estim'))),
    motorLevel: Math.floor((percent('motors') / 100) * 20),
    stroke: Math.floor((percent('motors') / 100) * 40),
    rate: Math.floor((percent('pump') / 100) * 255),
    seconds: Math.floor((percent('pump') / 100) * 60),
    ticks: Math.floor(percent('shock')),
    pump: Math.floor((percent('pump') / 100) * 255)
  };
}

function activeLease(state, clientId) {
  const lease = state.leases.get(clientId);
  if (!lease) return null;
  if (Date.now() >= lease.expiresAtMs) { state.leases.delete(clientId); return null; }
  return lease;
}

async function handle(state, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;
  const query = Object.fromEntries(url.searchParams);
  const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);
  state.requests.push({ method: req.method, path, query, body, headers: req.headers });
  if (state.unsupportedAgent && /^\/api\/(client|events|agent-control)(\/|$)/.test(path)) {
    return fail(res, 404, 'NOT_FOUND', 'not found');
  }

  if (path === '/api/events/stream' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const types = String(query.types || '').split(',').map((item) => item.trim()).filter(Boolean);
    const client = { res, types };
    state.sse.add(client);
    res.write(`data: ${JSON.stringify({ type: 'hello', seq: state.seq, mode: 'local' })}\n\n`);
    res.write(': ping\n\n');
    const cleanup = () => state.sse.delete(client);
    req.on('close', cleanup);
    req.on('error', cleanup);
    return;
  }
  if (path === '/api/events/recent' && req.method === 'GET') {
    const limit = Number(query.limit || 100);
    return json(res, 200, state.events.slice(-limit));
  }
  if (path === '/api/agent-control/lease' && req.method === 'POST') {
    if (state.unsupportedLease) return fail(res, 404, 'NOT_FOUND', 'not found');
    if (!body.clientId) return fail(res, 400, 'INVALID_CLIENT_ID', 'clientId required');
    const ttlSec = Number(body.ttlSec || 30);
    const limits = body.limits || {};
    const fieldCaps = fieldCapsFor(limits);
    state.leases.set(body.clientId, { limits, ttlSec, expiresAtMs: Date.now() + ttlSec * 1000, fieldCaps });
    return json(res, 200, {
      ok: true, clientId: body.clientId, ttlSec,
      expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString(), limits, fieldCaps
    });
  }
  if (path.startsWith('/api/agent-control/lease/') && req.method === 'DELETE') {
    if (state.unsupportedLease) return fail(res, 404, 'NOT_FOUND', 'not found');
    const clientId = decodeURIComponent(path.slice('/api/agent-control/lease/'.length));
    const released = state.leases.delete(clientId);
    return json(res, 200, { ok: true, clientId, released, stopped: released ? ['host'] : [] });
  }
  if (path === '/api/agent-control/status' && req.method === 'GET') {
    if (state.unsupportedLease) return fail(res, 404, 'NOT_FOUND', 'not found');
    const leases = [...state.leases].map(([clientId, lease]) => ({
      clientId, expiresAt: new Date(lease.expiresAtMs).toISOString(),
      ttlRemainingSec: Math.max(0, Math.ceil((lease.expiresAtMs - Date.now()) / 1000)),
      limits: lease.limits, fieldCaps: lease.fieldCaps
    }));
    return json(res, 200, { active: leases.length > 0, leases });
  }

  if (path === '/api/remote-session/status' && req.method === 'GET') {
    const remote = state.remoteMode;
    return json(res, 200, remote
      ? { active: true, role: 'operator', phase: 'active', sessionId: 's1', authorized: true, links: { projection: { roomId: 'r1' } } }
      : { active: false, role: null, phase: 'idle', authorized: false, links: {} });
  }
  if (path === '/api/remote-session/emergency-stop' && req.method === 'POST') {
    state.game = null;
    return json(res, 200, { ok: true, stopped: true });
  }
  if (path === '/api/device-watchdog/stop-all' && req.method === 'POST') {
    if (state.remoteMode) return fail(res, 423, 'REMOTE_LOCKED', '远程控制中不可用');
    if (!body.clientId) return fail(res, 400, 'INVALID_CLIENT_ID', 'clientId required');
    return json(res, 200, {
      ok: true, trigger: 'client-request', clientId: body.clientId,
      reason: body.reason || 'client-request', stopped: ['pj-1'], skipped: []
    });
  }
  if (path === '/api/client/state' && req.method === 'GET') {
    return json(res, 200, state.clientAvailable
      ? { available: true, version: 'test', window: { visible: true }, route: '/devices', locale: 'zh-CN' }
      : { available: false, version: 'test', window: null, route: null });
  }
  if (path.startsWith('/api/client/') && !state.clientAvailable) {
    return fail(res, 503, 'CLIENT_UNAVAILABLE', 'client control host is not registered');
  }
  if (path === '/api/client/routes' && req.method === 'GET') {
    return json(res, 200, [
      { path: '/devices', name: 'devices', title: '设备', titleKey: 'nav.devices' },
      { path: '/games', name: 'games', title: '游戏', titleKey: 'nav.games' }
    ]);
  }
  if (path === '/api/client/window' && req.method === 'POST') {
    return json(res, 200, { available: true, window: { visible: body.action !== 'hide' }, route: '/devices' });
  }
  if (path === '/api/client/navigate' && req.method === 'POST') {
    return json(res, 200, { available: true, window: { visible: body.show !== false }, route: body.path });
  }
  if (path === '/api/client/screenshot' && req.method === 'POST') {
    return json(res, 200, {
      mime: body.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      data: PNG_1X1, width: 1, height: 1
    });
  }
  if (path.startsWith('/api/client/games/') && path.endsWith('/launch') && req.method === 'POST') {
    if (!state.clientAvailable) return fail(res, 503, 'CLIENT_UNAVAILABLE', 'client control host is not registered');
    const id = path.split('/')[4];
    state.game = { id, source: 'client-launch' };
    return json(res, 200, {
      ok: true, gameId: id, mode: 'iframe', started: true,
      path: '/plays/game/current', state: { route: '/plays/game/current' }
    });
  }

  if (path === '/api/games' && req.method === 'GET') {
    return json(res, 200, [
      {
        id: 'demo', name: '演示玩法', type: 'html', gamePath: '/games/demo/index.html',
        devices: [{ id: 'motor', name: '主设备', capabilities: ['strength'] }],
        params: [{ key: 'speed', min: 0, max: 10 }]
      },
      {
        id: 'shared', name: '双载体玩法', type: 'html',
        devices: [{ id: 'punish', capabilities: ['shock'] }]
      }
    ]);
  }
  if (path === '/api/game-runtime/games' && req.method === 'GET') {
    return json(res, 200, [
      {
        id: 'host-demo', title: '宿主演示', runtimeMode: 'host',
        devices: [{ id: 'motor', capabilities: ['strength'] }]
      },
      { id: 'shared', title: '双载体玩法', runtimeMode: 'host', devices: [] }
    ]);
  }
  if (path === '/api/games/status' && req.method === 'GET') {
    return json(res, 200, {
      running: !!state.game, runtimeMode: state.game?.runtimeMode || null,
      sessionId: state.game ? 's1' : null, gameId: state.game?.id || null,
      deviceMap: {}, snapshot: null, source: state.game?.source || null, ended: false
    });
  }
  if (path === '/api/games/stop-current' && req.method === 'POST') {
    if (state.failStopCurrent) return fail(res, 500, 'GAME_STOP_FAILED', '停止失败');
    state.game = null;
    return json(res, 200, { ok: true, host: { stopped: true }, bridge: {} });
  }
  if (path === '/api/games/start' || (path.startsWith('/api/games/') && path.endsWith('/start') && req.method === 'POST')) {
    const id = path === '/api/games/start' ? '' : decodeURIComponent(path.split('/')[3]);
    state.game = { id, source: 'backend' };
    return json(res, 200, { ok: true, gamePath: '/games/demo/index.html', deviceMap: body.deviceMapping || {}, params: body.parameters || {} });
  }

  if (path === '/api/devices' && req.method === 'GET') {
    return json(res, 200, devices());
  }
  if (path === '/api/device-capabilities' && req.method === 'GET') {
    return json(res, 200, {
      capabilities: ['strength', 'shock', 'lock'],
      capabilityConfig: {
        strength: { key: 'strength', name: '强度控制', actionParams: { set: { value: { type: 'number', min: 0, max: 255, default: 0 } } } },
        shock: { key: 'shock', name: '电击控制', actionParams: { start: { voltage: { type: 'number', min: 0, max: 100, default: 24 } } } },
        lock: { key: 'lock', name: '锁控制', actionParams: { setOpen: { open: { type: 'boolean', default: false } } } }
      },
      typeCapabilityMap: { PJ01: ['strength'], DIANJI: ['shock'], HR01: [], CUNZHI01: ['strength', 'shock'] }
    });
  }
  if (path.startsWith('/api/device-types/') && path.endsWith('/config')) {
    const type = decodeURIComponent(path.split('/')[3]);
    return json(res, 200, typeConfig(type));
  }
  if (path === '/api/mqtt-client/publish' && req.method === 'POST') {
    return json(res, 200, { ok: true, accepted: true, count: 1 });
  }
  if (path.startsWith('/api/devices/') && req.method !== 'GET') {
    const raw = req.get?.('x-agent-client') || req.headers['x-agent-client'];
    if (raw && !activeLease(state, raw)) {
      return fail(res, 428, 'AGENT_LEASE_REQUIRED', 'agent 租约无效或已过期');
    }
  }
  if (path.startsWith('/api/devices/')) {
    const rest = path.slice('/api/devices/'.length).split('/');
    const id = decodeURIComponent(rest[0]);
    const device = devices().find((item) => item.id === id);
    if (!device) return fail(res, 404, 'DEVICE_NOT_FOUND', '设备不存在');
    if (rest.length === 1 && req.method === 'GET') return json(res, 200, device);
    if (rest.length === 1 && req.method === 'PATCH') {
      Object.assign(device, body);
      return json(res, 200, device);
    }
    if (rest[1] === 'capabilities' && rest[3] === 'actions' && req.method === 'POST') {
      return json(res, 200, { success: true, applied: body.input || {} });
    }
    if (rest[1] === 'operations' && req.method === 'POST') {
      return json(res, 200, { ok: true, operation: rest[2], params: body.params || {} });
    }
  }
  return fail(res, 404, 'NOT_FOUND', `no mock route for ${req.method} ${path}`);
}

module.exports = { createMockServer, PNG_1X1, fieldCapsFor, devices };
