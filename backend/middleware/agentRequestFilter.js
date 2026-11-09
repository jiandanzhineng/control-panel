// agent 请求标记（A4）：X-Agent-Client: <clientId>。
//
// - 带此头的设备写操作（能力动作、预置操作、message、改设备、batch、启动玩法……）
//   必须持有有效租约，否则 428 AGENT_LEASE_REQUIRED；
// - 停止类请求即使租约过期也放行（输出层也永远放行停止）；
// - 有效租约把 clientId 放进 AsyncLocalStorage，设备输出层据此钳制；
// - /agent-control 自身的租约接口不做租约校验（否则过期后就无法续租了）。
const agentControl = require('../services/agentControlService');
const outputGuard = require('../services/agentOutputGuard');
const { sendError } = require('../utils/http');

const AGENT_CLIENT_HEADER = 'x-agent-client';

// 会写设备/启停玩法的路径；读接口与窗口/截图/导航不受租约约束。
const DEVICE_WRITE_RULES = [
  { method: '*', pattern: /^\/devices(\/|$)/ },
  { method: 'POST', pattern: /^\/games\/[^/]+\/start$/ },
  { method: 'POST', pattern: /^\/games\/stop-current$/ },
  { method: 'POST', pattern: /^\/game-runtime\/(start|params|action|sensor|tick)$/ },
  { method: 'POST', pattern: /^\/client\/games\/[^/]+\/launch$/ },
  { method: '*', pattern: /^\/virtual-devices(\/|$)/ },
  { method: 'POST', pattern: /^\/mqtt-client(\/|$)/ },
];

function isDeviceWrite(method, path) {
  const verb = String(method || 'GET').toUpperCase();
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return false;
  return DEVICE_WRITE_RULES.some((rule) => (
    (rule.method === '*' || rule.method === verb) && rule.pattern.test(path)
  ));
}

function looksLikeStopRequest(req) {
  const path = String(req.path || '').toLowerCase();
  if (path === '/games/stop-current' || path === '/game-runtime/stop') return true;
  if (/(^|\/)stop(all)?($|\/)/.test(path) || path.endsWith('/stop')) return true;
  const body = req.body || {};
  if (String(body.operationKey || '').toLowerCase() === 'stop') return true;
  if (String(body.action || '').toLowerCase() === 'stop') return true;
  if (body.message && (outputGuard.isStopMessage(body.message) || outputGuard.isZeroOutputMessage(body.message))) return true;
  return false;
}

function agentRequestFilter(req, res, next) {
  const raw = req.get(AGENT_CLIENT_HEADER);
  if (raw === undefined) return next();
  const clientId = String(raw || '').trim();
  if (!clientId || clientId.length > 96 || !/^[A-Za-z0-9._:-]+$/.test(clientId)) {
    return sendError(res, 'INVALID_CLIENT_ID', 'X-Agent-Client 不是合法的 clientId', 400);
  }

  const path = String(req.path || '');
  if (/^\/agent-control(\/|$)/.test(path)) return next();

  req.agentClientId = clientId;
  const leaseActive = agentControl.isLeaseActive(clientId);
  if (!leaseActive && isDeviceWrite(req.method, path) && !looksLikeStopRequest(req)) {
    return sendError(
      res,
      'AGENT_LEASE_REQUIRED',
      'agent 租约无效或已过期，请先 POST /api/agent-control/lease',
      428,
    );
  }
  return agentControl.runWithClient(clientId, next);
}

module.exports = {
  AGENT_CLIENT_HEADER,
  isDeviceWrite,
  looksLikeStopRequest,
  agentRequestFilter,
};
