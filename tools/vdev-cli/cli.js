#!/usr/bin/env node

const { createApiClient, normalizeBaseUrl } = require("./apiClient");

// 命令定义在文件后半部分通过 Object.assign 注入，保持与 device-cli 一致的结构。
const COMMANDS = {};

function toListRow(d) {
  return {
    id: d.id || "",
    type: d.type || "",
    connected: d.connected === false ? "false" : "true",
    properties: d.properties || {}
  };
}

// ---------------- argv 解析 ----------------
function parseArgv(argv) {
  let format = "table";
  let baseUrl =
    process.env.VDEV_CLI_BASE_URL ||
    process.env.DEVICE_CLI_BASE_URL ||
    process.env.API_BASE_URL ||
    "";
  let helpRequested = false;
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      helpRequested = true;
      continue;
    }
    if (arg.startsWith("--format=")) {
      format = arg.split("=")[1] || "table";
      continue;
    }
    if (arg === "--format" || arg === "-f") {
      format = argv[i + 1] || "table";
      i += 1;
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      baseUrl = arg.split("=")[1] || "";
      continue;
    }
    if (arg === "--base-url" || arg === "-b") {
      baseUrl = argv[i + 1] || "";
      i += 1;
      continue;
    }
    positionals.push(arg);
  }

  return {
    format: format === "json" ? "json" : "table",
    baseUrl: normalizeBaseUrl(baseUrl),
    helpRequested,
    command: positionals[0] || "help",
    positionals: positionals.slice(1)
  };
}

// ---------------- 输出 ----------------
function output(context, payload) {
  if (context.format === "json") {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (payload.title) {
    process.stdout.write(`${payload.title}\n`);
  }
  if (Array.isArray(payload.rows)) {
    process.stdout.write(renderTable(payload.rows));
    process.stdout.write("\n");
    if (payload.meta && typeof payload.meta === "object") {
      process.stdout.write("\n");
      process.stdout.write(renderKeyValueTable(payload.meta));
      process.stdout.write("\n");
    }
  } else {
    process.stdout.write(renderKeyValueTable(payload));
    process.stdout.write("\n");
  }
  if (Array.isArray(payload.tips) && payload.tips.length > 0) {
    process.stdout.write("\n");
    payload.tips.forEach((tip) => process.stdout.write(`- ${tip}\n`));
  }
}

function renderKeyValueTable(data) {
  const rows = Object.entries(data)
    .filter(([key]) => key !== "rows" && key !== "meta" && key !== "tips")
    .map(([key, value]) => ({ key, value: normalizeValue(value) }));
  return renderTable(rows);
}

function renderTable(rows) {
  if (!rows || rows.length === 0) {
    return "(empty)";
  }
  const columns = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );
  const values = rows.map((row) =>
    columns.map((column) => normalizeValue(row[column]))
  );
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...values.map((line) => line[index].length))
  );
  const header = joinRow(columns, widths);
  const divider = widths.map((width) => "-".repeat(width)).join("-+-");
  const body = values.map((line) => joinRow(line, widths)).join("\n");
  return `${header}\n${divider}\n${body}`;
}

function joinRow(cells, widths) {
  return cells.map((cell, index) => cell.padEnd(widths[index], " ")).join(" | ");
}

function normalizeValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ---------------- 参数辅助 ----------------
function parseCommandArgs(args) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const pair = arg.slice(2);
      const splitIndex = pair.indexOf("=");
      if (splitIndex >= 0) {
        const key = pair.slice(0, splitIndex);
        if (key) options[key] = pair.slice(splitIndex + 1);
        continue;
      }
      const key = pair;
      const next = args[i + 1];
      if (key && next !== undefined && !next.startsWith("-")) {
        options[key] = next;
        i += 1;
      } else if (key) {
        options[key] = true;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const key = arg.slice(1);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        options[key] = next;
        i += 1;
      } else {
        options[key] = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { options, positionals };
}

