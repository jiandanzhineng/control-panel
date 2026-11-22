'use strict';

/**
 * agent 控制租约与输出限幅服务（A4）。
 *
 * 租约：POST /api/agent-control/lease 创建/续租，DELETE .../lease/:clientId 释放，
 *       GET .../status 只读。租约与设备看门狗相互独立：插件分别续租；
 *       租约过期只停「该 agent 发起的玩法」，设备级停机由看门狗负责。
 *
 * 来源：请求头 X-Agent-Client 由 middleware/agentRequestFilter 校验租约后放进
 * AsyncLocalStorage；玩法在 session 上记 agentClientId，并在执行设备意图时
 * 用 runWithClient 包住同步写设备调用（避免 setTimeout 丢上下文）。
 */

const { AsyncLocalStorage } = require('async_hooks');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');
const outputGuard = require('./agentOutputGuard');

const DEFAULT_TTL_SECONDS = 30;
const MIN_TTL_SECONDS = 5;
const MAX_TTL_SECONDS = 600;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,96}$/;

const leases = new Map();
const storage = new AsyncLocalStorage();
let generation = 0;

function createError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function validateClientId(clientId) {
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) {
    throw createError(
      'INVALID_CLIENT_ID',
      'clientId must be 1-96 characters using letters, numbers, dot, underscore, colon, or hyphen',
    );
  }
  return clientId;
}

function validateTtlSeconds(ttlSeconds) {
  const value = ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : ttlSeconds;
  if (!Number.isInteger(value) || value < MIN_TTL_SECONDS || value > MAX_TTL_SECONDS) {
    throw createError('INVALID_TTL_SECONDS', 'ttlSec must be an integer from 5 to 600');
  }
  return value;
}

function runWithClient(clientId, fn) {
  if (!clientId) return fn();
  return storage.run({ clientId }, fn);
}

function currentClientId() {
  return storage.getStore()?.clientId || null;
}

function resolveClientId(explicit) {
  return explicit || currentClientId();
}

function activeLease(clientId) {
  const lease = leases.get(clientId);
  if (!lease || Date.now() >= lease.expiresAtMs) return null;
  return lease;
}

function isLeaseActive(clientId) {
  return !!activeLease(clientId);
}

function publishLease(action, clientId, lease) {
  const description = outputGuard.describeLimits(lease.limits);
  eventBus.publish('agent.lease', {
    action,
    clientId,
    limits: { default: description.default, capabilities: description.capabilities },
    fieldCaps: description.fieldCaps,
    expiresAt: action === 'released' || action === 'expired'
      ? null
      : new Date(lease.expiresAtMs).toISOString(),
  });
}

function scheduleLease(clientId, lease) {
  const delay = Math.max(0, lease.expiresAtMs - Date.now());
  lease.timer = setTimeout(() => {
    void expireLease(clientId, lease.generation, lease.expiresAtMs).catch((error) => {
      logger.error('Agent lease expiry failed', {
        clientId,
        expiresAt: new Date(lease.expiresAtMs).toISOString(),
        error: error?.message || String(error),
      });
    });
  }, delay);
  lease.timer.unref?.();
}

function stopAgentPlays(clientId) {
  const stopped = [];
  try {
    const host = require('../game-runtime/gameHostService');
    if (typeof host.stopAgentPlay === 'function' && host.stopAgentPlay(clientId)) stopped.push('host');
  } catch (error) {
    logger.warn('Agent lease: stop host play failed', error?.message || String(error));
  }
  try {
    const bridge = require('./bridgeService');
    if (typeof bridge.stopAgentSession === 'function' && bridge.stopAgentSession(clientId)) stopped.push('bridge');
  } catch (error) {
    logger.warn('Agent lease: stop bridge play failed', error?.message || String(error));
  }
  return stopped;
}

async function expireLease(clientId, expectedGeneration, expectedExpiresAtMs) {
  const current = leases.get(clientId);
  if (!current
    || current.generation !== expectedGeneration
    || current.expiresAtMs !== expectedExpiresAtMs) {
    return;
  }
  if (Date.now() < current.expiresAtMs) {
    scheduleLease(clientId, current);
    return;
  }
  leases.delete(clientId);
  publishLease('expired', clientId, current);
  const stopped = stopAgentPlays(clientId);
  logger.info('Agent lease expired', { clientId, stopped });
}

/** 创建或续租；同一 clientId 再次调用会更新 limits 与过期时间。 */
function createLease({ clientId, ttlSec, ttlSeconds, limits } = {}) {
  const validClientId = validateClientId(clientId);
  const validTtl = validateTtlSeconds(ttlSec === undefined ? ttlSeconds : ttlSec);
  const previous = leases.get(validClientId);
  const action = previous ? 'updated' : 'created';
  if (previous?.timer) clearTimeout(previous.timer);
  const lease = {
    generation: ++generation,
    limits: outputGuard.normalizeLimits(limits),
    expiresAtMs: Date.now() + validTtl * 1000,
    timer: null,
  };
  leases.set(validClientId, lease);
  scheduleLease(validClientId, lease);
  publishLease(action, validClientId, lease);
  const description = outputGuard.describeLimits(lease.limits);
  return {
    ok: true,
    clientId: validClientId,
    ttlSec: validTtl,
    expiresAt: new Date(lease.expiresAtMs).toISOString(),
    limits: { default: description.default, capabilities: description.capabilities },
    fieldCaps: description.fieldCaps,
  };
}

