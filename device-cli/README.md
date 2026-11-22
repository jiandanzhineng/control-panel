# undersilicon-cli

硅基之下控制中心（UnderSilicon）的命令行工具，供用户和 AI agent 查看设备、控制输出、启动游戏与订阅事件。

- 零第三方依赖，Node.js >= 18（内置 `fetch`）
- 默认连接本机正式客户端的 `http://127.0.0.1:5278/api`
- 全局 `--json` 输出，方便 agent 管道处理
- 使用文档：https://docs.undersilicon.cn/docs/developer/cli

## 安装

```bash
npm i -g undersilicon-cli
undersilicon --help
```

或者不安装直接运行：

```bash
npx undersilicon-cli devices
```

## 快速开始

```bash
undersilicon status                      # 客户端、模式、当前游戏、agent 租约
undersilicon devices                     # 设备列表
undersilicon device dev01                # 设备能力、参数范围、预置操作
undersilicon control dev01 strength set value=120
undersilicon op dev01 start              # 预置操作
undersilicon games                       # 游戏列表
undersilicon game:start demo --device motor=dev01 --param speed=5
undersilicon stop --reason "测试结束"     # 急停
undersilicon events --types device,game --count 10 --json
```

### 指定 API 地址

```bash
undersilicon devices --api http://127.0.0.1:5330
UNDERSILICON_API=http://127.0.0.1:5330/api undersilicon devices
```

`--api` 别名 `--base-url`/`-b`，地址可不带 `/api`。兼容旧环境变量 `DEVICE_CLI_BASE_URL`、`API_BASE_URL`。

### JSON 输出

```bash
undersilicon devices --json
undersilicon control dev01 strength set value=120 --json
```

失败时输出 `{"ok":false,"error":{"code","message","status"}}`；退出码 0 成功、1 运行失败、2 用法错误。

## 输出限幅（agent 安全）

给 AI agent 用时建议开启限幅：CLI 会先创建 agent 租约，后端把设备输出钳制到上限。

```bash
undersilicon control dev01 strength set value=200 --limit 30
undersilicon control dev01 shock start voltage=80 --cap-limit shock=30,strength=60
```

- `--limit <0-100>`：所有能力默认上限（env `UNDERSILICON_LIMIT`）
- `--cap-limit shock=30,...`：按能力覆盖，能力名只允许 strength/shock/vibration/suction/estim/motors/pump（env `UNDERSILICON_CAP_LIMIT`）
- `--lease-ttl <5-600>`：租约秒数，默认 600（env `UNDERSILICON_LEASE_TTL`）
- clientId：env `UNDERSILICON_CLIENT_ID`，默认 `undersilicon-cli`

只给 `--cap-limit` 时默认上限为 100。租约接口不可用（404/405）会报「当前客户端不支持限幅，请升级」并以非 0 退出，不会静默降级。急停永远不建租约。

> 限幅只对带参数的命令生效。能自由执行终端命令的 agent 也能去掉参数，CLI 不是安全边界；需要强制限幅时用 dsh 插件 `dsh-plugin-undersilicon`。

## 全部命令

| 命令 | 说明 |
|---|---|
| `status` | 客户端状态、运行模式、当前游戏、agent 租约 |
| `devices`（别名 `devices:list`） | 设备列表 |
| `device <id>` | 设备详情、能力与动作参数范围、预置操作 |
| `devices:get <id> [key]` | 读取设备属性（支持点号路径） |
| `devices:set <id> <key> <value>` | 更新设备属性 |
| `control <id> <capability> <action> [key=value ...]` | 调用能力动作，可用 `--input '<json>'` |
| `op <id> <operation> [key=value ...]` | 执行预置操作，可用 `--params '<json>'` |
| `stop [--reason 文本]` | 急停：停止所有设备输出并停止当前游戏 |
| `games` | 游戏列表（载体、设备角色） |
| `game:start <id> [--param k=v ...] [--device 角色=设备ID ...] [--params '<json>'] [--no-show]` | 启动游戏 |
| `game:stop` / `game:status` | 停止当前游戏 / 查看游戏状态 |
| `window <show\|hide\|focus\|minimize\|maximize\|restore>` | 控制客户端窗口 |
| `routes` | 可导航页面列表 |
| `open <path> [--no-show]` | 在客户端打开页面 |
| `screenshot [文件] [--max-width N] [--jpeg]` | 截图（base64 自动落盘） |
| `events [--types ...] [--count N] [--timeout 秒]` | 订阅事件流 |
| `events:recent [--limit N] [--types ...]` | 最近事件 |
| `lease:release` | 释放 agent 租约（会停掉其启动的游戏） |
| `mqtt:publish <deviceId> [topic] <payload>` | 发送原始 MQTT 报文（高级用法） |

`undersilicon help <命令>` 查看单个命令用法。

## 开发

```bash
npm test        # node --test
npm pack --dry-run
```
