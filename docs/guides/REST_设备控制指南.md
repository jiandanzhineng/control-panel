# 通过 REST 控制设备指南

本文档说明如何通过后端 REST 接口对本机已接入的设备进行控制。适用范围：面板管理侧、自动化测试、脚本化驱动。实时玩法（游戏/插件 detector）的设备驱动走 WebSocket bridge，不在本文档范围内，详见 [Backend_API.md](../api/Backend_API.md)。

> 约定：REST 仅本机自用，不对外暴露，故无鉴权。两种运行方式下 REST 路径完全一致，仅端口不同：
>
> - 独立后端（`node backend/index.js`）：默认端口 `3000`，可用 `PORT` 环境变量覆盖。
> - Electron 客户端内置后端：端口 `5278`（写死于 [electron/main.js:432](../../electron/main.js)）。
>
> 下文示例以独立后端 `http://127.0.0.1:3000` 为例；Electron 运行时把端口换成 `5278` 即可。
>
> **为什么 Electron 下 REST 与 WS bridge 都可用**：Electron 不重新 `app.listen()`，而是 `require('backend/index.js')` 后拿其导出的 `server`（`http.createServer(app)`，已由 `bridgeService.init(server)` 挂好 `/bridge` WS）来 listen（见 [backend/index.js:108-113](../../backend/index.js)、[electron/main.js:435-436](../../electron/main.js)）。REST 路由与 WS bridge 共用同一个 server，故两者都能正常工作。若误对 `app` 重新 `listen`，新建 server 不带 WS，会导致 `/bridge` 握手 404（REST 不受影响，但插件/游戏设备连不上）。
>
> 前端面板在 Electron 下的 `/api/*` 请求由前端 5277 端口的代理转发到 5278（[electron/main.js:372-388](../../electron/main.js)）。

## 一、整体链路

```
REST 请求  →  routes/devices.js  →  deviceService  →  deviceType.invokeOperation
                                                       →  capability.action  →  ctx.writeProps
                                                                                   →  MQTT publish(/drecv/<id>)
```

所有设备控制最终通过 MQTT 下发到物理设备，topic 为 `/drecv/<设备id>`。REST 只是把"操作"封装成 HTTP 调用，底层与 WS bridge 共用同一套 capability/registry。

## 二、核心接口

### 执行设备操作

```
POST /api/devices/:id/operations/:operationKey
Content-Type: application/json
Body: { "params": { ... } }   // params 可选
```

- `:id` 设备 ID（设备上线时分配）。
- `:operationKey` 操作键，必须在该设备类型的 `operations` 注册表中声明，否则返回 `DEVICE_OPERATION_NOT_SUPPORTED`。
- `params` 会与操作预设的 `input` **浅合并**（`{...operation.input, ...params}`），即同名键以请求传入的 params 为准，可用于覆盖默认强度/电压等。
- 成功返回 `{ "success": true, "message": "操作执行成功" }`。
- 设备不存在返回 `DEVICE_NOT_FOUND`（404）；操作失败返回 `DEVICE_OPERATION_FAILED`（500）。

实现：[routes/devices.js:298](../../backend/routes/devices.js)、[deviceService.js:392](../../backend/services/deviceService.js)、[baseDeviceType.js:131](../../backend/devices/baseDeviceType.js)。

### 原始 MQTT 下发（绕过能力层）

```
POST /api/mqtt-client/publish
Body: { "topic": "/drecv/<id>", "message": { ... } }
```

- 用于设备类型未注册 operation、或需要下发非标准 payload 的场景。
- 缺 `topic` 或 `message` 返回 400。
- 成功返回 `{ "ok": true }`。

> 不推荐常规使用，绕过了 capability 层的入参钳制（如 strength 的 0–255 截断、distance 的边界收敛）。

## 三、设备类型与可用操作

操作是否可用取决于设备类型在 [registry.js](../../backend/devices/registry.js) 中声明的 `operations`。查询方式：

- `GET /api/device-types` — 类型到显示名映射。
- `GET /api/device-types/configs` — 全部类型配置（含每个类型暴露的 operations 及其预设 input）。
- `GET /api/device-capabilities` — 能力与类型映射总览。

### 各类型支持的操作

| 设备类型 | 显示名 | 能力 | REST 操作 (operationKey) | 预设 input |
|---|---|---|---|---|
| `DIANJI` | 电脉冲设备 | shock | `start` / `stop` | start: `{voltage:24}` |
| `PJ01` | 往复电机控制器 | strength | `start` / `stop` | start: `{value:255}` |
| `TD01` | 偏轴电机控制器 | strength | `start` / `stop` | start: `{value:255}` |
| `OSR6` | OSR6控制器 | strength | `start` / `stop` | start: `{value:255}` |
| `ZIDONGSUO` | 自动锁 | lock | `lock` / `unlock` | lock:`{open:false}` / unlock:`{open:true}` |
| `CUNZHI01` | 寸止玩法设备 | sphincterPressure/tiptoePressure/strength/shock/reporting | `start` / `stop` | 自定义 invoke，直接写 `{shock,voltage,power}` |
| `QIYA` | 气压传感器 | sphincterPressure/reporting | 无 | 仅上报，无可控操作 |
| `QTZ` | 测距及脚踏传感器 | distance/buttonInput/reporting | 无 | 仅上报/事件 |
| `DZC01` | 电子秤 | weight/reporting | 无 | 仅上报 |

