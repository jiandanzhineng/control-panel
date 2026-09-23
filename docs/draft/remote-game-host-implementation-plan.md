# PC 端远程游戏与逻辑分离改动方案

> 2026-09-23 跨端补充：手机和 PC 都要能作为执行端或控制端，设备管理属于远控范围。PC 已有实现的核对基线为 `7ec92bb`；本文不是验收报告。跨端实施请同时读取下列完整方案，其 v2 契约、授权、设备控制和后台生命周期细则替代本文早期简化约定。
>
> [移动端与 PC 双向远控、JS 游戏运行层实施方案](../../../control_panel_mobile/docs/plans/2026-09-23-mobile-pc-remote-game-runtime.md)

跨端必须补齐：发送者 MQTT topic 与真实 ACL 验证、业务 v2 协商及 session/grant/revision、幂等命令结果、设备管理白名单、共享配置草稿、可移植 JS bundle 与同版本视图、异步设备停止屏障。旧设备投影保留原行为。普通远控断线/撤权不停止本地游戏，显式停止游戏才结束本局。移动端详细方案第 11 节列出 PC 配套清单。

## 1. 目标与边界

本轮只改 `control-panel` PC 端，先把游戏逻辑从 WebView/iframe 中移出，并完成 A/B 两端远程控制。

- A 是唯一游戏运行端：状态机、时钟、随机数、设备动作全部在 A 的后端 HostRuntime 执行。
- B 是远程客户端：使用同一套游戏设置与运行 UI，订阅 A 的快照和日志，发送受白名单限制的操作。
- A 可授权或撤销客户端级远控。未授权时 B 只能看到房间状态，不能浏览运行控制或发游戏指令。
- 支持完整参数修改、开始、暂停、继续、停止、游戏内动作。停止即结束当前游戏并复位设备。
- B 断线、刷新或关闭页面不影响 A 的游戏。A 端退出游戏、替换游戏、后端关闭仍必须复位设备。
- PC 已迁移 `surge-edging`（气压突变寸止），可用于移动端引擎对接；用户所说的三阶段寸止实际为 `pressure-edging-v2`，也必须迁移并独立验收。其它游戏保留 iframe 兼容模式，逐个迁移。
- 不修改现有 `remoteProjectionService` 的离线安全停止语义；游戏远控使用独立服务和独立房间类型。

本轮不承诺手机锁屏后台能力。PC HostRuntime 的时钟与生命周期接口要能被移动端复用，但移动端前台服务另行实现和验证。

## 2. 现状约束（实施前必须读取）

- `docs/adr/0004-single-active-play-carrier.md`：全局同一时刻只允许一个玩法，切换和退出必须按能力复位设备。
- `docs/adr/0005-backend-authoritative-play-state.md`：旧 bridge 玩法仍遵守连接生命周期及重连宽限。用户的新要求将 host 模式权威迁至独立运行会话，需与 legacy bridge/插件共享单玩法仲裁，不能存在两个活跃写设备会话。
- `docs/draft/ADR-2026-09-23-remote-game-host-authority.md`：A 执行唯一逻辑，B 只渲染和操纵，B 断线不停止 A。
- `docs/draft/js-game-core-outside-webview.md`：游戏逻辑继续用 JS，但 Core 不得依赖 DOM、Canvas、Audio、WebSocket、MQTT、`window` 或浏览器定时器。

## 3. 目标模块结构

建议新增以下模块；模块名可调整，但职责必须保持独立：

```text
backend/game-runtime/
  gameCoreRuntime.js       # 事件队列、tick、快照
  gameHostService.js       # 单活跃会话、生命周期、权限、设备 effects
  cores/surge-edging-core.js
backend/services/remoteGameService.js  # 游戏房间 MQTT，会话授权和命令转发
backend/routes/gameRuntime.js
backend/routes/remoteGame.js
frontend/src/api/gameRuntime.ts
frontend/src/api/remoteGame.ts
frontend/src/components/GameRuntimeView.vue  # 快照渲染器/控制器
```

`remoteProjectionService`、`bridgeService` 和已有设备 API 继续保留。游戏 HostRuntime 可以复用 `deviceService` 的能力调用和设备监听，但不能把远程游戏命令直接转成任意 MQTT/HTTP/IPC。

## 4. JS Core 契约

以 `surge-edging` 为第一个纯 JS Core。Core 只接收输入并返回数据，不执行副作用。

```js
const core = new SurgeEdgingCore({ params, random });
core.start(nowMs);
const result = core.step({
  nowMs,
  events: [{ type: 'sensor', name: 'sphincterPressure', value: 12.4 }],
});
// result = { snapshot, effects, logs, nextWakeAtMs }
```

