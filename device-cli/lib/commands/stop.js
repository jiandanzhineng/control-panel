'use strict';

function stepResult(name, ok, detail, error) {
  return {
    step: name,
    ok,
    ...(detail !== undefined ? { detail } : {}),
    ...(error ? { error } : {})
  };
}

async function run(ctx) {
  const { api, out, json, config } = ctx;
  const raw = ctx.parsed.values.reason;
  const reason = raw !== undefined && raw !== true ? String(raw).slice(0, 160) : '';
  const steps = [];

  // 步骤 1：设备级急停。远程主控模式下会返回 423，改用远程急停接口。
  try {
    const body = { clientId: config.clientId };
    if (reason) body.reason = reason;
    const result = await api.post('/device-watchdog/stop-all', body, { timeoutMs: 30000 });
    steps.push(stepResult('device-watchdog/stop-all', true, result));
  } catch (error) {
    if (error.status === 423) {
      try {
        const result = await api.post('/remote-session/emergency-stop', {}, { timeoutMs: 30000 });
        steps.push(stepResult('remote-session/emergency-stop', true, result));
      } catch (fallbackError) {
        steps.push(stepResult('remote-session/emergency-stop', false, undefined, {
          code: fallbackError.code,
          message: fallbackError.message,
          status: fallbackError.status || 0
        }));
      }
    } else {
      steps.push(stepResult('device-watchdog/stop-all', false, undefined, {
        code: error.code,
        message: error.message,
        status: error.status || 0
      }));
    }
  }

  // 步骤 2：停止当前玩法（含 HostRuntime）。
  try {
    const result = await api.post('/games/stop-current', {}, { timeoutMs: 30000 });
    steps.push(stepResult('games/stop-current', true, result));
  } catch (error) {
    steps.push(stepResult('games/stop-current', false, undefined, {
      code: error.code,
      message: error.message,
      status: error.status || 0
    }));
  }

  const failed = steps.filter((step) => !step.ok);
  const payload = { ok: failed.length === 0, command: 'stop', reason: reason || null, steps };
  if (json) {
    out.jsonOut(payload);
  } else {
    out.text('急停');
    for (const step of steps) {
      const status = step.ok ? '完成' : `失败（${step.error.code}: ${step.error.message}）`;
      const detail = step.ok && step.detail !== undefined ? ` ${JSON.stringify(step.detail)}` : '';
      out.text(`- ${step.step}：${status}${detail}`);
    }
  }
  // 步骤结果已输出（JSON 时是完整 {ok:false, steps}），这里只标记退出码。
  if (failed.length > 0) {
    ctx.exitCode = 1;
    if (!json) out.errorLine(`急停有 ${failed.length} 个步骤失败`);
  }
}

module.exports = {
  name: 'stop',
  description: '急停：停止所有设备输出并停止当前游戏',
  usage: 'undersilicon stop [--reason 文本]',
  examples: ['undersilicon stop', 'undersilicon stop --reason "测试结束"'],
  write: true,
  noLease: true,
  run
};