> 注意：`CUNZHI01` 的 start/stop 用的是 `operation.invoke`（直接写 props），不走 capability action，因此 params 不会被合并进预设——传参无效。

### 能力动作与底层 payload

供"原始 MQTT 下发"或理解 operation 行为时参考（见 [capabilities.js](../../backend/devices/capabilities.js)）：

| 能力.动作 | 下发 payload | 入参钳制 |
|---|---|---|
| `shock.start` | `{voltage, shock:1}` | voltage 默认 24 |
| `shock.stop` | `{shock:0}` | — |
| `strength.set` | `{power}` | 0–255 截断 |
| `strength.stop` | `{power:0}` | — |
| `lock.setOpen` | `{open:0/1}` | — |
| `distance.configure` | `{low_band,high_band,report_delay_ms}` | 各自 0–上界截断 |
| `reporting.setReportDelay` | `{report_delay_ms}` | 0–99999 截断 |

## 四、示例

以下用 `curl` 示例（PowerShell 可把外层单引号改为双引号转义）。假设设备 id 为 `abc123`。

### 1. 查设备类型与可用操作

```bash
curl http://127.0.0.1:3000/api/devices/abc123
curl http://127.0.0.1:3000/api/device-types/configs
```

### 2. 启动电脉冲设备（DIANJI）

```bash
curl -X POST http://127.0.0.1:3000/api/devices/abc123/operations/start \
  -H "Content-Type: application/json" \
  -d '{"params":{}}'
# 下发 {voltage:24, shock:1}（用预设 input）
```

覆盖默认电压（params 浅合并覆盖 input）：

```bash
curl -X POST http://127.0.0.1:3000/api/devices/abc123/operations/start \
  -H "Content-Type: application/json" \
  -d '{"params":{"voltage":40}}'
# 下发 {voltage:40, shock:1}
```

停止：

```bash
curl -X POST http://127.0.0.1:3000/api/devices/abc123/operations/stop \
  -H "Content-Type: application/json" -d '{}'
```

### 3. 电机强度控制（PJ01/TD01/OSR6）

```bash
# 启动（预设 value=255）
curl -X POST http://127.0.0.1:3000/api/devices/abc123/operations/start -H "Content-Type: application/json" -d '{}'

# 用指定强度启动（覆盖预设）
curl -X POST http://127.0.0.1:3000/api/devices/abc123/operations/start \
  -H "Content-Type: application/json" -d '{"params":{"value":120}}'

# 停止
curl -X POST http://127.0.0.1:3000/api/devices/abc123/operations/stop -H "Content-Type: application/json" -d '{}'
```

### 4. 自动锁（ZIDONGSUO）

```bash
curl -X POST http://127.0.0.1:3000/api/devices/abc123/operations/lock  -H "Content-Type: application/json" -d '{}'
curl -X POST http://127.0.0.1:3000/api/devices/abc123/operations/unlock -H "Content-Type: application/json" -d '{}'
```

### 5. 原始 MQTT 下发（无 operation 的设备/非标准 payload）

```bash
curl -X POST http://127.0.0.1:3000/api/mqtt-client/publish \
  -H "Content-Type: application/json" \
  -d '{"topic":"/drecv/abc123","message":{"method":"action","action":"blink"}}'
```

## 五、监控与状态

- `GET /api/devices/:id/monitor-data` — 当前监控字段快照（只含该类型配置声明的字段）。
- `GET /api/devices/:id/monitor-stream` — SSE，事件 `history`（初始快照）、`update`（变化）。连接时下发 `report_delay_ms=250`，断开恢复 `5000`。
- `GET /api/devices` — 设备列表（含在线状态、lastReport）。

## 六、自动化测试平台

按设备能力的 `test` 段（start/loop/stop）轮询下发，适合批量联调：

- `POST /api/test/start` — 对当前在线设备启动测试，每秒扫描新上线设备。
- `POST /api/test/stop` — 停止并下发 stop 配置。
- `POST /api/test/device/:id/start` — 单台重启测试。
- `GET /api/test/stream` — SSE，`{type:"connected"}` 与 `{type:"update",deviceId,data}`。

实现：[routes/test.js](../../backend/routes/test.js)、[testService.js](../../backend/services/testService.js)。

## 七、注意事项

1. **本机自用**：REST 无鉴权、CORS 全放行，仅限本机调用，不要对外网暴露端口。
2. **params 覆盖语义**：`{...operation.input, ...params}` 浅合并，可覆盖 voltage/value 等默认值；`CUNZHI01` 例外（自定义 invoke，不合并）。
3. **入参钳制**：REST 走 operation → capability action 时，钳制在 capability 内部生效（如 strength 0–255）。原始 MQTT publish 不经钳制，自行负责。
4. **与 WS bridge 的差异**：WS bridge 的 `invoke`/`writeProps` 可调用任意 capability action，并有服务端 `sanitizeCapabilityInput` 和电击自动停止定时器（1–10s）；REST operations 仅暴露每类型预设的几个 operation，无自动停止——长时电击需调用方自行 `stop`。
5. **设备在线**：操作前建议 `GET /api/devices/:id` 确认 `connected`，离线设备下发会成功 publish 但无实际效果。
6. **错误码**：统一 `{ "error": { "code", "message" } }`，常见 `DEVICE_NOT_FOUND`、`DEVICE_OPERATION_NOT_SUPPORTED`、`DEVICE_OPERATION_FAILED`、`CAPABILITY_ACTION_NOT_FOUND`。

