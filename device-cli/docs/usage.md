# device-cli 使用文档

设备管理命令行工具，通过 HTTP API 对设备进行查询、配置和 MQTT 消息发送。

## 环境要求

- Node.js >= 18

## 快速开始

```bash
cd device-cli
node cli.js help
```

## 全局选项

| 选项 | 缩写 | 说明 | 默认值 |
|------|------|------|--------|
| `--format=<table\|json>` | `-f` | 输出格式 | `table` |
| `--base-url=<url>` | `-b` | API 地址 | `http://127.0.0.1:3000/api` |
| `--help` | `-h` | 显示帮助 | - |

API 地址也可通过环境变量设置：`DEVICE_CLI_BASE_URL` 或 `API_BASE_URL`。

> **提示**：项目打包为 Electron 应用启动后，后端端口固定为 `5278`（前端为 `5277`）。如果要在打包环境下使用本工具，需指定 `--base-url=http://127.0.0.1:5278/api`。如果是npm run dev:all环境 ，则无需指定。

## 命令

### devices:list

列出所有设备。

```bash
node cli.js devices:list
node cli.js devices:list --format=json
```

### devices:get

读取设备属性，支持点号路径（如 `settings.report_delay_ms`）。

```bash
# 命名参数
node cli.js devices:get --id=dev01 --key=name

# 位置参数
node cli.js devices:get dev01 settings.report_delay_ms
```

| 参数 | 缩写 | 位置 | 说明 |
|------|------|------|------|
| `--id` | `-i`, `--deviceId`, `-d` | 第1个 | 设备 ID |
| `--key` | `-k` | 第2个 | 属性路径 |

### devices:set

更新设备属性。

```bash
# 命名参数
node cli.js devices:set --id=dev01 --key=name --value='"卧室设备"'

# 位置参数
node cli.js devices:set dev01 settings.report_delay_ms 1000
```

| 参数 | 缩写 | 位置 | 说明 |
|------|------|------|------|
| `--id` | `-i`, `--deviceId`, `-d` | 第1个 | 设备 ID |
| `--key` | `-k` | 第2个 | 属性路径 |
| `--value` | `-v` | 第3个 | 新值（JSON 或字符串） |

### mqtt:publish

向设备发送 MQTT 消息。不指定 topic 时自动使用 `/drecv/<deviceId>`。

```bash
# 自动 topic
node cli.js mqtt:publish --deviceId=dev01 --payload='{"method":"heartbeat"}'

# 自定义 topic + 位置参数
node cli.js mqtt:publish dev01 /custom/topic '{"method":"stop"}'
```

| 参数 | 缩写 | 位置 | 说明 |
|------|------|------|------|
| `--deviceId` | `-d`, `--id`, `-i` | 第1个 | 设备 ID（必填） |
| `--topic` | `-t` | 第2个 | MQTT topic（可选） |
| `--payload` | `-p` | 第3个 | 消息内容（JSON 或字符串） |

## 输出格式

默认 `table` 格式以表格形式输出，适合终端阅读：

```
设备列表
id   | name   | type | online | ip            | mac
-----+--------+------+--------+---------------+------------------
dev01 | 卧室设备 | osr6 | true   | 192.168.1.100 | AA:BB:CC:DD:EE:FF
```

`--format=json` 输出结构化 JSON，适合脚本处理：

```bash
node cli.js devices:list --format=json | jq '.rows[].id'
```

## 测试

```bash
npm test              # 运行全部测试（smoke + mock）
npm run test:mock     # 仅运行 mock 服务测试
```
