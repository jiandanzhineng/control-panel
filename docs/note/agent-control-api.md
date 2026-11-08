# Agent 控制接口（事件流 / 客户端控制）

供外部 agent 插件（`dsh-plugin-undersilicon`）调用的通用接口。后端仍是本机 127.0.0.1、沿用「本机可信」不鉴权；不含 AI 业务逻辑。方案见 `plans/dsh-agent-plugin.md`，决定见 `adr/2026-11-08-dsh-agent-plugin.md`。

## 位置

| 功能 | 文件 |
|---|---|
| 事件总线（seq / 500 条环形缓冲 / 前缀过滤 / 节流） | `backend/services/eventBus.js` |
| SSE 与最近事件路由 | `backend/routes/events.js`（`backend/index.js` 挂 `/api/events`） |
| 客户端控制 host 注册与状态缓存 | `backend/services/clientControlService.js` |
| 客户端控制路由 | `backend/routes/client.js`（挂 `/api/client`） |
| Electron 主进程 host / IPC | `electron/main.js`（`registerClientControlHost`、`client:route-changed`） |
| 路由上报 | `electron/preload.js` 的 `window.clientApi.reportRoute` + `frontend/src/router/index.ts` 的 `router.afterEach` |
| 可导航页面清单 | `backend/constants/clientRoutes.js` |
| 启动/停止玩法（路由与 agent 共用） | `backend/services/gameLaunchService.js` |
| agent 租约 / 输出限幅 | `backend/services/agentControlService.js`、`backend/services/agentOutputGuard.js` |
| agent 请求标记（`X-Agent-Client`） | `backend/middleware/agentRequestFilter.js` |
| agent 租约路由 | `backend/routes/agentControl.js`（挂 `/api/agent-control`，只允许回环） |
| 能力参数范围 | `backend/devices/capabilities.js` 的 `actionParams`（经 `/api/device-capabilities` 的 `capabilityConfig` 暴露） |

## 事件

`GET /api/events/stream?types=device,game,session,client`（SSE，逗号前缀过滤，省略=全部）：

1. 先发 `data: {"type":"hello","seq":N,"mode":"local|remote-operator|remote-controlled"}`（普通 data 帧，`onmessage` 可收到）。
2. 之后每条：`id: <seq>` + `data: {seq,type,ts,...}`。
3. 新连接只收连上后的事件；带 `Last-Event-ID` 才从环形缓冲补发（最多 500 条）。
4. 每 15s 发 `: ping` 注释心跳。

事件类型：

- `device.added` / `device.removed` / `device.connected` / `device.disconnected` `{deviceId, device}`
- `device.updated` `{deviceId, changes, data}`：data 变化，同设备 200ms 合并
- `game.started` / `game.stopped` `{gameId, carrier: host|bridge, source, reason}`
- `game.state` `{gameId, running, ended, paused, sessionId, runtimeMode, snapshot}`：HostRuntime 状态，500ms 合并
- `session.mode` `{mode, sessionId, role}`、`session.revoked` `{reason, userId, role}`
- `client.route` `{path}`、`client.window` `{visible, focused, minimized, maximized}`
- `agent.lease` `{action: created|updated|released|expired, clientId, limits, fieldCaps, expiresAt}`：agent 租约变化，客户端据此显示/隐藏「AI 控制中 · 上限 X%」标记。

`GET /api/events/recent?limit=100&types=...` 返回事件数组（最新的在最后）。

## 客户端控制

- `GET /api/client/state` → `{available, version, window, route, locale}`；纯后端时 `available:false`（仍 200）。
- `POST /api/client/window {action}`，action = `show|hide|focus|minimize|maximize|restore`。
- `GET /api/client/routes` → `[{path,name,title,titleKey}]`（只列可主动打开的页面，不含运行态/配置/插件运行页）。
- `POST /api/client/navigate {path, show=true}`：只接受清单内路由（可带 query）；`/plays/game/current`、`/plays/game/runtime` 等内部页会被 400 `ROUTE_NOT_ALLOWED`。
- `POST /api/client/screenshot {format=png|jpeg, maxWidth=1280}` → `{mime, data(base64), width, height}`。隐藏窗口会先 `showInactive` 再截一次。
- `POST /api/client/games/:id/launch {deviceMap?, parameters?, show=true}`：先离开旧运行页并停当前玩法 → 走 `gameLaunchService.startGame`（与 `POST /api/games/:id/start` 同一实现）→ 前端跳到 `game_current`（iframe）或 `game_runtime`（HostRuntime）。返回 `{ok, gameId, mode, started, path, state}`。

