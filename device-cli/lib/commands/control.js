'use strict';

const { UsageError } = require('../errors');
const { parseKeyValueTokens, parseJsonObject } = require('../util');

// 能力到限幅字段的对应关系（与后端换算表一致），用于在输出里提示被缩放的值。
const FIELD_BY_CAPABILITY = {
  strength: 'power',
  shock: 'voltage',
  vibration: 'intensity',
  suction: 'intensity',
  estim: 'intensity',
  motors: 'motorLevel',
  pump: 'rate'
};

function clipInfo(capability, input, fieldCaps) {
  if (!fieldCaps) return null;
  const field = FIELD_BY_CAPABILITY[capability];
  if (!field) return null;
  const requested = Number(input?.value ?? input?.voltage ?? input?.intensity ?? input?.rate);
  if (!Number.isFinite(requested)) return null;
  const cap = Number(fieldCaps[field]);
  if (!Number.isFinite(cap)) return null;
  return {
    field,
    requested,
    applied: Math.min(requested, cap),
    capped: requested > cap,
    cap
  };
}

function leaseMeta(ctx) {
  const lease = ctx.lease;
  if (!lease) return null;
  return { clientId: lease.clientId, limits: lease.limits, fieldCaps: lease.fieldCaps };
}

async function control(ctx) {
  const { api, out, json, baseUrl, parsed } = ctx;
  const [id, capability, action] = parsed.positionals;
  if (!id || !capability || !action) {
    throw new UsageError(
      '缺少参数，用法: undersilicon control <id> <capability> <action> [key=value ...] | --input \'<json>\'',
      'control'
    );
  }
  const inline = parsed.positionals.slice(3);
  const fromJson = parseJsonObject(parsed.values.input, '--input');
  const input = { ...parseKeyValueTokens(inline, '动作参数'), ...fromJson };
  const result = await api.post(
    `/devices/${encodeURIComponent(id)}/capabilities/${encodeURIComponent(capability)}/actions/${encodeURIComponent(action)}`,
    { input }
  );
  const lease = leaseMeta(ctx);
  const scaling = clipInfo(capability, input, lease?.fieldCaps);
  const payload = { ok: true, command: 'control', baseUrl, id, capability, action, input, result, lease, scaling };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.kv({
    设备: id,
    能力: capability,
    动作: action,
    输入: JSON.stringify(input),
    结果: JSON.stringify(result ?? null)
  });
  if (lease) {
    out.text(`限幅: ${JSON.stringify(lease.limits)}`);
    out.text(`字段上限: ${JSON.stringify(lease.fieldCaps)}`);
  }
  if (scaling) {
    out.text(scaling.capped
      ? `注意: ${scaling.field} 请求 ${scaling.requested} 超过上限 ${scaling.cap}，后端会缩放到 ${scaling.applied}`
      : `${scaling.field} 请求 ${scaling.requested}，上限 ${scaling.cap}`);
  }
}

async function operation(ctx) {
  const { api, out, json, baseUrl, parsed } = ctx;
  const [id, operationKey] = parsed.positionals;
  if (!id || !operationKey) {
    throw new UsageError(
      '缺少参数，用法: undersilicon op <id> <operation> [key=value ...] | --params \'<json>\'',
      'op'
    );
  }
  const fromJson = parseJsonObject(parsed.values.params, '--params');
  const params = { ...parseKeyValueTokens(parsed.positionals.slice(2), '操作参数'), ...fromJson };
  const result = await api.post(
    `/devices/${encodeURIComponent(id)}/operations/${encodeURIComponent(operationKey)}`,
    { params }
  );
  const payload = {
    ok: true, command: 'op', baseUrl, id, operation: operationKey, params,
    result, lease: leaseMeta(ctx)
  };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.kv({
    设备: id,
    操作: operationKey,
    参数: JSON.stringify(params),
    结果: JSON.stringify(result ?? null)
  });
}

module.exports = [
  {
    name: 'control',
    description: '调用设备能力动作',
    usage: 'undersilicon control <id> <capability> <action> [key=value ...] [--input \'<json>\']',
    examples: ['undersilicon control dev01 strength set value=120', 'undersilicon control dev01 shock start --input \'{"voltage":30}\''],
    write: true,
    run: control
  },
  {
    name: 'op',
    description: '执行设备预置操作',
    usage: 'undersilicon op <id> <operation> [key=value ...] [--params \'<json>\']',
    examples: ['undersilicon op dev01 start', 'undersilicon op enema-1 pumpStart rate=60 ss=30'],
    write: true,
    run: operation
  }
];