必须提供：

- `start(nowMs)`、`pause(nowMs)`、`resume(nowMs)`、`stop(nowMs, reason)`。
- `setParams(params)`：只接受对象，按 manifest 的 min/max/default 做归一化；不允许写入任意运行时字段。
- `action(name, payload, nowMs)`：至少支持 `start`、`pause`、`resume`、`stop`、`forceEdge`/同等游戏内操作。
- `step({ nowMs, events })`：时间只能由宿主传入；不能调用 `Date.now()`、`setTimeout()` 或 `setInterval()` 驱动逻辑。
- `snapshot()`：只返回可序列化数据，不能包含函数、DOM 对象、定时器或原始采样历史大数组。

状态至少包含：运行状态、暂停状态、当前阶段、开始/结束时间、当前/平均压力、中间压力、当前/目标强度、边缘次数、电击次数、累计刺激时间、当前参数和版本。

效果只允许声明意图，例如：

```js
{ type: 'device.set-strength', role: 'motor', value: 20 }
{ type: 'device.stop-strength', role: 'motor' }
{ type: 'device.shock', role: 'punish', voltage: 20, durationMs: 3000 }
{ type: 'device.stop-all' }
```

Core 不得直接调用 `DeviceAPI`、`bridge`、MQTT 或网络。

## 5. PC HostRuntime

`gameHostService` 维护唯一活跃会话，建议 API：

```js
start({ gameId, deviceMap, params, source })
pause()
resume()
stop({ reason })
setParams(params)
action(action, payload)
pushSensor({ role, name, value })
tick(nowMs)
getStatus()
subscribe(listener)
shutdown()
```

具体要求：

1. 全局同一时刻只有一个 HostRuntime 会话。启动新游戏前先停止旧会话并复位旧映射。
2. `start` 返回 `sessionId`、`gameId`、`deviceMap`、`snapshot` 和 `runtimeMode: "host"`。
3. HostRuntime 以 50–100ms 宿主 tick 驱动 Core；tick 定时器只在 PC 宿主，Core 不拥有定时器。
4. 监听 `deviceService.onDeviceDataChange`，只把当前 `deviceMap.sensor` 中设备的压力字段转换成 Core 事件。
5. effects 进入单独的安全执行层：校验设备存在、设备能力、role 映射和数值边界后，才调用 `deviceService.invokeDeviceCapability`；虚拟设备走现有虚拟设备拦截接口。
6. `shock` 必须由 HostRuntime 管理自动停止计时器；Core 只声明电击持续时间。
7. `stop`、游戏自然结束、替换游戏、后端关闭都执行所有映射设备的能力级安全复位，并释放 reporting。等待异步 stop 屏障后才能启动新游戏；旧 effects/电击定时器不得越过会话代次。暂停与最终复位分别处理，尤其不能在暂停时无意调用会开锁的 lock.stop。
8. WebView/iframe 销毁不能直接认为游戏停止。显式调用 `/api/game-runtime/stop` 才是正常停止；异常退出由 HostRuntime/后端关闭兜底复位。

## 6. PC API