function pickArg(parsed, keys, positionIndex, fallback = "") {
  for (const key of keys) {
    const value = parsed.options[key];
    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }
  const positionalValue = parsed.positionals[positionIndex];
  if (positionalValue !== undefined) return positionalValue;
  return fallback;
}

function parseValue(input) {
  if (input === "" || input === undefined) return "";
  try {
    return JSON.parse(input);
  } catch (error) {
    return input;
  }
}

// 把 --key=value 形式的剩余选项收集成属性对象（值走 JSON 解析）。
function collectProps(parsed, excludeKeys = []) {
  const props = {};
  const exclude = new Set(excludeKeys);
  for (const [key, value] of Object.entries(parsed.options)) {
    if (exclude.has(key)) continue;
    props[key] = parseValue(typeof value === "string" ? value : String(value));
  }
  return props;
}

function showCommandHelp(context, commandName) {
  const command = COMMANDS[commandName];
  if (!command) {
    output(context, {
      error: `未知命令: ${commandName}`,
      available: Object.keys(COMMANDS).filter((name) => name !== "help")
    });
    return;
  }
  output(context, {
    title: `命令帮助: ${commandName}`,
    description: command.description,
    usage: command.usage,
    examples: (command.examples || []).join("\n"),
    baseUrl: context.baseUrl
  });
}

// ---------------- 命令定义 ----------------
Object.assign(COMMANDS, {
  help: {
    description: "显示帮助信息",
    usage: "help [命令]",
    examples: ["node cli.js help", "node cli.js help create"],
    run: async (context) => {
      const target = context.positionals[0] || "";
      if (target && COMMANDS[target]) {
        showCommandHelp(context, target);
        return;
      }
      const rows = Object.entries(COMMANDS)
        .filter(([name]) => name !== "help")
        .map(([name, config]) => ({
          command: name,
          description: config.description,
          usage: config.usage
        }));
      output(context, {
        title: "vdev-cli 虚拟设备命令列表",
        rows,
        meta: { format: context.format, baseUrl: context.baseUrl },
        tips: [
          "支持 --format=table|json（默认 table）、-f json",
          "支持 --base-url=http://127.0.0.1:3000 或环境变量 VDEV_CLI_BASE_URL",
          "支持 --help / -h 查看单条命令帮助",
          "set/create 的属性用 --key=value 传入，值会按 JSON 解析",
          "示例: node cli.js create --id=vdev01 --type=QTZ --distance=100"
        ]
      });
    }
  },
  create: {
    description: "创建虚拟设备并注入上线",
    usage: "create --id=<id> --type=<type> [--key=value ...]",
    examples: [
      "node cli.js create --id=vdev01 --type=QTZ --distance=100",
      "node cli.js create --id=motor1 --type=DIANJI"
    ],
    run: async (context) => {
      const parsed = parseCommandArgs(context.positionals);
      const id = pickArg(parsed, ["id", "i"], 0);
      const type = pickArg(parsed, ["type", "t"], 1);
      if (!id || !type) {
        throw new Error("请传入 --id 和 --type");
      }
      const properties = collectProps(parsed, ["id", "i", "type", "t"]);
      const client = createApiClient({ baseUrl: context.baseUrl });
      const result = await client.create({ id, type, properties });
      output(context, {
        title: "虚拟设备创建结果",
        ok: true,
        command: "create",
        baseUrl: client.baseUrl,
        id: result.id,
        type: result.type,
        properties: result.properties
      });
    }
  },
  batch: {
    description: "批量创建虚拟设备（从 JSON 数组）",
    usage: "batch --devices='[{\"id\":\"a\",\"type\":\"QTZ\"}]'",
    examples: [
      "node cli.js batch --devices='[{\"id\":\"a\",\"type\":\"QTZ\"},{\"id\":\"b\",\"type\":\"DIANJI\"}]'"
    ],
    run: async (context) => {
      const parsed = parseCommandArgs(context.positionals);
      const raw = pickArg(parsed, ["devices", "d"], 0);
      if (!raw) throw new Error("请传入 --devices='[...]'（JSON 数组）");
      const devices = parseValue(raw);
      if (!Array.isArray(devices)) throw new Error("--devices 必须是 JSON 数组");
      const client = createApiClient({ baseUrl: context.baseUrl });
      const result = await client.batchCreate(devices);
      output(context, {
        title: "批量创建结果",
        rows: (result.results || []).map((r) => ({
          id: r.id,
          ok: r.ok ? "true" : "false",
          type: r.type || "",
          error: r.error || ""
        })),
        meta: { command: "batch", baseUrl: client.baseUrl, total: (result.results || []).length }
      });
    }
  },
  list: {
    description: "列出所有虚拟设备",
    usage: "list",
    examples: ["node cli.js list", "node cli.js list -f json"],
    run: async (context) => {
      const client = createApiClient({ baseUrl: context.baseUrl });
      const list = await client.list();
      const rows = Array.isArray(list) ? list : [];
      output(context, {
        title: "虚拟设备列表",
        rows: rows.map(toListRow),
        meta: { command: "list", total: rows.length, baseUrl: client.baseUrl }
      });
    }
  },
  delete: {
    description: "删除虚拟设备",
    usage: "delete --id=<id>",
    examples: ["node cli.js delete --id=vdev01", "node cli.js delete vdev01"],
    run: async (context) => {
      const parsed = parseCommandArgs(context.positionals);
      const id = pickArg(parsed, ["id", "i"], 0);
      if (!id) throw new Error("请传入 --id");
      const client = createApiClient({ baseUrl: context.baseUrl });
      await client.remove(id);
      output(context, {
        title: "虚拟设备删除结果",
        ok: true,
        command: "delete",
        baseUrl: client.baseUrl,
        id
      });
    }
  }
});

