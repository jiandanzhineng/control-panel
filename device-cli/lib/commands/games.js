'use strict';

const { UsageError } = require('../errors');
const { parseKeyValueTokens, parseJsonObject, parseIdList } = require('../util');

function carrierOf(game) {
  if (game?.runtimeMode === 'host' || game?.carrier === 'host') return 'host';
  return 'iframe';
}

function rolesOf(game) {
  const devices = Array.isArray(game?.devices) ? game.devices : [];
  return devices.map((device) => {
    const caps = Array.isArray(device?.capabilities) && device.capabilities.length
      ? `(${device.capabilities.join('/')})`
      : '';
    return `${device?.id || device?.key || ''}${caps}`;
  }).filter(Boolean).join(', ');
}

async function listGames(ctx) {
  const { api, out, json, baseUrl } = ctx;
  const pageGames = await api.get('/games');
  const hostGames = await api.get('/game-runtime/games').catch((error) => {
    if (error.status === 404) return [];
    throw error;
  });
  const byId = new Map();
  for (const game of Array.isArray(pageGames) ? pageGames : []) {
    byId.set(game.id, { ...game, carrier: carrierOf(game) });
  }
  for (const game of Array.isArray(hostGames) ? hostGames : []) {
    if (byId.has(game.id)) {
      const existing = byId.get(game.id);
      existing.carrier = existing.carrier === 'host' ? 'host' : `${existing.carrier}/host`;
      existing.devices = existing.devices?.length ? existing.devices : game.devices;
    } else {
      byId.set(game.id, { ...game, carrier: carrierOf(game) });
    }
  }
  const games = Array.from(byId.values());
  const payload = { ok: true, command: 'games', baseUrl, games, count: games.length };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.result(payload, {
    title: `游戏列表（${games.length} 个）`,
    rows: games.map((game) => ({
      id: game.id,
      name: game.name || game.title || '',
      carrier: game.carrier,
      roles: rolesOf(game)
    })),
    headers: ['id', 'name', 'carrier', 'roles']
  });
}

function buildLaunchInput(parsed) {
  const parameters = { ...parseJsonObject(parsed.values.params, '--params') };
  Object.assign(parameters, parseKeyValueTokens(parsed.multi.param, '--param'));
  const deviceMap = {};
  for (const token of parsed.multi.device) {
    const eq = token.indexOf('=');
    if (eq <= 0) throw new UsageError(`--device 需要 角色=设备ID 形式，收到: ${token}`);
    const role = token.slice(0, eq).trim();
    const ids = parseIdList(token.slice(eq + 1));
    if (!role || ids.length === 0) throw new UsageError(`--device 需要 角色=设备ID 形式，收到: ${token}`);
    deviceMap[role] = ids.length === 1 ? ids[0] : ids;
  }
  return { parameters, deviceMap, show: parsed.values['no-show'] !== true };
}

async function startGame(ctx) {
  const { api, out, json, baseUrl, parsed } = ctx;
  const id = parsed.positionals[0];
  if (!id) {
    throw new UsageError(
      '缺少游戏 ID，用法: undersilicon game:start <id> [--param k=v ...] [--device 角色=设备ID ...] [--params \'<json>\'] [--no-show]',
      'game:start'
    );
  }
  const { parameters, deviceMap, show } = buildLaunchInput(parsed);
  let via = 'client';
  let result;
  try {
    result = await api.post(`/client/games/${encodeURIComponent(id)}/launch`, {
      deviceMap, parameters, show
    }, { timeoutMs: 60000 });
  } catch (error) {
    if (error.status !== 503 || error.code !== 'CLIENT_UNAVAILABLE') throw error;
    via = 'backend';
    result = await api.post(`/games/${encodeURIComponent(id)}/start`, {
      deviceMapping: deviceMap,
      parameters,
      source: 'local',
      defer: false
    });
  }
  const payload = { ok: true, command: 'game:start', baseUrl, id, via, show, deviceMap, parameters, result };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.kv({
    游戏: id,
    启动路径: via === 'client' ? 'client launch' : 'backend start（客户端未就绪，已回退）',
    显示窗口: show,
    设备映射: JSON.stringify(deviceMap),
    参数: JSON.stringify(parameters),
    结果: JSON.stringify(result ?? null)
  });
}

async function stopGame(ctx) {
  const { api, out, json, baseUrl } = ctx;
  const result = await api.post('/games/stop-current', {}, { timeoutMs: 30000 });
  const payload = { ok: true, command: 'game:stop', baseUrl, result };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.kv({ 结果: JSON.stringify(result ?? null) });
}

async function gameStatus(ctx) {
  const { api, out, json, baseUrl } = ctx;
  const status = await api.get('/games/status');
  const payload = { ok: true, command: 'game:status', baseUrl, status };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.kv({
    运行中: status?.running ?? false,
    游戏: status?.gameId ?? '',
    载体: status?.runtimeMode ?? '',
    来源: status?.source ?? '',
    会话: status?.sessionId ?? '',
    设备映射: JSON.stringify(status?.deviceMap ?? {}),
    快照: JSON.stringify(status?.snapshot ?? null)
  });
}

module.exports = [
  {
    name: 'games',
    description: '列出游戏',
    usage: 'undersilicon games [--json]',
    examples: ['undersilicon games', 'undersilicon games --json'],
    write: false,
    run: listGames
  },
  {
    name: 'game:start',
    description: '启动游戏（优先客户端 launch，纯后端时回退）',
    usage: 'undersilicon game:start <id> [--param k=v ...] [--device 角色=设备ID ...] [--params \'<json>\'] [--no-show]',
    examples: [
      'undersilicon game:start demo --device motor=pj-1 --param speed=5',
      'undersilicon game:start host-demo --params \'{"duration":30}\' --no-show'
    ],
    write: true,
    run: startGame
  },
  {
    name: 'game:stop',
    description: '停止当前游戏（含 HostRuntime）',
    usage: 'undersilicon game:stop',
    examples: ['undersilicon game:stop'],
    write: true,
    run: stopGame
  },
  {
    name: 'game:status',
    description: '查看当前游戏状态',
    usage: 'undersilicon game:status [--json]',
    examples: ['undersilicon game:status'],
    write: false,
    run: gameStatus
  }
];