没有 Electron host（`npm run dev:all` / 纯后端）时，所有控制类接口返回 `503 CLIENT_UNAVAILABLE`；`state` 返回 `available:false`。

远程主控模式：`backend/middleware/remoteSessionFilter.js` 的 `NEVER_LOCKED` 已显式放行 `/events` 与 `/client`（事件流只读；client 控制的是本机窗口/路由/截图/本机玩法载体）。

## 能力参数范围

`GET /api/device-capabilities` 的 `capabilityConfig.<cap>.actionParams.<action>.<field>` 形如：

```json
{ "type": "number", "min": 0, "max": 255, "default": 0 }
```

主要范围：`strength.set.value` 0–255；`shock.start.voltage` 0–100；`vibration/suction.set.value` 0–100；`estim.set.intensity` 0–255；`reporting.setReportDelay.ms` 0–99999；`distance.configure.{lowBand,highBand}` 0–999999、`reportDelayMs` 0–99999；`motors.set.channels` 为动态对象（值 0–255）；`pump.start.{rate,ss}` 0–255；`lock.setOpen.open` 布尔。

## agent 租约与输出限幅（A4）

插件在控制设备前先创建租约；之后所有设备写入和玩法启动都带请求头 `X-Agent-Client: <clientId>`。

### 租约接口

- `POST /api/agent-control/lease` `{clientId, ttlSec?, limits?}`：创建/续租（同一 clientId 覆盖 limits 与过期时间），`ttlSec` 5–600，缺省 30。
  - `limits`：`{ default: 0–100, capabilities: { strength, shock, vibration, suction, estim, motors, pump: 0–100 } }`；缺省能力沿用 `default`，缺省 `default` 按 0（fail-closed）。
  - 回包：`{ok, clientId, ttlSec, expiresAt, limits:{default, capabilities}, fieldCaps}`；`fieldCaps` 是换算后的逐字段上限。
- `DELETE /api/agent-control/lease/:clientId`：释放并立即停掉该 agent 发起的玩法，回 `{ok, clientId, released, stopped}`。
- `GET /api/agent-control/status`：`{active, leases:[{clientId, expiresAt, ttlRemainingSec, limits, fieldCaps}]}`（只读）。
- 租约与看门狗**相互独立**：插件分别续租；租约过期只停「该 agent 发起的玩法」，设备级停机由 `/api/device-watchdog/heartbeat` 负责。两者 TTL 建议同量级（30s）。
- `/api/agent-control` 只允许回环访问，且不受 `remoteSessionFilter` 锁定；带 `X-Agent-Client` 调租约接口不做租约校验（否则过期后无法续租）。

### 请求标记与 428

- 带 `X-Agent-Client` 的设备写请求（`/devices/*`、`/devices/batch/*`、`/games/:id/start`、`/games/stop-current`、`/game-runtime/{start,params,action,sensor,tick}`、`/client/games/:id/launch`、`/virtual-devices/*`、`/mqtt-client/*`）必须有有效租约，否则 `428 AGENT_LEASE_REQUIRED`。
- 停止类请求（路径/操作名含 stop，或报文是停止/归零指令）即使租约过期也放行；`/agent-control`、读接口、窗口/截图/导航不受租约约束。
- 有效租约把 clientId 放进 AsyncLocalStorage；带此头启动的玩法会在 session 上记 `agentClientId`，执行设备意图时用 `runWithClient` 重新包一层（不依赖定时器/事件回调里的上下文）。agent 用该头修改运行中玩法参数/动作时，该玩法也会被标记为 agent 控制（租约结束即停局）。

### 钳制位置与来源

- 最终汇聚点：`backend/services/deviceConnectionService.js` 的 `send()`（MQTT `/drecv`、串口、BLE、品牌、远程投影 adapter 下发之前）。
- 虚拟设备绕过 transport，在 `backend/services/virtualDeviceService.js` 的 `interceptCommand()` 做同一套限幅。
- 来源：请求头 → 中间件 AsyncLocalStorage；玩法 → `GameSession.agentClientId` / HostRuntime `session.agentClientId`（iframe 由启动令牌关联）。用户手动路径无来源，行为完全不变。

