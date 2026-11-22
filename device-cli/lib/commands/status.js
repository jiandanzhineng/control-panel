'use strict';

function classifyMode(status) {
  if (!status || status.active !== true) return 'local';
  const projectionRoom = status.links?.projection?.roomId;
  if (status.role === 'operator' && status.authorized === true && projectionRoom) return 'remote-operator';
  if (status.role === 'owner' && status.authorized === true) return 'remote-controlled';
  return 'local';
}

async function safeGet(api, path) {
  try {
    return { supported: true, data: await api.get(path) };
  } catch (error) {
    if (error.status === 404 || error.status === 405) return { supported: false, data: null };
    throw error;
  }
}

async function run(ctx) {
  const { api, out, json, baseUrl } = ctx;
  const [client, session, game, lease] = await Promise.all([
    safeGet(api, '/client/state'),
    safeGet(api, '/remote-session/status'),
    safeGet(api, '/games/status'),
    safeGet(api, '/agent-control/status')
  ]);
  const payload = {
    ok: true,
    command: 'status',
    baseUrl,
    client: client.data,
    clientSupported: client.supported,
    session: session.data,
    mode: classifyMode(session.data),
    game: game.data,
    agentLease: lease.data,
    agentLeaseSupported: lease.supported
  };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.text('客户端');
  if (!client.supported) {
    out.kv({ 状态: '当前客户端不支持客户端控制接口，请更新客户端' });
  } else {
    const state = client.data || {};
    if (!state.available) {
      out.kv({ 可用: '否（客户端窗口未运行，只有后端；窗口/截图/页面命令不可用）' });
    } else out.kv({
      可用: '是',
      版本: state.version ?? '',
      路由: state.route ?? '',
      窗口: state.window ? JSON.stringify(state.window) : '',
      语言: state.locale ?? ''
    });
  }
  out.text('');
  out.text('运行模式');
  out.kv({ 模式: payload.mode, 会话: session.data?.sessionId ?? '', 角色: session.data?.role ?? '' });
  out.text('');
  out.text('当前游戏');
  out.kv({
    运行中: game.data?.running ?? '',
    游戏: game.data?.gameId ?? '',
    载体: game.data?.runtimeMode ?? game.data?.source ?? ''
  });
  out.text('');
  out.text('Agent 租约');
  if (!lease.supported) {
    out.kv({ 状态: '当前客户端不支持 agent 租约，请更新客户端' });
  } else {
    out.kv({
      生效: lease.data?.active ?? false,
      租约数: Array.isArray(lease.data?.leases) ? lease.data.leases.length : 0
    });
    for (const item of lease.data?.leases || []) {
      out.kv({
        客户端: item.clientId,
        剩余秒: item.ttlRemainingSec,
        限幅: JSON.stringify(item.limits || {}),
        字段上限: JSON.stringify(item.fieldCaps || {})
      }, ['字段', '值']);
    }
  }
}

module.exports = {
  name: 'status',
  description: '客户端状态、运行模式、当前游戏与 agent 租约',
  usage: 'undersilicon status',
  examples: ['undersilicon status', 'undersilicon status --json'],
  write: false,
  run
};
