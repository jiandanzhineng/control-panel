'use strict';

const GLOBAL_OPTIONS = [
  ['--api <url>', 'API 地址，别名 --base-url/-b，可不带 /api（env UNDERSILICON_API）'],
  ['--json', '输出 JSON（兼容 --format=json、-f json）'],
  ['--limit <0-100>', '输出限幅百分比（env UNDERSILICON_LIMIT）'],
  ['--cap-limit shock=30,...', '按能力设置上限：strength/shock/vibration/suction/estim/motors/pump'],
  ['--lease-ttl <5-600>', 'agent 租约秒数，默认 600'],
  ['-h, --help', '帮助；help [命令] 查看单个命令'],
  ['--version', '显示版本']
];

function commandRows(commands) {
  return commands.map((command) => ({
    command: command.name,
    description: command.description,
    aliases: Array.isArray(command.aliases) ? command.aliases.join(', ') : ''
  }));
}

function showList({ commands, out, json, version, baseUrl }) {
  if (json) {
    out.jsonOut({
      ok: true,
      command: 'help',
      version,
      baseUrl,
      commands: commands.map((command) => ({
        name: command.name,
        aliases: command.aliases || [],
        description: command.description,
        usage: command.usage
      })),
      options: GLOBAL_OPTIONS.map(([name, description]) => ({ name, description }))
    });
    return;
  }
  out.text(`undersilicon-cli ${version}`);
  out.text('给用户和 AI agent 用的硅基之下控制中心命令行工具');
  out.text('');
  out.table(commandRows(commands), ['command', 'description', 'aliases']);
  out.text('');
  out.text('全局选项');
  out.table(GLOBAL_OPTIONS.map(([name, description]) => ({ option: name, description })), ['option', 'description']);
  out.text('');
  out.text('示例: undersilicon devices --json');
  out.text('      undersilicon control dev01 strength set value=120 --limit 50');
}

function showCommand({ command, out, json, baseUrl }) {
  if (json) {
    out.jsonOut({
      ok: true, command: 'help', topic: command.name, baseUrl,
      description: command.description,
      usage: command.usage,
      aliases: command.aliases || [],
      examples: command.examples || [],
      advanced: command.advanced === true
    });
    return;
  }
  out.text(`命令: ${command.name}`);
  out.text(command.description);
  if (Array.isArray(command.aliases) && command.aliases.length) {
    out.text(`别名: ${command.aliases.join(', ')}`);
  }
  out.text('');
  out.text(`用法: ${command.usage}`);
  if (command.advanced) out.text('（高级用法：直接发送原始报文，开限幅时仍受租约校验）');
  if (Array.isArray(command.examples) && command.examples.length) {
    out.text('');
    out.text('示例:');
    for (const example of command.examples) out.text(`  ${example}`);
  }
  out.text('');
  out.text('全局选项见 undersilicon --help');
}

module.exports = { GLOBAL_OPTIONS, showList, showCommand };
