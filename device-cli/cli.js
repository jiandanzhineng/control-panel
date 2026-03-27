#!/usr/bin/env node

const { createApiClient, normalizeBaseUrl } = require("./apiClient");

const COMMANDS = {
  help: {
    description: "显示帮助信息",
    usage: "help [命令]",
    examples: ["node cli.js help", "node cli.js help mqtt:publish"],
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
        title: "device-cli 命令列表",
        rows,
        meta: {
          format: context.format,
          baseUrl: context.baseUrl
        },
        tips: [
          "支持 --format=table|json，默认 table",
          "支持 -f table|json",
          "支持 --base-url=http://127.0.0.1:3000",
          "支持 --help 或 -h 查看命令帮助",
          "示例: node cli.js mqtt:publish --deviceId=dev01 --payload='{\"method\":\"heartbeat\"}'"
        ]
      });
    }
  },
  "devices:list": {
    description: "设备列表",
    usage: "devices:list",
    examples: ["node cli.js devices:list", "node cli.js devices:list --format=json"],
    run: async (context) => {
      const client = createApiClient({ baseUrl: context.baseUrl });
      const list = await client.listDevices();
      const rows = Array.isArray(list) ? list : [];
      output(context, {
        title: "设备列表",
        rows: rows.map(toDeviceRow),
        meta: {
          ok: true,
          command: "devices:list",
          total: rows.length,
          baseUrl: client.baseUrl
        }
      });
    }
  },
  "devices:get": {
    description: "读取设备属性",
    usage: "devices:get --id=<deviceId> --key=<属性路径>",
    examples: [
      "node cli.js devices:get --id=dev01 --key=name",
      "node cli.js devices:get dev01 settings.report_delay_ms"
    ],
    run: async (context) => {
      const parsed = parseCommandArgs(context.positionals);
      const id = pickArg(parsed, ["id", "i", "deviceId", "d"], 0);
      const key = pickArg(parsed, ["key", "k"], 1);
      if (!id || !key) {
        throw new Error("请传入 --id 和 --key，或使用位置参数 <deviceId> <key>");
      }
      const client = createApiClient({ baseUrl: context.baseUrl });
      const device = await client.getDevice(id);
      output(context, {
        title: "设备属性读取结果",
        ok: true,
        command: "devices:get",
        baseUrl: client.baseUrl,
        id,
        key,
        value: getProperty(device, key)
      });
    }
  },
  "devices:set": {
    description: "更新设备属性",
    usage: "devices:set --id=<deviceId> --key=<属性路径> --value=<值>",
    examples: [
      "node cli.js devices:set --id=dev01 --key=name --value='\"卧室设备\"'",
      "node cli.js devices:set dev01 settings.report_delay_ms 1000"
    ],
    run: async (context) => {
      const parsed = parseCommandArgs(context.positionals);
      const id = pickArg(parsed, ["id", "i", "deviceId", "d"], 0);
      const key = pickArg(parsed, ["key", "k"], 1);
      const valueInput = pickArg(parsed, ["value", "v"], 2, "");
      if (!id || !key) {
        throw new Error("请传入 --id 和 --key，或使用位置参数 <deviceId> <key> <value>");
      }
      const client = createApiClient({ baseUrl: context.baseUrl });
      const patch = { [key]: parseValue(valueInput) };
      const device = await client.updateDevice(id, patch);
      output(context, {
        title: "设备属性更新结果",
        ok: true,
        command: "devices:set",
        baseUrl: client.baseUrl,
        id,
        key,
        value: patch[key],
        updated: getProperty(device, key),
        accepted: true
      });
    }
  },
  "mqtt:publish": {
    description: "发送MQTT指令",
    usage: "mqtt:publish --deviceId=<deviceId> [--topic=<topic>] [--payload=<消息>]",
    examples: [
      "node cli.js mqtt:publish --deviceId=dev01 --payload='{\"method\":\"heartbeat\"}'",
      "node cli.js mqtt:publish dev01 /custom/topic '{\"method\":\"stop\"}'"
    ],
    run: async (context) => {
      const parsed = parseCommandArgs(context.positionals);
      const deviceId = pickArg(parsed, ["deviceId", "d", "id", "i"], 0);
      const topicInput = pickArg(parsed, ["topic", "t"], 1);
      const payloadInput = pickArg(parsed, ["payload", "p"], 2, "");
      if (!deviceId) {
        throw new Error("请传入 --deviceId，或使用位置参数 <deviceId>");
      }
      const topic = topicInput || `/drecv/${deviceId}`;
      const client = createApiClient({ baseUrl: context.baseUrl });
      const message = parseValue(payloadInput);
      const result = await client.publishMqtt(topic, message);
      output(context, {
        title: "MQTT 发布结果",
        ok: Boolean(result && result.ok),
        command: "mqtt:publish",
        baseUrl: client.baseUrl,
        deviceId,
        topic,
        topicAutoByDeviceId: !topicInput,
        payload: message,
        accepted: Boolean(result && result.ok),
        response: result
      });
    }
  }
};

function parseArgv(argv) {
  let format = "table";
  let baseUrl = process.env.DEVICE_CLI_BASE_URL || process.env.API_BASE_URL || "";
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
    payload.tips.forEach((tip) => {
      process.stdout.write(`- ${tip}\n`);
    });
  }
}

function renderKeyValueTable(data) {
  const rows = Object.entries(data).map(([key, value]) => ({
    key,
    value: normalizeValue(value)
  }));
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
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function getProperty(data, keyPath) {
  return keyPath.split(".").reduce((current, key) => {
    if (current === null || current === undefined) {
      return undefined;
    }
    return current[key];
  }, data);
}

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
        const value = pair.slice(splitIndex + 1);
        if (key) {
          options[key] = value;
        }
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
  if (positionalValue !== undefined) {
    return positionalValue;
  }
  return fallback;
}

function toDeviceRow(device) {
  if (!device || typeof device !== "object") {
    return {};
  }
  const onlineValue =
    device.connected === true || device.online === true
      ? "true"
      : device.connected === false || device.online === false
        ? "false"
        : "";
  return {
    id: device.id || device.deviceId || "",
    name: device.name || "",
    type: device.type || "",
    online: onlineValue,
    ip: device.ip || "",
    mac: device.mac || ""
  };
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
    examples: command.examples || [],
    baseUrl: context.baseUrl,
    format: context.format
  });
}

function parseValue(input) {
  if (input === "") {
    return "";
  }
  try {
    return JSON.parse(input);
  } catch (error) {
    return input;
  }
}

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
      error: error.message || String(error)
    });
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exitCode = 1;
});
