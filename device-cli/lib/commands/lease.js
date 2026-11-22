'use strict';

const { releaseLease } = require('../lease');

async function run(ctx) {
  const { api, out, json, baseUrl, config } = ctx;
  const result = await releaseLease(api, config.clientId);
  const payload = { ok: true, command: 'lease:release', baseUrl, clientId: config.clientId, result };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.kv({
    客户端: config.clientId,
    已释放: result?.released ?? true,
    已停止玩法: JSON.stringify(result?.stopped ?? [])
  });
}

module.exports = {
  name: 'lease:release',
  description: '释放 agent 租约（会停掉该 agent 启动的游戏）',
  usage: 'undersilicon lease:release',
  examples: ['undersilicon lease:release'],
  write: true,
  noLease: true,
  run
};
