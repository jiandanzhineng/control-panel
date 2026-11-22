'use strict';

const { UsageError } = require('../errors');
const { getProperty, parseValueToken, pickPositional } = require('../util');

function toDeviceRow(device) {
  if (!device || typeof device !== 'object') return {};
  return {
    id: device.id || '',
    name: device.nickname || device.name || '',
    type: device.type || '',
    online: device.connected === true ? '在线' : '离线',
    connection: device.connectionType || device.controlConnection || ''
  };
}

async function listDevices(ctx) {
  const { api, out, json, baseUrl } = ctx;
  const list = await api.get('/devices');
  const devices = Array.isArray(list) ? list : [];
  const payload = { ok: true, command: 'devices', baseUrl, devices, count: devices.length };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.result(payload, {
    title: `设备列表（${devices.length} 台，${baseUrl}）`,
    rows: devices.map(toDeviceRow),
    headers: ['id', 'name', 'type', 'online', 'connection']
  });
}

function describeParams(actionParams) {
  const rows = [];
  for (const [action, fields] of Object.entries(actionParams || {})) {
    const params = Object.entries(fields || {}).map(([name, spec]) => ({ name, ...spec }));
    if (params.length === 0) {
      rows.push({ action, params: '-' });
      continue;
    }
    rows.push({
      action,
      params: params.map((param) => {
        const range = param.type === 'number'
          ? `${param.min ?? '-'}..${param.max ?? '-'}`
          : param.type || 'any';
        return `${param.name}:${range}${param.default !== undefined ? `=${param.default}` : ''}`;
      }).join(', ')
    });
  }
  return rows;
}

async function deviceDetail(ctx) {
  const { api, out, json, baseUrl, parsed } = ctx;
  const id = pickPositional(parsed.positionals, 0, ['id', 'deviceId'], parsed.values);
  if (!id) throw new UsageError('缺少设备 ID，用法: undersilicon device <id>', 'device');
  const device = await api.get(`/devices/${encodeURIComponent(id)}`);
  const [capabilities, typeConfig] = await Promise.all([
    api.get('/device-capabilities').catch((error) => {
      if (error.status === 404) return null;
      throw error;
    }),
    device?.type
      ? api.get(`/device-types/${encodeURIComponent(device.type)}/config`).catch((error) => {
        if (error.status === 404) return null;
        throw error;
      })
      : Promise.resolve(null)
  ]);
  const typeCaps = capabilities?.typeCapabilityMap?.[device?.type];
  const capabilityKeys = Array.isArray(typeCaps) && typeCaps.length
    ? typeCaps
    : (Array.isArray(typeConfig?.capabilities) ? typeConfig.capabilities : []);
  const definitions = capabilities?.capabilityConfig || {};
  const items = capabilityKeys.map((key) => {
    const def = definitions[key] || {};
    return {
      key,
      name: def.name || key,
      actions: Object.entries(def.actionParams || {}).map(([action, params]) => ({
        action,
        params: Object.entries(params || {}).map(([param, spec]) => ({ name: param, ...spec }))
      }))
    };
  });
  const operations = Array.isArray(typeConfig?.operations) ? typeConfig.operations : [];
  const payload = {
    ok: true, command: 'device', baseUrl, id, device,
    capabilities: items, operations,
    hasPresets: operations.length > 0
  };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.text(`设备 ${device?.id || id}`);
  out.kv({
    ID: device?.id || id,
    名称: device?.nickname || device?.name || '',
    类型: device?.type || '',
    状态: device?.connected ? '在线' : '离线',
    连接方式: device?.connectionType || device?.controlConnection || '',
    数据: JSON.stringify(device?.data || {})
  });
  out.text('');
  out.text('可用能力与动作参数');
  if (items.length === 0) {
    out.text('(无)');
  } else {
    const rows = [];
    for (const item of items) {
      if (item.actions.length === 0) rows.push({ capability: item.key, action: '-', params: '-' });
      for (const line of describeParams(Object.fromEntries(item.actions.map((a) => [a.action, Object.fromEntries(a.params.map((p) => [p.name, p]))])))) {
        rows.push({ capability: `${item.key}（${item.name}）`, action: line.action, params: line.params });
      }
    }
    out.table(rows, ['capability', 'action', 'params']);
  }
  out.text('');
  out.text('预置操作');
  if (operations.length === 0) {
    out.text('(无)');
  } else {
    out.table(operations.map((op) => ({
      key: op.key,
      名称: op.name || '',
      能力: op.capability || '',
      动作: op.action || '',
      输入: op.input ? JSON.stringify(op.input) : ''
    })), ['key', '名称', '能力', '动作', '输入']);
  }
}

async function deviceGet(ctx) {
  const { api, out, json, baseUrl, parsed } = ctx;
  const id = pickPositional(parsed.positionals, 0, ['id', 'deviceId'], parsed.values);
  const key = pickPositional(parsed.positionals, 1, ['key'], parsed.values);
  if (!id) throw new UsageError('缺少设备 ID，用法: undersilicon devices:get <id> [key]', 'devices:get');
  const device = await api.get(`/devices/${encodeURIComponent(id)}`);
  const value = key ? getProperty(device, key) : device;
  const payload = { ok: true, command: 'devices:get', baseUrl, id, key: key || null, value, device };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  if (key) {
    out.text(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? ''));
  } else {
    out.text(JSON.stringify(device, null, 2));
  }
}

async function deviceSet(ctx) {
  const { api, out, json, baseUrl, parsed } = ctx;
  const id = pickPositional(parsed.positionals, 0, ['id', 'deviceId'], parsed.values);
  const key = pickPositional(parsed.positionals, 1, ['key'], parsed.values);
  const rawValue = parsed.values.value !== undefined && parsed.values.value !== true
    ? String(parsed.values.value)
    : (parsed.positionals[2] ?? '');
  if (!id || !key) {
    throw new UsageError('缺少参数，用法: undersilicon devices:set <id> <key> <value>', 'devices:set');
  }
  const value = rawValue === '' ? '' : parseValueToken(rawValue);
  const device = await api.patch(`/devices/${encodeURIComponent(id)}`, { [key]: value });
  const payload = {
    ok: true, command: 'devices:set', baseUrl, id, key,
    value, updated: getProperty(device, key), device
  };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.kv({ 设备: id, 字段: key, 写入: JSON.stringify(value), 当前值: JSON.stringify(payload.updated) });
}

module.exports = [
  {
    name: 'devices',
    aliases: ['devices:list'],
    description: '列出设备',
    usage: 'undersilicon devices [--json]',
    examples: ['undersilicon devices', 'undersilicon devices --json'],
    write: false,
    run: listDevices
  },
  {
    name: 'device',
    description: '设备详情、可用能力、动作参数范围与预置操作',
    usage: 'undersilicon device <id>',
    examples: ['undersilicon device dev01', 'undersilicon device dev01 --json'],
    write: false,
    run: deviceDetail
  },
  {
    name: 'devices:get',
    description: '读取设备属性（支持点号路径）',
    usage: 'undersilicon devices:get <id> [key]',
    examples: ['undersilicon devices:get dev01', 'undersilicon devices:get dev01 data.power'],
    write: false,
    run: deviceGet
  },
  {
    name: 'devices:set',
    description: '更新设备属性',
    usage: 'undersilicon devices:set <id> <key> <value>',
    examples: ['undersilicon devices:set dev01 name 客厅设备'],
    write: true,
    run: deviceSet
  }
];
