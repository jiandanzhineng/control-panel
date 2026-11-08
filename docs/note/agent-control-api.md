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

## 测试

- 单测：`npm --prefix backend test -- --runInBand eventBus.test.js eventsRoutes.test.js clientRoutes.test.js deviceCapabilities.test.js remoteSessionFilter.test.js`
- 全量：`npm --prefix backend test -- --runInBand`；前端 `npm --prefix frontend test`；类型/构建 `npm --prefix frontend run build`。
- CDP 实测（隔离端口，别碰本机正式客户端）：Vite `5173→5311`、后端 `5278→5310`、CDP `9224→9324`，`CONTROL_PANEL_USER_DATA_DIR` 指到 `tmp/`。脚本 `tmp/agent-control-test/e2e.js` 覆盖 show/hide、navigate、截图、虚拟设备事件、iframe 游戏启动与截图、停止游戏、删除设备；截图在 `tmp/agent-control-test/`。

## 坑

1. **iframe 游戏启动后旧页面会反向停止**：`GameCurrentView`/`GameRuntimeView` 卸载时会 POST `/api/games/stop-current`。agent 从运行页直接 launch 新玩法时，`clientControlService.launchGame` 会先跳到 `/plays` 等旧页面卸载请求落地，再启动；否则刚启动的玩法会被立刻停掉。
2. **iframe 游戏的 gameId 只能由启动令牌反查**：`bridgeService.notifyCarrierStart/Exit` 用 `gameLaunchTokenService.resolve(session.gameToken)`；页面传来的 gameId 一律不信。
3. **`game.started` 来自 bridge init（iframe 真正连上），不是 `/api/games/:id/start` 返回时**；启动失败或页面没加载不会有该事件。
4. **截图首帧可能空白**：`readyState=complete` 早于绘制，CDP/截图前等约 1s；隐藏窗口截图为 0x0 时接口会自动 `showInactive` 重试一次。
5. **SSE `types` 是前缀匹配**（`game` 命中 `game.started`/`game.state`），不是精确等于。
6. **客户端窗口状态事件依赖主进程监听**：改 `electron/main.js` 后必须重启 Electron；前端路由上报依赖 preload 注入的 `window.clientApi`。