### 换算表

`capabilities.<cap>` 百分比 × 字段硬上限后 `floor`：

| 字段 | 能力 | 硬上限 |
|---|---|---|
| `voltage` | shock | 100 |
| `power` | strength | 255 |
| `intensity` | 保守取 shock/vibration/suction/estim 的最小百分比 | 100 |
| `motorLevel`（YCY 电机） | motors | 20 |
| `stroke`（杯行程） | motors | 40 |
| `rate` | pump | 255 |
| `ss` / 时长 | pump | 60s |
| `ticks`（DGLAB） | shock | 100（0.1s） |
| `pump`（YCY_ENEMA 属性） | pump | 255 |

- 品牌报文带能力语义（如 `dglab.setPattern` → shock、`ycy.setStrength` → shock、`sosexy.setVibration` → vibration），按对应能力取上限；原始属性报文拿不到语义时按上表保守取值。
- 超上限缩放到上限；输出字段必须是非负有限数字（`voltage:true`、字符串等直接 `400 AGENT_OUTPUT_REJECTED`）；不认识的设备类型/品牌/命令/字段/通道（如 `a.b`）一律拒绝；停止/归零永远放行。
- `pump` 省略 `ss` 时固件默认 60s，报文层会补 `ss = min(60, pump 上限)`。

### 客户端提示

租约有效时标题栏显示「AI 控制中 · 上限 X%」，悬停显示各能力上限；`agent.lease` 的 released/expired 到达后自动消失。实现：`frontend/src/composables/useAgentLease.ts` + `AppTitleBar.vue`。

## 测试

- 单测：`npm --prefix backend test -- --runInBand eventBus.test.js eventsRoutes.test.js clientRoutes.test.js deviceCapabilities.test.js remoteSessionFilter.test.js agentOutputGuard.test.js agentControlService.test.js agentControlRoutes.test.js agentOutputIntegration.test.js`
- agent 限幅实测：`tmp/agent-lease/live-test.js`（纯后端 5330 + 虚拟设备 TD01/DIANJI/CUNZHI01/YCY_ENEMA，结果 `tmp/agent-lease/live-test-result.json`）；客户端标记截图 `tmp/agent-lease/screenshot.js`（Electron 后端 5330 / 前端 5331 / CDP 9330，结果 `tmp/agent-lease/screenshot-result.json`）。
- 全量：`npm --prefix backend test -- --runInBand`；前端 `npm --prefix frontend test`；类型/构建 `npm --prefix frontend run build`。
- CDP 实测（隔离端口，别碰本机正式客户端）：Vite `5173→5311`、后端 `5278→5310`、CDP `9224→9324`，`CONTROL_PANEL_USER_DATA_DIR` 指到 `tmp/`。脚本 `tmp/agent-control-test/e2e.js` 覆盖 show/hide、navigate、截图、虚拟设备事件、iframe 游戏启动与截图、停止游戏、删除设备；截图在 `tmp/agent-control-test/`。

## 坑

1. **iframe 游戏启动后旧页面会反向停止**：`GameCurrentView`/`GameRuntimeView` 卸载时会 POST `/api/games/stop-current`。agent 从运行页直接 launch 新玩法时，`clientControlService.launchGame` 会先跳到 `/plays` 等旧页面卸载请求落地，再启动；否则刚启动的玩法会被立刻停掉。
2. **iframe 游戏的 gameId 只能由启动令牌反查**：`bridgeService.notifyCarrierStart/Exit` 用 `gameLaunchTokenService.resolve(session.gameToken)`；页面传来的 gameId 一律不信。
3. **`game.started` 来自 bridge init（iframe 真正连上），不是 `/api/games/:id/start` 返回时**；启动失败或页面没加载不会有该事件。
4. **截图首帧可能空白**：`readyState=complete` 早于绘制，CDP/截图前等约 1s；隐藏窗口截图为 0x0 时接口会自动 `showInactive` 重试一次。
5. **SSE `types` 是前缀匹配**（`game` 命中 `game.started`/`game.state`），不是精确等于。
6. **客户端窗口状态事件依赖主进程监听**：改 `electron/main.js` 后必须重启 Electron；前端路由上报依赖 preload 注入的 `window.clientApi`。