新增 `/api/game-runtime`：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/status` | 返回当前 HostRuntime 快照 |
| POST | `/start` | 启动 `{ gameId, deviceMap, params, source }` |
| POST | `/params` | 修改全部允许参数 `{ params }` |
| POST | `/action` | 执行 `{ action, payload }` |
| POST | `/sensor` | 仅 debug/mock 本地测试注入，生产与远程均不开放 |
| POST | `/tick` | 仅 debug/mock 本地测试推进，生产与远程均不开放 |
| POST | `/stop` | 停止并复位设备 |

保留 `/api/games/:id/start` 和 `/api/games/stop-current` 兼容入口：

- 已接入 Core 的游戏转给 HostRuntime，并返回 `runtime.mode = "host"`。
- 未接入 Core 的游戏返回 `runtime.mode = "iframe"`，继续使用旧页面流程。
- `/api/games/stop-current` 必须同时停止 HostRuntime 和旧 bridge session。
- `/api/games/status` 返回 HostRuntime 状态，不能再永远返回 `running: false`。

## 7. 游戏页面改造

`PlayConfigView` 启动游戏时要先调用 `/api/games/:id/start`，根据返回的 runtime 模式进入运行页：

- `host`：进入 `GameRuntimeView`，不加载原 `game.js` iframe。
- `iframe`：沿用当前 `GameCurrentView`。

`GameRuntimeView` 与原游戏 UI 保持同一信息结构：阶段、压力、强度、目标强度、边缘次数、电击次数、日志、参数面板和开始/暂停/继续/停止按钮。所有显示值来自 `/api/game-runtime/status` 的快照；按钮只发送 HostRuntime 操作。

本地 A 端和远程 B 端使用同一组件与同一快照类型。组件需要处理：

- 页面刷新：重新拉取 `/status`，恢复当前快照。
- 短时网络失败：显示重连状态，不能调用 stop。
- 收到 `ENDED` 或 `/stop` 成功：清理 active play 并返回玩法库。
- 全部参数可编辑；参数提交成功后展示 HostRuntime 返回的归一化值。

## 8. 客户端级远控协议

新增独立 `remoteGameService`，使用现有房间 API 和 MQTT 凭据，但房间创建必须使用独立 `gameId = "remote-game"`、容量首版为 2。不能复用远程设备投影的“所有 operator 离线即安全停止”逻辑。

### 8.1 房间角色

- A 创建房间并连接 MQTT，默认 `authorized = false`。
- A 调用授权接口后变为 `authorized = true`，B 才能执行游戏命令。
- A 可随时撤销授权；撤销后 B 的命令统一返回 `CONTROL_NOT_AUTHORIZED`。
- B 离线、刷新、退出房间只清理 B 自己的 MQTT 客户端，不调用 HostRuntime.stop。
- A 主动停止游戏时调用 HostRuntime.stop；A 关闭远程房间只撤销远控，本地游戏继续。结束游戏、设备断线和宿主异常有各自安全停止路径。

### 8.2 MQTT topic

```text
rooms/{roomId}/commands/{senderUserId}
rooms/{roomId}/events
rooms/{roomId}/presence/{userId}
```

使用与远程设备投影相同的 envelope 字段：`protocolVersion`、`roomSessionId`、`messageId`、`type`、`senderConnectionEpoch`、`sequence`、`timestamp`、`payload`。两端都必须按 `messageId` 去重，限制缓存上限。

B 发布 commands 时 senderUserId 必须来自自己的 MQTT credential.userId，A 订阅 commands/+；服务端 ACL 不允许 B 发布到 A 的 userId topic。跨端 v2 继续用外层 protocolVersion=1，另行协商 controlProtocolVersion=2；重复请求须返回缓存的业务响应，不能只丢包。

### 8.3 命令白名单

B → A 只允许：

- `client.snapshot.request`
- `game.start`（含 `gameId`、`deviceMap`、`params`）
- `game.setParams`
- `game.pause`
- `game.resume`
- `game.stop`
- `game.action`

跨端 v2 另外包含 `client.hello`、`client.workspace.set`、`games.list`、`game.meta`、`game.config.get/set`，以及 `devices.list/scan.start/scan.stop/connect/disconnect/rename/controlConnection.set/invoke/stop`。参数 schema、授权和占用规则以移动端详细方案第 8 节为准；这些不是任意设备原始指令。

A → B 至少发送：

- `client.snapshot`：授权状态、可用游戏列表、当前游戏快照。
- `client.authorization`：授权/撤销结果。
- `game.snapshot`：完整可渲染快照。
- `game.log`：结构化日志。
- `client.response`：命令成功或失败，带 `requestId`、错误码和消息。
- `session.revoked` 或等价事件：房间失效时让 B 回到未连接状态。

禁止开放任意 HTTP、Electron IPC、脚本执行、任意 MQTT topic、任意设备原始指令。

### 8.4 远程 API

新增 `/api/remote-game`：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/status` | 当前 A/B 房间状态和最近快照 |
| POST | `/create` | A 创建容量为 2 的游戏房间 |
| POST | `/join` | B 用房间码加入 |
| POST | `/authorize` | A 授权 B 控制 |
| POST | `/revoke` | A 撤销 B 控制 |
| POST | `/command` | B 发送白名单命令 |
| POST | `/stop` | 离开/关闭远控房间 |

## 9. 远程 UI

在现有设备管理的远程连接区域新增“远程游戏”模式，或单独增加同级卡片，但不改变设备远控现有流程：

- A：创建房间、显示房间码、授权/撤销、显示 B 在线状态、显示当前游戏快照。
- B：输入房间码、等待 A 授权；授权后显示游戏列表、设置页、参数编辑和运行控制。
- 游戏设置页复用 `PlayConfigView` 的 manifest 参数渲染器，提交时走 `game.setParams` 或 `game.start`。
- A/B 的运行页复用 `GameRuntimeView`，B 的数据源改成 MQTT 推送快照。
- 远程 UI 包含设备管理，复用已有扫描/连接/能力控制流程；由 A 验证设备能力和游戏占用，不开放原始报文。运行中的游戏设备不接受并发非零手动控制，停止/断开先走安全处理。

