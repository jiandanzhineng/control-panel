# vdev-cli — 虚拟设备命令行工具

命令行接入后端的虚拟设备接口（`/api/virtual-devices`），方便在终端里创建 / 查看 / 修改 / 删除虚拟设备，注入消息、查看下行命令、驱动时间轴。后端接口保持不变，本工具只是调用方。

## 前置条件

- Node.js >= 18（使用内置 `fetch`，无第三方依赖）。
- 后端已启动（默认 `http://127.0.0.1:3000`）。

## 配置后端地址

按优先级：

1. 命令行 `--base-url=http://127.0.0.1:3000`（或 `-b`）
2. 环境变量 `VDEV_CLI_BASE_URL` / `DEVICE_CLI_BASE_URL` / `API_BASE_URL`
3. 默认 `http://127.0.0.1:3000`

地址会自动补 `/api` 后缀，写不写都行。

## 通用选项

| 选项 | 说明 |
|------|------|
| `--format=table\|json` / `-f json` | 输出格式，默认 `table` |
| `--base-url=<url>` / `-b <url>` | 后端地址 |
| `--help` / `-h` | 查看帮助；`<cmd> -h` 看单条命令帮助 |

属性值（`--key=value` 与 `--msg` / `--devices` / `--start`）一律按 **JSON** 解析：`--distance=40` 得到数字，`--name='"abc"'` 得到字符串，解析失败时按原始字符串处理。

## 命令一览

```bash
node cli.js help            # 列出全部命令
node cli.js help <command>  # 单条命令帮助
```

### 创建 / 列表 / 删除

```bash
# 创建：--id、--type 必填，其余 --key=value 作为初始属性
node cli.js create --id=vdev01 --type=QTZ --distance=100

# 批量创建
node cli.js batch --devices='[{"id":"a","type":"QTZ"},{"id":"b","type":"DIANJI"}]'

# 列出所有虚拟设备
node cli.js list

# 删除
node cli.js delete --id=vdev01
```

### 查看 / 修改属性

```bash
# 查看当前属性
node cli.js props --id=vdev01

# 修改属性（注入 update 消息）；可一次传多个
node cli.js set --id=vdev01 --distance=40
node cli.js set --id=vdev01 --report_delay_ms=2000

# QTZ 设备改 distance 跨越 low_band/high_band 时，后端会自动 emit low/high
```

### 注入消息

```bash
# 向设备注入任意一条消息
node cli.js emit --id=vdev01 --msg='{"method":"low"}'
```

### 下行命令记录

```bash
# 查看设备收到的下行命令（如对 DIANJI 发 dian 会被记录）
node cli.js commands --id=vdev01

# 清空记录
node cli.js commands --id=vdev01 --clear
```

### 时间轴（脚本化动态过程）

```bash
# 启动：按 delay 依次执行 set/emit，--loop 循环
node cli.js timeline --id=vdev01 --start='[{"delay":1000,"set":{"distance":40}},{"delay":[500,1500],"emit":{"method":"low"}}]' --loop

# 查看运行状态
node cli.js timeline --id=vdev01 --status

# 停止
node cli.js timeline --id=vdev01 --stop
```

时间轴步骤格式：`{ "delay": 毫秒 | [最小,最大], "set": {属性}, "emit": {消息} }`。

## 输出格式

默认表格输出，便于人读；加 `-f json` 输出结构化 JSON，便于脚本消费。失败时退出码为 1，并在输出中包含 `error`（及可能的 HTTP `status`）。

## 对应的后端接口

| 命令 | 接口 |
|------|------|
| `create` | `POST /api/virtual-devices` |
| `batch` | `POST /api/virtual-devices/batch` |
| `list` | `GET /api/virtual-devices` |
| `delete` | `DELETE /api/virtual-devices/:id` |
| `props` | `GET /api/virtual-devices/:id/properties` |
| `set` | `PUT /api/virtual-devices/:id/properties` |
| `emit` | `POST /api/virtual-devices/:id/emit` |
| `commands` | `GET` / `DELETE /api/virtual-devices/:id/commands` |
| `timeline` | `POST` / `GET` / `DELETE /api/virtual-devices/:id/timeline` |
