'use strict';

const { UsageError } = require('../errors');
const { streamEvents } = require('../sse');
const { formatTime, summarizeEvent } = require('../util');

function parseTypes(value) {
  if (value === undefined || value === true) return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function parsePositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new UsageError(`${label} 需要正整数，收到: ${value}`);
  }
  return number;
}

async function events(ctx) {
  const { api, out, json, parsed } = ctx;
  const types = parseTypes(parsed.values.types);
  const count = parsed.values.count === undefined || parsed.values.count === true
    ? 0
    : parsePositiveInt(parsed.values.count, '--count');
  const timeoutSec = parsed.values.timeout === undefined || parsed.values.timeout === true
    ? 0
    : Number(parsed.values.timeout);
  if (parsed.values.timeout !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) {
    throw new UsageError(`--timeout 需要正数秒，收到: ${parsed.values.timeout}`, 'events');
  }

  const controller = new AbortController();
  let received = 0;
  let timer = null;
  const stop = () => controller.abort();
  const onSigint = () => stop();
  process.once('SIGINT', onSigint);
  if (timeoutSec > 0) {
    timer = setTimeout(stop, timeoutSec * 1000);
    timer.unref?.();
  }

  await streamEvents({
    api,
    types,
    signal: controller.signal,
    onHello: (hello) => {
      if (!json && hello?.mode) out.errorLine(`事件流已连接（mode=${hello.mode}, seq=${hello.seq ?? 0}）`);
    },
    onEvent: (event) => {
      received += 1;
      if (json) {
        out.stdout.write(`${JSON.stringify(event)}\n`);
      } else {
        out.text(`${formatTime(event.ts)} ${summarizeEvent(event)}`);
      }
      if (count > 0 && received >= count) stop();
    }
  }).catch((error) => {
    if (controller.signal.aborted) return;
    throw error;
  }).finally(() => {
    if (timer) clearTimeout(timer);
    process.removeListener('SIGINT', onSigint);
  });

  if (json && !ctx.quietSummary) {
    out.stderr.write(`已接收 ${received} 条事件\n`);
  }
}

async function recent(ctx) {
  const { api, out, json, baseUrl, parsed } = ctx;
  const limit = parsed.values.limit === undefined || parsed.values.limit === true
    ? 100
    : parsePositiveInt(parsed.values.limit, '--limit');
  const types = parseTypes(parsed.values.types);
  const rows = await api.get('/events/recent', { query: { limit, types: types.join(',') } });
  const list = Array.isArray(rows) ? rows : [];
  const payload = { ok: true, command: 'events:recent', baseUrl, limit, types, events: list, count: list.length };
  if (json) {
    out.jsonOut(payload);
    return;
  }
  out.result(payload, {
    title: `最近事件（${list.length} 条）`,
    rows: list.map((event) => ({
      time: formatTime(event.ts),
      type: event.type || '',
      summary: summarizeEvent(event)
    })),
    headers: ['time', 'type', 'summary']
  });
}

module.exports = [
  {
    name: 'events',
    description: '订阅全局事件流（device/game/session/client）',
    usage: 'undersilicon events [--types device,game] [--count N] [--timeout 秒] [--json]',
    examples: [
      'undersilicon events --types device,game',
      'undersilicon events --count 10 --timeout 30 --json'
    ],
    write: false,
    run: events
  },
  {
    name: 'events:recent',
    description: '查看最近事件（环形缓冲）',
    usage: 'undersilicon events:recent [--limit N] [--types device,game]',
    examples: ['undersilicon events:recent --limit 20 --types game'],
    write: false,
    run: recent
  }
];
