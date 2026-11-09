'use strict';

const { UsageError } = require('../errors');
const { pickPositional } = require('../util');

// 原始报文按 JSON 解析，失败则按字符串发送（与旧版行为一致）。
function parseMessage(input) {
  if (input === '') return '';
  try { return JSON.parse(input); } catch { return input; }
}

// 高级用法：直接发原始 MQTT 报文。开限幅时后端仍会按租约校验并钳制输出。
async function run(ctx) {
  const { api, out, json, baseUrl, parsed } = ctx;
  const deviceId = pickPositional(parsed.positionals, 0, ['deviceId', 'id'], parsed.values);
  if (!deviceId) {
    throw new UsageError(
      '缺少设备 ID，用法: undersilicon mqtt:publish <deviceId> [topic] <payload>',
      'mqtt:publish'
    );
  }
  const restCount = parsed.positionals.length - 1;
  const flagTopic = parsed.values.topic !== undefined && parsed.values.topic !== true
    ? String(parsed.values.topic)
    : '';
  const flagPayload = parsed.values.payload !== undefined && parsed.values.payload !== true
    ? String(parsed.values.payload)
    : '';
  let topic = flagTopic;
  let payloadRaw = flagPayload;
  if (restCount >= 2) {
    topic = topic || parsed.positionals[1];
    payloadRaw = payloadRaw || parsed.positionals[2];
  } else if (restCount === 1) {
    payloadRaw = payloadRaw || parsed.positionals[1];
  }
  topic = topic || `/drecv/${deviceId}`;
  const message = parseMessage(payloadRaw);
  const result = await api.post('/mqtt-client/publish', { topic, message });
  const payload = {
    ok: Boolean(result?.ok), command: 'mqtt:publish', baseUrl, deviceId,
    topic, topicAutoByDeviceId: !flagTopic && !(restCount >= 2), message, result,
    lease: ctx.lease ? { clientId: ctx.lease.clientId, fieldCaps: ctx.lease.fieldCaps } : null
  };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.kv({
    设备: deviceId,
    主题: topic,
    消息: JSON.stringify(message),
    结果: JSON.stringify(result ?? null)
  });
}

module.exports = {
  name: 'mqtt:publish',
  description: '发送原始 MQTT 报文（高级用法）',
  usage: 'undersilicon mqtt:publish <deviceId> [topic] <payload>',
  examples: [
    'undersilicon mqtt:publish dev01 \'{"method":"heartbeat"}\'',
    'undersilicon mqtt:publish dev01 /custom/topic \'{"method":"stop"}\''
  ],
  write: true,
  advanced: true,
  run
};
