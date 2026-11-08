# dsh agent 插件方案

决定见 `adr/2026-11-08-dsh-agent-plugin.md`。两部分并行：

- **A. 主仓（本仓 `feat/agent-control`）**：补通用接口——全局事件流、客户端控制通道、截图、完整启动游戏。不含任何 AI 业务逻辑。
- **B. 插件仓 `E:\smart\project\dsh-undersilicon`**：cordis 插件 `dsh-plugin-undersilicon`，包含 SDK、安全层、tools、脚本沙箱、侧栏面板。

## A. 主仓新增接口（契约，B 依此开发）

全部挂 `/api`，监听仍为 127.0.0.1，沿用「本机可信」不鉴权。远程主控模式下的放行/锁定需在 `remoteSessionFilter` 明确入表。

### A1 全局事件流

- `GET /api/events/stream?types=device,game,session,client`（SSE，逗号过滤前缀；省略=全部）。连上先发 `hello {seq, mode}`，之后每条 `data: {seq, type, ts, ...payload}`，带 `id: seq`，支持 `Last-Event-ID` 补发（环形缓冲 500 条）。每 15s 发注释心跳。
  - 实现补充：`hello` 是普通 data 帧 `{type:'hello', seq, mode}`（默认 `onmessage` 可收到，不再套 `event: hello`）；没有 `Last-Event-ID` 的新连接只收连上后的事件。
- `GET /api/events/recent?limit=100&types=...`：拉最近事件，返回事件数组（最新的在最后）。
- 事件类型：
  - `device.added` / `device.removed` / `device.connected` / `device.disconnected` `{deviceId, device}`
  - `device.updated {deviceId, changes, data}`：设备 data 变化，同设备节流 ≥200ms 合并
  - `game.started` / `game.stopped` / `game.state {gameId, ...}`：含 HostRuntime 与 iframe 游戏
  - `session.mode {mode: local|remote-operator|remote-controlled}`、`session.revoked`
  - `client.route {path}`、`client.window {visible, focused, minimized}`
- 实现：`backend/services/eventBus.js`（EventEmitter + seq + 环形缓冲），在 deviceService / 游戏 / 远程会话 / 客户端控制处发布。

### A2 客户端控制（后端 → Electron 主进程 → 前端）

后端与 Electron 主进程同进程：`backend/services/clientControlService.js` 暴露 `registerHost(handler)`，主进程启动时注册；未注册（`dev:all`/纯后端）时接口返回 `503 CLIENT_UNAVAILABLE`。

- `GET /api/client/state` → `{available, version, window:{visible,focused,minimized,maximized}, route}`（另附 `locale`；纯后端时 200 + `available:false`）
- `POST /api/client/window {action: show|hide|focus|minimize|maximize|restore}` → state
- `GET /api/client/routes` → `[{path, name, title, titleKey}]`（前端 router 整理出的可导航页面清单，过滤掉运行态/配置/插件运行页；实现在 `backend/constants/clientRoutes.js`）
- `POST /api/client/navigate {path, show=true}` → state；只接受清单内路由（带 query 可）
- `POST /api/client/screenshot {format=png|jpeg, maxWidth=1280}` → `{mime, data(base64), width, height}`（隐藏窗口自动 `showInactive` 重试一次）
- `POST /api/client/games/:id/launch {deviceMap?, parameters?, show=true}`：按界面同等流程启动游戏（iframe 游戏会由前端加载页面），返回 `{ok, gameId, mode, started, path, state}`；先停当前玩法（单一玩法载体）。若当前停在旧玩法运行页，会先跳到 `/plays` 等旧页面的卸载 stop-current 落地再启动。
  - `game.started` 事件在 iframe 真正连上 bridge / HostRuntime 启动时发出，不是 `/api/games/:id/start` 返回时。
- 前端通过 IPC 上报当前路由（`client:route-changed`），主进程接收 `navigate` 指令时复用现有 `game-host:navigate` 通道或新增 `client:navigate`。

### A3 其他

- 设备能力描述：`GET /api/device-capabilities` 的 `capabilityConfig.<cap>.actionParams.<action>.<field>` 给出机器可读参数范围（`{type,min,max,default}`，布尔/字符串/动态对象也标注）；B 用它按百分比缩放阈值。
- 测试：jest 覆盖 eventBus、SSE 补发、client 路由 503 与正常分支；Electron 侧用 CDP 实测导航/截图。

## B. 插件 `dsh-plugin-undersilicon`

ESM cordis 插件，目标 dsh 桌面版 0.2.x。分层：`sdk/`（HTTP + SSE + 模式识别 + 看门狗）→ `safety/`（缩放、审计、急停）→ `tools/` + `scripts/`（沙箱）→ `client/`（侧栏面板）。

### 安全层（所有控制入口必经，tools、脚本、原始请求都一样）

