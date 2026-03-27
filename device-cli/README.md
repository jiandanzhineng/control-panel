# device-cli 使用说明

`device-cli` 是一个独立、无状态的设备管理命令行工具。每次执行只发起一次请求并退出，不保存会话和缓存。

## 前置条件

- Node.js >= 18
- 后端服务已运行（默认地址 `http://127.0.0.1:3000/api`）

## 快速开始

```bash
cd device-cli
node cli.js help
```

可选全局参数：

- `--format=table|json` 或 `-f`：输出格式，默认 `table`
- `--base-url=<url>` 或 `-b`：后端地址，支持不带 `/api`
- `--help` 或 `-h`：查看命令帮助

## 四个命令

### 1) 设备列表

```bash
node cli.js devices:list
node cli.js devices:list --format=json
```

### 2) 读取设备属性

```bash
node cli.js devices:get --id=dev01 --key=name
node cli.js devices:get dev01 settings.report_delay_ms
```

### 3) 更新设备属性

```bash
node cli.js devices:set --id=dev01 --key=name --value='"卧室设备"'
node cli.js devices:set dev01 settings.report_delay_ms 1000
```

### 4) 发送 MQTT 指令

```bash
node cli.js mqtt:publish --deviceId=dev01 --payload='{"method":"heartbeat"}'
node cli.js mqtt:publish --deviceId=dev01 --topic=/custom/topic --payload='{"method":"stop"}'
```

说明：

- 未传 `--topic` 时，自动使用 `"/drecv/{deviceId}"` 作为 topic
- `--payload` 支持 JSON；非 JSON 时按字符串发送

## 输出说明

- `table`：适合人工查看
- `json`：适合脚本处理
- 命令失败时会返回 `error` 字段并以非 0 退出

## 无状态说明

- 不写入本地配置文件
- 不保存设备列表缓存
- 不复用命令间上下文
- 每次命令均可独立重试