function releaseLease(clientId) {
  const validClientId = validateClientId(clientId);
  const lease = leases.get(validClientId);
  if (lease?.timer) clearTimeout(lease.timer);
  leases.delete(validClientId);
  if (lease) publishLease('released', validClientId, lease);
  const stopped = lease ? stopAgentPlays(validClientId) : [];
  return { ok: true, clientId: validClientId, released: !!lease, stopped };
}

function getStatus() {
  const now = Date.now();
  const rows = [];
  for (const [clientId, lease] of leases) {
    if (lease.expiresAtMs <= now) continue;
    const description = outputGuard.describeLimits(lease.limits);
    rows.push({
      clientId,
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
      ttlRemainingSec: Math.ceil((lease.expiresAtMs - now) / 1000),
      limits: { default: description.default, capabilities: description.capabilities },
      fieldCaps: description.fieldCaps,
    });
  }
  return { active: rows.length > 0, leases: rows };
}

function leaseRequired(clientId) {
  return createError('AGENT_LEASE_REQUIRED', `agent 租约无效或已过期: ${clientId}`, 428);
}

function outputRejected(message) {
  return createError('AGENT_OUTPUT_REJECTED', message || 'agent 输出被限幅层拒绝', 400);
}

/**
 * 租约过期后的停止/归零也过一遍 0% 限幅：只保留停止指令或零值输出字段，
 * 防止借「停止」夹带未知字段/品牌命令。
 */
function sanitizeStopWithZeroLease(device, message) {
  const result = outputGuard.sanitizeDeviceMessage({
    device,
    message,
    limits: { default: 0, capabilities: {} },
  });
  if (!result.ok) throw outputRejected(result.message);
  return result.message;
}

/**
 * 最终设备报文闸门。无 agent 来源直接原样放行；租约过期时只放行停止/归零；
 * 有效租约下按字段上限钳制，未知字段/非法值抛 AGENT_OUTPUT_REJECTED。
 */
function guardDeviceMessage({ clientId, device, message } = {}) {
  const id = resolveClientId(clientId);
  if (!id) return { message };
  const lease = activeLease(id);
  if (!lease) {
    if (outputGuard.isStopMessage(message) || outputGuard.isZeroOutputMessage(message)) {
      return { message: sanitizeStopWithZeroLease(device, message) };
    }
    throw leaseRequired(id);
  }
  const result = outputGuard.sanitizeDeviceMessage({ device, message, limits: lease.limits });
  if (!result.ok) throw outputRejected(result.message);
  return { message: result.message };
}

/** 虚拟设备的语义能力调用闸门（真实设备最终仍会经过 guardDeviceMessage）。 */
function guardCapabilityInvoke({ clientId, device, capability, action, input } = {}) {
  const id = resolveClientId(clientId);
  if (!id) return { input };
  const lease = activeLease(id);
  const stopAction = String(action || '').toLowerCase() === 'stop';
  if (!lease) {
    if (stopAction) return { input: {} };
    throw leaseRequired(id);
  }
  const result = outputGuard.sanitizeCapabilityInvoke({
    device, capability, action, input, limits: lease.limits,
  });
  if (!result.ok) throw outputRejected(result.message);
  return { input: result.input };
}

/** 虚拟设备 bridge/宿主命令闸门：invoke / writeProps / sendMessage。 */
function guardVirtualCommand({ clientId, device, cmd } = {}) {
  const id = resolveClientId(clientId);
  if (!id || !cmd || typeof cmd !== 'object') return cmd;
  const lease = activeLease(id);
  if (!lease) {
    if (cmd.action === 'invoke') {
      if (String(cmd.actionName || '').toLowerCase() !== 'stop') throw leaseRequired(id);
      return { ...cmd, params: {} };
    }
    if (cmd.action === 'writeProps') {
      const message = { method: 'update', ...(cmd.props || {}) };
      if (!outputGuard.isZeroOutputMessage(message)) throw leaseRequired(id);
      const props = sanitizeStopWithZeroLease(device, message);
      delete props.method;
      return { ...cmd, props };
    }
    if (cmd.action === 'sendMessage') {
      if (!outputGuard.isStopMessage(cmd.msg)) throw leaseRequired(id);
      return { ...cmd, msg: sanitizeStopWithZeroLease(device, cmd.msg) };
    }
    throw leaseRequired(id);
  }
  if (cmd.action === 'invoke') {
    const guarded = guardCapabilityInvoke({
      clientId: id, device, capability: cmd.capability, action: cmd.actionName, input: cmd.params || {},
    });
    return { ...cmd, params: guarded.input };
  }
  if (cmd.action === 'writeProps') {
    const message = { method: 'update', ...(cmd.props || {}) };
    const guarded = guardDeviceMessage({ clientId: id, device, message });
    const props = { ...guarded.message };
    delete props.method;
    return { ...cmd, props };
  }
  if (cmd.action === 'sendMessage') {
    const guarded = guardDeviceMessage({ clientId: id, device, message: cmd.msg });
    return { ...cmd, msg: guarded.message };
  }
  return cmd;
}

function _resetForTests() {
  for (const lease of leases.values()) {
    if (lease.timer) clearTimeout(lease.timer);
  }
  leases.clear();
  generation = 0;
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS,
  createLease,
  releaseLease,
  getStatus,
  isLeaseActive,
  runWithClient,
  currentClientId,
  resolveClientId,
  guardDeviceMessage,
  guardCapabilityInvoke,
  guardVirtualCommand,
  stopAgentPlays,
  _resetForTests,
};
