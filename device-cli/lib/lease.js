'use strict';

const { ApiError } = require('./errors');

/**
 * 在限幅生效时创建 agent 租约。404/405 视为客户端不支持限幅：必须失败退出，
 * 不能静默降级为不限幅。
 */
async function ensureLease(api, config, { enabled = true } = {}) {
  if (!enabled || !config.limits) return null;
  let lease;
  try {
    lease = await api.post('/agent-control/lease', {
      clientId: config.clientId,
      ttlSec: config.leaseTtl,
      limits: config.limits
    }, { timeoutMs: 15000 });
  } catch (error) {
    if (error.status === 404 || error.status === 405) {
      throw new ApiError('当前客户端不支持限幅，请升级硅基之下控制中心', {
        code: 'AGENT_LIMIT_UNSUPPORTED',
        status: error.status,
        path: '/agent-control/lease'
      });
    }
    throw error;
  }
  api.setClientId(config.clientId);
  return lease;
}

async function releaseLease(api, clientId) {
  return api.delete(`/agent-control/lease/${encodeURIComponent(clientId)}`);
}

module.exports = { ensureLease, releaseLease };