## 10. 测试方案

### 10.1 Core 单测

至少覆盖：

1. 默认参数和 min/max 归一化。
2. `start → pause → resume → stop` 生命周期。
3. 暂停期间推进时间不改变阶段、计时和强度。
4. 传感器双窗口突变进入边缘期，产生停止强度和电击 effect。
5. 边缘期超时进入冷却，冷却结束进入平静期。
6. 游戏时长到期自动结束并产生 stop-all。
7. 重复 start、未知 action、非法 params 返回稳定错误。
8. 注入固定 `nowMs` 和 `random` 时结果完全确定；测试中不得依赖真实时间。

### 10.2 HostRuntime 单测

使用 mock `deviceService`、mock `deviceRegistry` 和 fake timers：

1. 同时只能存在一个活跃会话，启动新游戏会停止旧游戏并复位旧设备。
2. 参数修改只影响当前会话，非法设备映射不能执行能力调用。
3. effect 能按 role 映射到正确设备；不支持能力的设备被跳过并记录错误。
4. shock 自动停止；停止、暂停、自然结束都让设备回到零/停止。
5. `deviceService.onDeviceDataChange` 只接收 sensor 映射设备事件。
6. WebView/订阅者断开不会触发 stop；HostRuntime 仍可继续 tick。
7. 重新订阅后可以拿到完整 snapshot。

### 10.3 远程协议单测

使用 fake MQTT client、fake room API 和 mock HostRuntime：

1. A 创建房间使用 `remote-game`、容量 2；B 加入后能收到 snapshot。
2. 未授权 B 的所有 game 命令都返回 `CONTROL_NOT_AUTHORIZED`。
3. 授权后 B 可开始、修改参数、暂停、继续、停止和执行白名单 action。
4. 重复 `messageId` 不重复执行；过期/错误 session 被忽略。
5. B MQTT close 不调用 HostRuntime.stop，A 仍可继续运行。
6. A 撤销授权后，B 收到授权状态并不能继续控制。
7. 房间关闭或 host 失效后，B 收到 `session.revoked` 并清理远程设备状态。
8. 旧 `remoteProjectionService` 测试全部继续通过，尤其是 operator 全部离线后的安全停止。

### 10.4 页面与构建

```powershell
npm --prefix backend test -- --runInBand
npm --prefix frontend test
npm run build:frontend
npm run check
```

如增加前端测试，至少覆盖：host 模式不创建 iframe、快照刷新恢复、B 未授权时控制按钮禁用、网络短暂失败不触发停止。

## 11. 实施顺序

1. 先实现 Core 和单测，不改页面。
2. 实现 HostRuntime、设备 effect 安全层和生命周期单测。
3. 接入 `/api/game-runtime`，把 `/api/games/:id/start` 对 `surge-edging` 切到 host 模式。
4. 新增 `GameRuntimeView`，改 `PlayConfigView` 根据返回值选择 host/iframe。
5. 实现 `remoteGameService`、房间 API、远程路由和协议单测。
6. 接入远程游戏 UI，复用本地设置和运行组件。
7. 游戏修改后在现有版本基础上递增版本号（PC 当前 surge-edging 已为 1.2.0，不回退覆盖），同步 PC/手机 manifest、Core、视图与包 hash。
8. 更新 `docs/note.md`，记录测试命令、fake 设备验证范围和未做真实设备验证的边界。
9. 跑全量测试、前端构建，检查旧远程投影回归。
10. 删除临时文件或加入 `.gitignore`，提交一个功能 commit；提交说明应包含 host runtime、远程游戏协议和测试结果。

## 12. 验收标准

- A 启动 `surge-edging` 后，浏览器关闭/刷新，后端游戏仍继续，重新打开运行页能恢复 snapshot。
- B 加入但未获授权时只能看到等待授权状态；授权后可修改全部参数、启动新游戏、暂停、继续、停止。
- B 断线后 A 不停止；A 的 HostRuntime 继续推进逻辑并控制设备。
- 任意停止路径都能看到设备 mock 收到能力级 stop；不能只依赖页面卸载。
- A/B 显示相同 snapshot 字段和阶段文字，B 不加载、不执行游戏 Core。
- 现有本地 iframe 游戏仍能启动；现有远程设备投影行为和测试不变。
- 自动化测试和前端生产构建全部通过；报告中明确 PC mock 验证与真实设备验证的区别。