- **阈值缩放**：配置 `limits.default`（默认 60%）与 `limits.capabilities.<cap>`（百分比），按设备能力取值范围算上限；超出则缩放到上限并在结果里返回 `clamped: [{field, requested, applied}]`，不超出直接放行。
- **看门狗**：本机模式下只要 agent 控制过设备就续租 `/api/device-watchdog/heartbeat`（clientId `dsh-<会话>`，TTL 30s）。dsh 崩溃则后端自动停机。远程主控模式下该接口 423，改用远程会话自身保护。
- **急停**：本机 `stop-all` + `games/stop-current`；远程主控模式 `remote-session/emergency-stop`；同时停掉所有脚本。永远可用、免确认。
- **会话结束**：配置 `stopOnSessionEnd`（默认 true）决定会话结束时是否停止所有设备；会话结束总会停掉该会话的脚本和订阅。
- **审计**：JSONL 记录每条控制指令（时间、会话、来源 tool/脚本、请求、缩放、结果），位置 `~/.dsh/undersilicon/audit-YYYY-MM-DD.jsonl`。
- 原始请求通道拦截绕过安全层的接口：`/devices/:id/message`、`/mqtt-client`、`/devices/batch` 拒绝；能力/预置操作路径走缩放。

### Tools（agent 可见）

| tool | 作用 |
|---|---|
| `panel_status` | 一次看全局：连接、模式、客户端窗口/页面、设备摘要、当前游戏、阈值、运行中脚本与订阅 |
| `device_list` / `device_get` | 设备状态；`device_get` 含能力、参数范围、当前阈值、最近监控数据 |
| `device_control` | 能力动作 `{deviceId, capability, action, input}` 或预置操作 `{deviceId, operation, params}` |
| `device_manage` | 蓝牙扫描/连接/断开、改昵称等设备管理 |
| `emergency_stop` | 急停 |
| `game_list` / `game_status` / `game_start` / `game_control` | 游戏列表、状态、完整启动（含 iframe）、停止/暂停/继续/改参数/动作 |
| `client_control` | 窗口显隐/聚焦/最小化、页面跳转（附路由清单） |
| `client_screenshot` | 客户端截图（模型支持图像则直接给图） |
| `script_run` / `script_list` / `script_stop` / `script_logs` | 脚本沙箱 |
| `events_subscribe` / `events_unsubscribe` / `events_recent` | 免代码订阅事件：类型、设备、过滤条件、节流；`mode: inject`（下次回复带上）或 `wake`（唤醒 agent） |
| `panel_api` | 兜底：调任意本机接口（受安全层拦截） |

### 脚本沙箱

agent 写 JS，插件用 `worker_threads` + `vm` 隔离执行，上下文只有 `us`、`console`、定时器与标准内建，没有 `require`/`process`/文件/网络。`us.*` 全部 RPC 回插件主线程，经过安全层与审计。

```js
const devs = await us.devices();
await us.control(id, 'strength', 'set', { value: 120 });   // 自动缩放
us.on('device.updated', (e) => { if (e.data.heart_rate > 150) us.control(id, 'strength', 'set', {value: 0}); }, { deviceId: hr });
us.every(2000, async () => { ... });
us.notify('心率超过 150，已降强度', { wake: true });       // 通知/唤醒 agent
us.state.count = (us.state.count || 0) + 1;                 // 脚本内持久状态
await us.sleep(500); await us.stopAll(); us.stop();
// 另有 us.device / us.operate / us.game.* / us.client.* / us.api / us.log
```

- 顶层跑完且没注册事件/定时器即结束，否则常驻直到 `us.stop()`、`script_stop`、会话结束或急停。
- 限制：并发 8 个、单 worker 内存 64MB、同步代码卡死超 5s 强杀；日志环形 500 行。
- `persist: true` 的脚本存盘，dsh 重启后自动恢复（设置里可关）。

### 侧栏面板与设置

- 右侧栏「硅基之下」页签：连接/模式指示、设备卡片（实时数值）、运行中脚本与订阅（可停）、最近审计、醒目急停按钮。中英双语。
- 设置卡（cordis config schema）：`baseUrl`、`limits`、`stopOnSessionEnd`、`watchdogTtlSec`、`scripts.maxConcurrent`、`scripts.allowPersist`。
- 附带 skill/提示，说明设备能力用法、阈值缩放语义与脚本 API。

## 测试与验收

1. A：jest + CDP 实测导航、截图、iframe 游戏启动、事件流。
2. B：node:test 单测（缩放、拦截、沙箱隔离、RPC、看门狗）+ 对接 A 的真实后端（虚拟设备）集成测试。
3. 端到端：桌面版运行时 CLI 建独立 profile `us-test` 装插件（不动用户 desktop profile），`dsh web` 起服务，让模型真实调 tool 完成：查设备、调强度（含超阈值缩放）、写心率订阅脚本、跳页面、截图、急停。产出带截图的测试报告。