Object.assign(COMMANDS, {
  props: {
    description: "查看虚拟设备当前属性",
    usage: "props --id=<id>",
    examples: ["node cli.js props --id=vdev01", "node cli.js props vdev01 -f json"],
    run: async (context) => {
      const parsed = parseCommandArgs(context.positionals);
      const id = pickArg(parsed, ["id", "i"], 0);
      if (!id) throw new Error("请传入 --id");
      const client = createApiClient({ baseUrl: context.baseUrl });
      const props = await client.getProperties(id);
      output(context, {
        title: `虚拟设备属性: ${id}`,
        ...props
      });
    }
  },
  set: {
    description: "修改虚拟设备属性（注入 update 消息）",
    usage: "set --id=<id> --key=value [--key2=value2 ...]",
    examples: [
      "node cli.js set --id=vdev01 --distance=40",
      "node cli.js set --id=vdev01 --report_delay_ms=2000"
    ],
    run: async (context) => {
      const parsed = parseCommandArgs(context.positionals);
      const id = pickArg(parsed, ["id", "i"], 0);
      if (!id) throw new Error("请传入 --id");
      const props = collectProps(parsed, ["id", "i"]);
      if (Object.keys(props).length === 0) {
        throw new Error("请至少传入一个 --key=value 属性");
      }
      const client = createApiClient({ baseUrl: context.baseUrl });
      const updated = await client.setProperties(id, props);
      output(context, {
        title: "属性更新结果",
        ok: true,
        command: "set",
        baseUrl: client.baseUrl,
        id,
        applied: props,
        properties: updated
      });
    }
  },
  emit: {
    description: "向虚拟设备注入一条任意消息",
    usage: "emit --id=<id> --msg='{\"method\":\"low\"}'",
    examples: [
      "node cli.js emit --id=vdev01 --msg='{\"method\":\"low\"}'",
      "node cli.js emit vdev01 '{\"method\":\"high\"}'"
    ],
    run: async (context) => {
      const parsed = parseCommandArgs(context.positionals);
      const id = pickArg(parsed, ["id", "i"], 0);
      const raw = pickArg(parsed, ["msg", "m"], 1);
      if (!id) throw new Error("请传入 --id");
      if (!raw) throw new Error("请传入 --msg='{...}'");
      const msg = parseValue(raw);
      if (typeof msg !== "object") throw new Error("--msg 必须是 JSON 对象");
      const client = createApiClient({ baseUrl: context.baseUrl });
      await client.emit(id, msg);
      output(context, {
        title: "消息注入结果",
        ok: true,
        command: "emit",
        baseUrl: client.baseUrl,
        id,
        msg
      });
    }
  },
  commands: {
    description: "查看虚拟设备收到的下行命令记录",
    usage: "commands --id=<id> [--clear]",
    examples: [
      "node cli.js commands --id=vdev01",
      "node cli.js commands --id=vdev01 --clear"
    ],
    run: async (context) => {
      const parsed = parseCommandArgs(context.positionals);
      const id = pickArg(parsed, ["id", "i"], 0);
      if (!id) throw new Error("请传入 --id");
      const client = createApiClient({ baseUrl: context.baseUrl });
      if (parsed.options.clear) {
        await client.clearCommands(id);
        output(context, { title: "命令记录已清空", ok: true, command: "commands", id });
        return;
      }
      const cmds = await client.getCommands(id);
      const rows = Array.isArray(cmds) ? cmds : [];
      output(context, {
        title: `命令记录: ${id}`,
        rows: rows.map((c) => ({
          ts: c.ts ? new Date(c.ts).toISOString() : "",
          action: c.action || "",
          detail: JSON.stringify({ ...c, ts: undefined, action: undefined })
        })),
        meta: { command: "commands", id, total: rows.length, baseUrl: client.baseUrl }
      });
    }
  },
  timeline: {
    description: "启动/停止/查看时间轴（脚本化动态过程）",
    usage: "timeline --id=<id> [--start='[...]' --loop | --stop | --status]",
    examples: [
      "node cli.js timeline --id=vdev01 --start='[{\"delay\":1000,\"set\":{\"distance\":40}}]' --loop",
      "node cli.js timeline --id=vdev01 --status",
      "node cli.js timeline --id=vdev01 --stop"
    ],
    run: async (context) => {
      const parsed = parseCommandArgs(context.positionals);
      const id = pickArg(parsed, ["id", "i"], 0);
      if (!id) throw new Error("请传入 --id");
      const client = createApiClient({ baseUrl: context.baseUrl });
      if (parsed.options.stop) {
        await client.stopTimeline(id);
        output(context, { title: "时间轴已停止", ok: true, command: "timeline", id });
        return;
      }
      if (parsed.options.status) {
        const status = await client.getTimeline(id);
        output(context, { title: `时间轴状态: ${id}`, ...status });
        return;
      }
      const raw = pickArg(parsed, ["start", "s"], 1);
      if (!raw) throw new Error("请传入 --start='[...]'，或使用 --stop / --status");
      const timeline = parseValue(raw);
      if (!Array.isArray(timeline)) throw new Error("--start 必须是 JSON 数组");
      await client.startTimeline(id, timeline, !!parsed.options.loop);
      output(context, {
        title: "时间轴已启动",
        ok: true,
        command: "timeline",
        baseUrl: client.baseUrl,
        id,
        steps: timeline.length,
        loop: !!parsed.options.loop
      });
    }
  }
});

// ---------------- 入口 ----------------
async function main() {
  const context = parseArgv(process.argv.slice(2));
  if (context.helpRequested) {
    if (context.command !== "help" && COMMANDS[context.command]) {
      showCommandHelp(context, context.command);
      return;
    }
    await COMMANDS.help.run(context);
    return;
  }
  const command = COMMANDS[context.command];
  if (!command) {
    output(context, {
      error: `未知命令: ${context.command}`,
      available: Object.keys(COMMANDS).filter((name) => name !== "help")
    });
    process.exitCode = 1;
    return;
  }
  try {
    await command.run(context);
  } catch (error) {
    output(context, {
      command: context.command,
      error: error.message || String(error),
      status: error.status
    });
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exitCode = 1;
});
