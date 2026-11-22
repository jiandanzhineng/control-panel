#!/usr/bin/env node
'use strict';

const { parseArgv } = require('./lib/args');
const { resolveConfig } = require('./lib/config');
const { createOutput } = require('./lib/output');
const { createApi, describeError } = require('./lib/api');
const { ensureLease } = require('./lib/lease');
const { UsageError } = require('./lib/errors');
const { showList, showCommand } = require('./lib/help');
const pkg = require('./package.json');

function buildRegistry() {
  const commands = [];
  for (const mod of [
    require('./lib/commands/status'),
    ...require('./lib/commands/devices'),
    ...require('./lib/commands/control'),
    require('./lib/commands/stop'),
    ...require('./lib/commands/games'),
    ...require('./lib/commands/client'),
    ...require('./lib/commands/events'),
    require('./lib/commands/lease'),
    require('./lib/commands/mqtt')
  ]) {
    commands.push(mod);
  }
  return commands;
}

function resolveCommand(commands, name) {
  const direct = commands.find((command) => command.name === name);
  if (direct) return direct;
  return commands.find((command) => Array.isArray(command.aliases) && command.aliases.includes(name)) || null;
}

function printUsageError(error, { out, json, commands, command }) {
  const topic = command || resolveCommand(commands, error.command);
  const message = error.message;
  if (json) {
    out.jsonOut({ ok: false, error: { code: 'USAGE_ERROR', message, status: 0 } });
    return;
  }
  out.errorLine(`错误: ${message}`);
  if (topic) {
    out.errorLine(`用法: ${topic.usage}`);
    if (Array.isArray(topic.examples) && topic.examples.length > 0) {
      out.errorLine(`示例: ${topic.examples[0]}`);
    }
  } else {
    out.errorLine('运行 undersilicon --help 查看全部命令');
  }
}

function printRuntimeError(error, { out, json, baseUrl }) {
  const info = describeError(error, baseUrl);
  if (json) {
    out.jsonOut({ ok: false, error: { code: info.code, message: info.message, status: info.status } });
    return;
  }
  const suffix = info.status ? `（${info.code}, HTTP ${info.status}）` : `（${info.code}）`;
  out.errorLine(`错误: ${info.message}${suffix}`);
}

async function main(argv = process.argv.slice(2)) {
  const commands = buildRegistry();
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    const out = createOutput({ json: false });
    printUsageError(error, { out, json: false, commands });
    process.exitCode = 2;
    return;
  }
  const config = resolveConfig(parsed);
  const out = createOutput({ json: config.json });
  const wanted = parsed.command;
  const command = resolveCommand(commands, wanted);

  if (parsed.values.version === true) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  if (parsed.values.help === true || wanted === 'help') {
    const topicName = wanted === 'help' ? parsed.positionals[0] : wanted;
    const topic = topicName ? resolveCommand(commands, topicName) : null;
    if (topicName && !topic) {
      printUsageError(new UsageError(`未知命令: ${topicName}`), { out, json: config.json, commands });
      process.exitCode = 2;
      return;
    }
    if (topic) {
      showCommand({ command: topic, out, json: config.json, baseUrl: config.baseUrl });
    } else {
      showList({ commands, out, json: config.json, version: pkg.version, baseUrl: config.baseUrl });
    }
    return;
  }
  if (!command) {
    printUsageError(new UsageError(`未知命令: ${wanted}`), { out, json: config.json, commands });
    process.exitCode = 2;
    return;
  }

  const api = createApi({ baseUrl: config.baseUrl, clientId: config.clientId });
  const ctx = {
    parsed, config, api, out, json: config.json, baseUrl: config.baseUrl,
    lease: null, command
  };
  try {
    if (config.limits && command.write === true && command.noLease !== true) {
      ctx.lease = await ensureLease(api, config);
    }
    await command.run(ctx);
    if (ctx.exitCode) process.exitCode = ctx.exitCode;
  } catch (error) {
    if (error instanceof UsageError || error?.name === 'USAGE_ERROR') {
      printUsageError(error, { out, json: config.json, commands, command });
      process.exitCode = 2;
      return;
    }
    printRuntimeError(error, { out, json: config.json, baseUrl: config.baseUrl });
    process.exitCode = 1;
  }
}

if (require.main === module) {
  // 输出接到 head 等提前关闭的管道时静默退出，不打印 EPIPE 堆栈。
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error) => {
      if (error && error.code === 'EPIPE') process.exit(process.exitCode || 0);
      throw error;
    });
  }
  main().catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, buildRegistry };
